/**
 * 事件驱动的 Agentic 对话循环
 *
 * Phase 2 实现多轮 tool-call/tool-result 循环：
 * - Standalone / 本地模型模式下，前端本地执行工具并将结果回传模型继续推理；
 * - MESCLI 模式下保持原有单轮展示行为，由后端 SSE 驱动工具执行。
 *
 * 每轮模型调用产生一个独立的 assistant 消息（对齐 Claude Code），避免跨轮 tool_calls 串扰。
 */

import type { StreamChunk, ProviderConfig, Message, WorkspaceFileMetadata } from '@/types/mescli'
import type { ChatMessage, RenderNode } from '@/types/chat'
import type { ExecutionMode, ToolCall as AgentToolCall, ToolResult, ApprovalRequest, ToolPermissionContext } from './types'
import type { TraceCollector } from './traceCollector'
import type { FrontendToolRegistry } from './toolRegistry'
import type { ToolExecutor } from './toolExecutor'
import { createChildAbortController } from './toolExecutor'
import type { AssembleContextResult, AssembleContextOptions } from './contextAssembler'
import type { ApprovalGate } from './approvalGate'
import { createApprovalGate } from './approvalGate'
import { chatApi, toolApi, IS_STANDALONE } from '@/api/client'
import { useLocalModelStore } from '@/stores/localModelStore'
import { getRuntimeMode, isLocalRuntime } from '@/utils/runtimeMode'
import { assembleRequestMessages } from './contextAssembler'
import { safeStringify } from '@/utils/safeSerialize'
import {
  createToolCallNormalizerState,
  getNormalizedToolCalls,
  mergeToolArguments,
  parseToolArguments,
  resetToolCallNormalizer,
  type ToolCallNormalizerState,
} from './toolCallNormalizer'
import { createModelClient, isAnthropicCompatibleProvider, modelClientSupportsTools, providerSupportsDeferredLoading } from './modelClient'
import type { ModelClient, ModelClientRequest } from './modelClient'
import { createBackendProxyModelClient } from './modelClient/backendProxyModelClient'
import { ensureToolResultPairing } from './modelClient/messageNormalizer'
import { createRenderNodeBuilder, legacyToRenderNodes, type RenderNodeBuilder } from './renderNodeBuilder'
import { createProjectedBuilder, type ProjectedBuilder, eventFactory } from './renderKernel'
import { RenderScheduler } from './renderKernel/renderScheduler'
// import { classifyArtifact } from './renderKernel/artifactClassifier' // v4.0: 暂停自动产物分类

/** Phase 1 feature flag：事件驱动 builder（EventLog + TurnProjector）。false 回退到旧 builder。 */
const USE_PROJECTED_BUILDER = true
import { runPipeline, createPipelineTransport } from './pipelineRunner'
import { compactSummaryPipeline, buildCompactContinuationContent } from './pipelines/compactSummary'
import { isSqlWriteOperation } from './pipelines/approvalExplain/sqlClassifier'
import { estimateContextTokens } from '@/utils/tokenEstimator'
import {
  resolveContextWindow,
  recordLearnedUpperBound,
  recordObservedLowerBound,
  recordLearnedMaxOutput,
  resolveMaxOutputTokens,
  parseContextLimitFromError,
  parseMaxOutputLimitFromError,
} from '@/services/modelCapabilityRegistry'
import { classifyModelError } from './modelClient/modelErrors'
import {
  TOOL_SEARCH_TOOL_NAME,
  formatToolSearchResult,
  extractDiscoveredToolNames,
} from './tools/toolSearchTool'
import {
  LIST_CAPABILITIES_TOOL_NAME,
  READ_CAPABILITY_TOOL_NAME,
  formatListCapabilitiesResult,
  formatReadCapabilityResult,
  extractDiscoveredNameFromReadCapability,
} from './tools/capabilityDiscoveryTools'
import { WEBBRIDGE_EXECUTE_TOOL_NAME } from './tools'
import { extractWebBridgeWorkflowSafe, sanitizeControlCharacters } from '@/utils/webbridgePrompt'
import { useWorkspaceFileStore } from '@/stores/workspaceFileStore'
import { getSessionGrants } from './sessionGrants'

/**
 * 事件驱动的 Agentic 对话循环
 *
 * Phase 2 实现多轮 tool-call/tool-result 循环：
 * - Standalone / 本地模型模式下，前端本地执行工具并将结果回传模型继续推理；
 * - MESCLI 模式下保持原有单轮展示行为，由后端 SSE 驱动工具执行。
 *
 * 每轮模型调用产生一个独立的 assistant 消息（对齐 Claude Code），避免跨轮 tool_calls 串扰。
 */

export interface AgenticLoopCallbacks {
  /** 上下文装配完成（可选，用于 chatStore 更新 token 计数） */
  onContextAssembled?: (result: AssembleContextResult) => void
  /** 助手占位消息首次创建 */
  onAssistantCreated: (assistant: ChatMessage) => void
  /** 助手消息字段更新（content/status/reasoning/toolCalls 等） */
  onAssistantUpdate: (assistant: ChatMessage) => void
  /** 每个原始 SSE chunk 到达（用于外部 trace/日志） */
  onChunk?: (chunk: StreamChunk) => void
  /** 新的 tool 占位消息插入 */
  onToolStart: (toolMsg: ChatMessage) => void
  /** tool 消息状态/内容更新 */
  onToolUpdate: (toolCallId: string, update: Partial<ChatMessage>) => void
  /** tool 标准输出日志更新 */
  onToolStdout?: (toolCallId: string, log: string) => void
  /** M3 审批请求到达（Phase 2 仅 plumbing） */
  onApprovalRequested?: (request: ApprovalRequest, resolve: (approved: boolean, reason?: string) => void) => void
  /** tool_search 发现新工具时通知上层持久化 */
  onToolsDiscovered?: (names: string[]) => void
  /** 自动压缩开始（可选，UI 提示"正在压缩"） */
  onCompactStart?: (segmentCount: number) => void
  /** 自动压缩完成（boundary 轻标记：已压缩段消息数 / 保留段消息数） */
  onCompacted?: (info: { summarizedCount: number; keptCount: number; summary: string }) => void
  /** v9 双轨：补充在步骤间隙真正注入模型上下文后回调（上屏+持久化时机） */
  onSupplementInjected?: (text: string) => void
  /** 400 下行校准学到真实窗口（打磨任务7）：UI toast + store 刷新窗口值 */
  onWindowLearned?: (info: {
    learnedWindow: number
    userOverrideFalsified: boolean
    fromErrorMessage: boolean
  }) => void
  /** 发生错误 */
  onError: (error: Error) => void
  /** 单轮/多轮循环结束（assistant 已最终化） */
  onDone: (assistant: ChatMessage) => void
}

export interface AgenticLoopOptions {
  userMessage: ChatMessage
  provider: ProviderConfig
  apiKey?: string
  baseUrl?: string
  executionMode?: ExecutionMode
  conversationId?: number
  systemCode?: string
  /** 已装配好的请求消息；优先级高于 assembleOptions */
  requestMessages?: Message[]
  /** 若未提供 requestMessages，loop 内部调用 contextAssembler */
  assembleOptions?: Omit<AssembleContextOptions, 'userMessage'>
  traceCollector: TraceCollector
  toolRegistry: FrontendToolRegistry
  toolExecutor: ToolExecutor
  callbacks: AgenticLoopCallbacks
  /** 最大循环轮数（默认 5） */
  maxTurns?: number
  /** 是否启用前端本地多轮工具循环（Standalone / MESCLI-Local / MESCLI-Online + frontend_loop_online） */
  enableFrontendToolLoop?: boolean
  /** 本会话已发现的延迟加载工具名（页面刷新后恢复） */
  initialDiscoveredToolNames?: Set<string>
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function createAssistantMessage(executionMode: ExecutionMode): ChatMessage {
  return {
    id: generateId(),
    role: 'assistant',
    content: '',
    isStreaming: true,
    status: 'thinking',
    timestamp: Date.now(),
    executionMode,
  }
}

function isLocalModelProvider(provider: string): boolean {
  return provider === 'ollama' || provider === 'lmstudio' || provider === 'webllm'
}

function buildPermissionContext(
  mode: ExecutionMode,
  conversationId?: number | null
): ToolPermissionContext {
  return {
    mode,
    canBypass: false,
    // S4 D3：会话级授权记忆（如 /project 首次写入确认后授予 project-write）
    grantedPermissions: getSessionGrants(conversationId),
  }
}

function buildToolDefinitionsOptions(
  registry: FrontendToolRegistry,
  discoveredToolNames: Set<string>,
  providerConfig: ProviderConfig
) {
  const supportsDeferredLoading = providerSupportsDeferredLoading(
    providerConfig.provider,
    providerConfig.model
  )
  return {
    discoveredToolNames,
    supportsDeferredLoading,
  }
}

const DEFAULT_MAX_TURNS = 100

export interface AgenticLoopHandle {
  /** 中止整个对话循环 */
  abort: () => void
  /** 取消单个正在执行的工具调用 */
  cancelTool: (toolCallId: string) => void
  /** 过程中补充：在下一个步骤间隙注入用户消息到模型上下文（§7 SupplementGateway） */
  supplement: (text: string) => void
  /** 撤回尚未注入的补充（v9 双轨：注入前可取消）。返回 true=已从队列移除；false=已被取走/不存在 */
  unsupplement: (text: string) => boolean
  /** 解决 attention（审批/澄清）：关闭脊柱卡片并可选注入选择值到上下文 */
  resolveAttention: (nodeId: string, resolved: boolean, value?: string) => void
}

export function startAgenticLoop(options: AgenticLoopOptions): AgenticLoopHandle {
  const {
    userMessage,
    provider,
    apiKey,
    baseUrl,
    executionMode = 'auto',
    conversationId,
    systemCode,
    requestMessages,
    assembleOptions,
    traceCollector,
    toolRegistry,
    toolExecutor,
    callbacks,
    maxTurns = DEFAULT_MAX_TURNS,
    enableFrontendToolLoop = false,
    initialDiscoveredToolNames,
  } = options

  let aborted = false
  let streamAbort: (() => void) | null = null
  const loopAbortController = new AbortController()

  // 是否真正由前端本地执行工具循环：
  // - enableFrontendToolLoop 为 true 且已注册前端本地工具
  // - provider 支持 function calling（本地模型、OpenAI 兼容云端模型、Anthropic 兼容云端模型）
  // - MESCLI Local + 云端 Provider 时，此前端 loop 优先于后端 SSE tool 事件
  // - MESCLI Online + frontend_loop_online 时，走 BackendProxyModelClient 由前端本地执行工具
  const providerSupportsTools = modelClientSupportsTools(provider.provider, provider.baseUrl)
  const useFrontendToolLoop = enableFrontendToolLoop && toolRegistry.list().length > 0 && providerSupportsTools

  // 当前轮次的 assistant 消息。每轮工具调用后会新建一条，避免 tool_calls 跨轮串扰。
  let currentAssistant = createAssistantMessage(executionMode)

  // 审批闸：高风险写工具暂停等待用户确认
  let approvalGate: ApprovalGate | undefined
  if (callbacks.onApprovalRequested) {
    approvalGate = createApprovalGate({
      onApprovalRequested: (request, resolve) => {
        // ── RenderNode: 审批请求 → 注意力节点 ──
        const attentionNode = builder.requestAttention(
          request.impactStatement || request.reason || '该工具需要人工审批',
          'approval',
          request.toolName,
          undefined, undefined,
          request.toolCallId,
        )
        syncRenderNodes()
        callbacks.onAssistantUpdate(cloneMessage(currentAssistant))
        // N-04: 包装 resolve——审批决策时立即关闭脊柱 attention 卡片
        const wrappedResolve = (approved: boolean, reason?: string) => {
          builder.resolveAttention(approved, reason, attentionNode.id)
          syncRenderNodes()
          resolve(approved, reason)
        }
        callbacks.onApprovalRequested!(request, wrappedResolve)
      },
    })
  }

  // toolCallId -> 对应 spanId（用于 trace）
  const toolSpanMap = new Map<string, string>()
  // 已创建过占位消息的工具调用 ID（避免 MESCLI 的 tool_start 与 OpenAI tool_call 重复创建）
  const createdToolMessages = new Set<string>()
  // 正在流式累积中的工具调用（按 id 去重），用于解决 OpenAI 流式 tool_calls 分 chunk 到达导致的重复问题
  const pendingToolCalls: ToolCallNormalizerState = createToolCallNormalizerState()
  // 已经开始执行的工具调用 Promise（流式执行：参数完整即启动）
  const inflightToolExecutions = new Map<string, Promise<ToolResult>>()
  // 已经触发执行的工具调用 ID，避免重复启动
  const startedToolExecutions = new Set<string>()
  // toolCallId -> 对应独立 AbortController，用于单条工具调用取消
  const toolAbortControllers = new Map<string, AbortController>()
  // 已被用户主动取消的工具调用 ID（用于结果返回时覆盖为取消状态）
  const cancelledToolIds = new Set<string>()
  // Watchdog: 工具执行进度追踪（toolCallId → { startedAt, lastProgressAt }）
  const toolWatch = new Map<string, { startedAt: number; lastProgressAt: number }>()
  let watchdogTimer: ReturnType<typeof setInterval> | null = null
  // 已通过 tool_search 发现的延迟加载工具名（小写），后续轮次会注入上下文
  const discoveredToolNames = new Set<string>(initialDiscoveredToolNames ?? [])
  let modelSpanId: string | undefined

  // tool_search 调用限制（M1 基调：每轮 1 次，总会话 3 次）
  let toolSearchCallsThisTurn = 0
  let toolSearchCallsTotal = 0
  const MAX_TOOL_SEARCH_PER_TURN = 1
  const MAX_TOOL_SEARCH_TOTAL = 3

  // ── Watchdog ──────────────────────────────────────────────
  const STALL_THRESHOLD_MS = 30_000  // 30s 无进展 → stalled

  function startWatchdog(): void {
    if (watchdogTimer) return
    watchdogTimer = setInterval(() => {
      const now = Date.now()
      for (const [toolCallId, w] of toolWatch) {
        // 无进展超时 → stalled
        if (now - w.lastProgressAt > STALL_THRESHOLD_MS) {
          // 写入日志提示 + stalled 标记
          builder.appendToolLog(toolCallId, '\n（等待较久，仍在执行或可能已卡住）')
          if (!cancelledToolIds.has(toolCallId)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            callbacks.onToolUpdate(toolCallId, { stalled: true } as any)
          }
          // 从 watchdog 中移除以避免重复提示
          toolWatch.delete(toolCallId)
        }
      }
      // 无活跃工具时停转
      if (toolWatch.size === 0 && watchdogTimer) {
        clearInterval(watchdogTimer)
        watchdogTimer = null
      }
    }, 5000)
  }

  function stopWatchdog(): void {
    if (watchdogTimer) {
      clearInterval(watchdogTimer)
      watchdogTimer = null
    }
    toolWatch.clear()
  }

  // 可观测性：每轮模型调用统计
  let turnStartTime = 0
  let firstTokenTime: number | undefined
  let stopReason: string | undefined
  let realTokensIn: number | undefined
  let realTokensOut: number | undefined

  // ── RenderNode builder（v1.0 瀑布流可视化） ──
  let builder: RenderNodeBuilder = USE_PROJECTED_BUILDER
    ? createProjectedBuilder()
    : createRenderNodeBuilder()
  // Phase 2 增量渲染引用（仅在 projected builder 模式下可用；多轮循环中 builder 会被替换，用 let）
  let projectedBuilder: ProjectedBuilder | null =
    USE_PROJECTED_BUILDER ? (builder as ProjectedBuilder) : null

  // Phase 2：增量渲染——跟踪上一批 drain 后的节点数组，配合 BatchPlanner 做增量 diff
  let prevRenderNodes: RenderNode[] = []

  // §7 SupplementGateway：过程中用户补充队列（claude-code "next" priority pattern）
  const supplementQueue: string[] = []

  /** 应用待注入的补充：将所有排队补充作为 user 消息追加到 currentMessages（步骤间隙）。
   * 同构原则（claude-code）：就是普通 user 消息，不加前缀、不造单独机制——
   * 位置即语义（它是模型看到的最新用户输入），模型自然接续回应。 */
  const applyPendingSupplements = (): void => {
    while (supplementQueue.length > 0) {
      const text = supplementQueue.shift()!
      // 添加到对话上下文（下次模型调用能看到）
      currentMessages.push({ role: 'user', content: text })
      // 记录补充到 EventLog（渲染侧可在 TurnState.supplements 中读取）
      if (projectedBuilder) {
        projectedBuilder.eventLog.append(
          eventFactory.supplement(text, `${userMessage.id}:supp:${Date.now()}`)
        )
      }
      // v9 双轨：通知 chatStore 补充已真正注入（上屏气泡+持久化+chip 变绿）
      callbacks.onSupplementInjected?.(text)
      // 补充也用一次 syncRenderNodes 让 React 感知（后续可在 WaterfallTurn 显示补充气泡）
      syncRenderNodes()
    }
  }

  /** 同步 renderNodes 到 currentAssistant；同时写入内核投影的 turnPhase/turnStats/rounds/answers */
  const syncRenderNodes = (): void => {
    if (projectedBuilder) {
      const { nodes } = projectedBuilder.drainOps(prevRenderNodes)
      prevRenderNodes = nodes
      currentAssistant.renderNodes = nodes
      // 终态统计：从投影器直读（唯一事实源），写入 ChatMessage 供组件消费
      const state = projectedBuilder.getState()
      currentAssistant.turnPhase = state.phase
      currentAssistant.turnStats = state.stats
      // v4.0: 同步轮次数据（RoundSnapshot 和 answers）到 ChatMessage
      currentAssistant.rounds = state.rounds.map((r) => ({
        index: r.index,
        nodeIds: r.nodeIds,
        answerNodeId: r.answerNodeId,
        phase: r.phase,
        stats: r.stats,
      }))
      currentAssistant.answers = state.answers
      // v9.2: 同步补充记录（含注入时轮次），渲染侧把气泡定位到注入点
      currentAssistant.supplements = state.supplements
      // v4.0 §6: 终态时 content = 各轮 answer 拼接（保持字段语义，供持久化/导出）
      if (state.phase !== 'active' && state.answers.length > 0) {
        currentAssistant.content = state.answers.join('\n\n')
      }
    } else {
      currentAssistant.renderNodes = [...builder.nodes]
    }
  }

  // 多轮循环状态
  let turn = 0
  let isFirstModelCall = true  // BUG-10: 一个用户 turn 只创建一次 builder
  let eventLogCheckpoint = 0  // BUG-20: 重试时回滚 EventLog 到此位置
  let currentMessages: Message[] = []
  let turnContentBuffer = ''
  let turnReasoningBuffer = ''
  let promptTooLongRetries = 0
  let lastTurnStartContentLength = 0
  let lastTurnStartReasoningLength = 0
  const MAX_PROMPT_TOO_LONG_RETRIES = 2

  // 模型 fallback 与 max_output_tokens 续写状态
  let modelFallbackRetries = 0
  const MAX_MODEL_FALLBACK_RETRIES = 1
  let maxOutputTokensRetries = 0
  const MAX_MAX_OUTPUT_TOKENS_RETRIES = 2
  let effectiveMaxTokens = isLocalModelProvider(provider.provider)
    ? useLocalModelStore.getState().config.maxTokens ?? 2048
    : 2048
  // 输出上限升级帽：默认 16384，400 max_tokens 错误学到真实上限后收紧（打磨任务7 P3）
  let maxOutputCap = resolveMaxOutputTokens(provider.provider, provider.model) ?? 16384

  // ── 循环内上下文水位与自动压缩（P1：长对话可用闭环）──
  // 分层防线中的 Layer 4/5/6：水位统计 → autoCompact → blocking 预检。
  // （Layer 1/2 工具结果落盘、Layer 3 microCompact 属 P2，见打磨任务6 文档。）
  const AUTOCOMPACT_BUFFER_TOKENS = 13000 // effectiveWindow − 13000 触发自动压缩
  const BLOCKING_BUFFER_TOKENS = 3000 // effectiveWindow − 3000 阻断发请求
  const MAX_AUTOCOMPACT_FAILURES = 3 // 连续失败熔断（pipelineRunner 另有 per-name 熔断）
  const COMPACT_KEEP_RECENT_MESSAGES = 20 // 压缩时尾部保留的最近消息数
  // let 而非 const：400 下行校准学到真实窗口后会收紧此值（打磨任务7 P2）
  let contextWindow = assembleOptions?.contextWindow ?? resolveContextWindow(provider.provider, provider.model).value
  let waterBaseTokens: number | undefined // 最近一次真实 usage 的水位基准
  let waterBaseIndex = 0 // 基准时刻 currentMessages 的长度
  let autoCompactFailures = 0
  let maxTurnsCompactRetried = false // maxTurns 出口"压缩续命"只尝试一次

  // 与 utils/error.ts isContextLengthError 保持同一语义（修改需两边同步）。
  // 2026-07-24 补 Anthropic/Kimi 原话 "prompt is too long"——否则 Anthropic 系
  // 400 永远走不到压缩重试分支，长对话超限即死，这正是"无法压缩"报告的总根因。
  const PROMPT_TOO_LONG_PATTERNS = [
    'prompt_too_long',
    'prompt is too long',
    'context_length_exceeded',
    'maximum context length',
    'context window',
    'too many tokens',
    'token limit',
    'tokens exceeds',
    'request_too_large',
    'request too large',
    'reduce the length',
  ]

  function isPromptTooLongError(error: Error): boolean {
    const text = error.message.toLowerCase()
    return PROMPT_TOO_LONG_PATTERNS.some((p) => text.includes(p))
  }

  function compactMessagesForRetry(messages: Message[]): Message[] {
    // 保留 system 消息，丢弃最旧的 2 条非 system 消息（通常是早期 user/assistant/tool）
    const firstNonSystem = messages.findIndex((m) => m.role !== 'system')
    if (firstNonSystem === -1) return messages
    const dropCount = Math.min(2, messages.length - firstNonSystem - 1)
    if (dropCount <= 0) return messages
    return [
      ...messages.slice(0, firstNonSystem),
      ...messages.slice(firstNonSystem + dropCount),
    ]
  }

  /**
   * 流式响应中断后，为已发出但尚未返回结果的 tool_use 生成 synthetic tool_result。
   * 这样可以避免后续请求出现 tool_use / tool_result 失配导致 API 400。
   */
  function synthesizeOrphanToolResults(): void {
    const calls = currentAssistant.toolCalls || []
    if (calls.length === 0) return

    for (const tc of calls) {
      const alreadyHasResult = currentMessages.some(
        (m) => m.role === 'tool' && m.toolCallId === tc.id
      )
      if (alreadyHasResult) continue

      const errorText = '工具调用因响应中断未能完成执行'
      currentMessages.push({
        role: 'tool',
        content: errorText,
        toolCallId: tc.id,
      })
      callbacks.onToolUpdate?.(tc.id, {
        content: errorText,
        toolCallStatus: 'error',
      })
      const spanId = toolSpanMap.get(tc.id)
      if (spanId) {
        traceCollector.failSpan(spanId, errorText)
      }
    }
  }

  /**
   * 估算循环内当前上下文水位（token）。
   * 权威路径（对标 claude-code tokenCountWithEstimation）：最近一次真实 usage
   * （tokensIn + cacheReadTokens）+ 其后新增消息的粗估；无 usage 时全量粗估。
   */
  const estimateCurrentWater = (): number => {
    if (waterBaseTokens === undefined) {
      return estimateContextTokens(currentMessages, undefined, contextWindow).used
    }
    const tail = currentMessages.slice(waterBaseIndex)
    if (tail.length === 0) return waterBaseTokens
    return waterBaseTokens + estimateContextTokens(tail, undefined, contextWindow).used
  }

  const getEffectiveWindow = (): number =>
    contextWindow - Math.min(effectiveMaxTokens, 20000)

  /**
   * 自动压缩（Layer 5）：水位超阈值时，把 currentMessages 的前段压缩为摘要消息。
   * 作用于循环内 currentMessages 本体（不是 store 快照）——这是与旧
   * tryCompressForRetry 的关键区别，压缩后循环内工具成果全部保留。
   * force=true 时跳过阈值检查（maxTurns 续命/blocking 预检场景）。
   */
  const tryAutoCompact = async (force = false): Promise<boolean> => {
    if (!useFrontendToolLoop) return false
    if (autoCompactFailures >= MAX_AUTOCOMPACT_FAILURES) return false

    if (!force) {
      const water = estimateCurrentWater()
      if (water < getEffectiveWindow() - AUTOCOMPACT_BUFFER_TOKENS) return false
    }

    // 切点选择：system 前缀保留；尾部保留最近 N 条；中间段送压缩
    const systemPrefix: Message[] = []
    let i = 0
    while (i < currentMessages.length && currentMessages[i].role === 'system') {
      systemPrefix.push(currentMessages[i])
      i++
    }
    const nonSystem = currentMessages.slice(i)
    const keepCount = Math.min(COMPACT_KEEP_RECENT_MESSAGES, Math.floor(nonSystem.length / 2))
    let cut = nonSystem.length - keepCount
    // 切点不能落在 tool 消息上（避免 kept 段以 orphan tool_result 开头，
    // 且让 tool 结果跟随其 assistant 留在被压缩段）
    while (cut < nonSystem.length && nonSystem[cut].role === 'tool') cut++
    if (cut < 4 || cut >= nonSystem.length) return false // 可压缩段太短，不值得

    const segment = ensureToolResultPairing(nonSystem.slice(0, cut))
    const kept = ensureToolResultPairing(nonSystem.slice(cut))

    const transport = createPipelineTransport({
      provider,
      apiKey,
      baseUrl,
      conversationId,
      systemCode,
      executionMode,
      enableFrontendToolLoop,
    })

    callbacks.onCompactStart?.(segment.length)
    // 可靠性修复（2026-07-24）：压缩请求本身也可能超窗口——被压缩段在低水位
    // 误判（默认值猜大、400 校准未学到）时可能接近模型真实上限，压缩调用
    // 确定性 400，maxRetries 重试无意义，最终熔断 → "长对话无法压缩"。
    // 第一次失败后用"丢掉最旧一半"的减半段重试一次：摘要覆盖更少的消息，
    // 但保证压缩一定能完成，避免超限死锁。
    let result = await runPipeline(
      compactSummaryPipeline,
      { messages: segment },
      transport,
      { signal: loopAbortController.signal }
    )
    if (aborted) return false
    if ((!result.ok || !result.value) && segment.length >= 8) {
      const halved = segment.slice(Math.floor(segment.length / 2))
      console.warn(
        `[agenticLoop] autoCompact 首试失败，减半段重试（${segment.length} → ${halved.length} 条）:`,
        result.error
      )
      result = await runPipeline(
        compactSummaryPipeline,
        { messages: halved },
        transport,
        { signal: loopAbortController.signal }
      )
      if (aborted) return false
    }

    if (!result.ok || !result.value) {
      autoCompactFailures++
      console.warn(
        `[agenticLoop] autoCompact 失败（${autoCompactFailures}/${MAX_AUTOCOMPACT_FAILURES}）:`,
        result.error
      )
      return false
    }

    // 回写：system 前缀 + 摘要 user 消息 + 保留段
    currentMessages = [
      ...systemPrefix,
      { role: 'user', content: buildCompactContinuationContent(result.value) },
      ...kept,
    ]
    // 消息已整体替换，水位基准失效——下次退化为全量估算
    waterBaseTokens = undefined
    waterBaseIndex = 0
    autoCompactFailures = 0
    callbacks.onCompacted?.({ summarizedCount: segment.length, keptCount: kept.length, summary: result.value })
    return true
  }

  const run = async (): Promise<void> => {
    try {
      // 1. 上下文装配
      let messages: Message[]
      if (requestMessages) {
        messages = requestMessages
      } else if (assembleOptions) {
        const assembled = await assembleRequestMessages({
          ...assembleOptions,
          userMessage,
        })
        messages = assembled.messages
        callbacks.onContextAssembled?.(assembled)
      } else {
        throw new Error('AgenticLoop: 必须提供 requestMessages 或 assembleOptions')
      }
      currentMessages = messages

      // 2. Trace 起点
      traceCollector.startTrace(userMessage.content, 'chat', {
        provider: provider.provider,
        model: provider.model,
        conversationId,
        systemCode,
        executionMode,
        isLocalModel: isLocalModelProvider(provider.provider),
        enableFrontendToolLoop,
        maxTurns,
      })
      const contextSpan = traceCollector.startSpan('context_assembly', 'context_assembly')
      traceCollector.completeSpan(contextSpan.spanId, {
        messageCount: messages.length,
      })

      // 3. 创建第一个助手占位消息
      callbacks.onAssistantCreated(currentAssistant)

      // 4. 进入第一轮
      await runTurn(messages)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      handleFatalError(error)
    }
  }

  function resetToolState(): void {
    resetToolCallNormalizer(pendingToolCalls)
    createdToolMessages.clear()
    inflightToolExecutions.clear()
    startedToolExecutions.clear()
    // 重试/续写前清理当前助手已累积的 tool_calls，避免脏状态污染下一轮
    currentAssistant.toolCalls = undefined
  }

  const runTurn = async (messages: Message[], isRetry = false): Promise<void> => {
    if (aborted) return
    // R1 (N-01): 重试时用 ProjectedBuilder.rewindTo——同步 _drainMarker + 内部索引，
    // 返回 checkpoint 节点数组作为 prevRenderNodes，不丢光现有节点
    if (isRetry && projectedBuilder && eventLogCheckpoint > 0) {
      prevRenderNodes = projectedBuilder.rewindTo(eventLogCheckpoint)
    }
    if (!isRetry && turn >= maxTurns) {
      // 出口兜底：补齐 synthetic tool_result，避免 dangling toolCalls 毒化历史
      synthesizeOrphanToolResults()
      finalizeLoop()
      return
    }

    if (!isRetry) turn++
    turnContentBuffer = ''
    turnReasoningBuffer = ''
    toolSearchCallsThisTurn = 0
    resetToolState()

    // ── 每轮模型调用处理 RenderNode builder ──
    // R1: 一个用户 turn 只创建一次 builder；工具循环迭代复用同一 builder + 节点累积
    if (!isRetry) {
      if (isFirstModelCall) {
        isFirstModelCall = false
        builder = USE_PROJECTED_BUILDER
          ? createProjectedBuilder(userMessage.id)
          : createRenderNodeBuilder(userMessage.id)
        projectedBuilder = USE_PROJECTED_BUILDER ? (builder as ProjectedBuilder) : null
        // 首次调用：全新 renderNodes
        prevRenderNodes = []
      }
      // BUG-20: 记录本轮调用前的 EventLog checkpoint，供重试时回滚（在 startRound 之前）
      eventLogCheckpoint = projectedBuilder ? projectedBuilder.eventLog.length : 0
      // v4.0: 每轮模型调用开始新 round
      if (projectedBuilder) projectedBuilder.startRound(turn)
      // 每次模型调用都开始新思考
      builder.startThinking()
      syncRenderNodes()
    }

    // 记录本轮开始前的助手内容长度，用于 prompt_too_long 重试时回滚部分输出
    lastTurnStartContentLength = currentAssistant.content.length
    lastTurnStartReasoningLength = currentAssistant.reasoningContent?.length || 0

    const modelSpan = traceCollector.startSpan('model_call', `model_call_turn_${turn}`, undefined, {
      model: provider.model,
      provider: provider.provider,
      isLocalModel: isLocalModelProvider(provider.provider),
      enableFrontendToolLoop,
    })
    modelSpanId = modelSpan.spanId

    // 重置每轮可观测性状态
    turnStartTime = Date.now()
    firstTokenTime = undefined
    stopReason = undefined
    realTokensIn = undefined
    realTokensOut = undefined

    // ── P1 上下文水位管理（每轮发请求前）：autoCompact → blocking 预检 ──
    if (!isRetry && useFrontendToolLoop) {
      const water = estimateCurrentWater()
      if (water >= getEffectiveWindow() - AUTOCOMPACT_BUFFER_TOKENS) {
        const compacted = await tryAutoCompact()
        if (aborted) return
        if (compacted) {
          // 压缩替换了 currentMessages，本轮请求基于新消息集合
          messages = currentMessages
        }
      }
      // blocking 预检：压缩后仍超 blocking 线 → 不发请求，给用户明确提示而非 400 撞墙
      if (estimateCurrentWater() >= getEffectiveWindow() - BLOCKING_BUFFER_TOKENS) {
        currentAssistant.content =
          (currentAssistant.content || '') +
          `\n\n---\n*上下文已达到模型窗口上限，且自动压缩暂不可用（连续失败或熔断中）。建议开启新会话继续，或删除部分历史后重试。*`
        currentAssistant.status = 'done'
        currentAssistant.isStreaming = false
        flushAssistantDisplay()
        finalizeLoop()
        return
      }
    }

    // 发起流式请求
    // - Standalone / MESCLI-Local：直接调用 Provider 走 ModelClient；
    // - MESCLI-Online + frontend_loop_online：走后端 /api/chat/proxy，前端本地执行工具；
    // - MESCLI-Online（传统）：走后端 /api/chat/stream-sse，由后端执行工具。
    const commonRequest: ModelClientRequest = {
      provider: provider.provider,
      model: provider.model,
      apiKey,
      baseUrl,
      conversationId,
      systemCode,
      messages,
      executionMode,
      tools: useFrontendToolLoop
        ? toolRegistry.toToolDefinitions(buildToolDefinitionsOptions(toolRegistry, discoveredToolNames, provider))
        : undefined,
    }

    if (isLocalRuntime()) {
      // MESCLI Local 模式下，Anthropic 兼容 Provider（Kimi Code / Claude）在浏览器生产包中
      // 直接跨域调用会被 CORS 拦截；统一走后端 /api/chat/proxy，由后端转发。
      // tokenhub（腾讯 tokenhub.tencentmaas.com）同样不发 CORS 头（OPTIONS 预检 405），
      // 也必须走后端代理，否则浏览器直接拦死。
      const useBackendProxy =
        !IS_STANDALONE &&
        (isAnthropicCompatibleProvider(provider.provider, baseUrl || provider.baseUrl) ||
          provider.provider === 'tokenhub')

      if (useBackendProxy) {
        const backendProxy = createBackendProxyModelClient()
        streamAbort = backendProxy.streamChat(
          { ...commonRequest, maxTokens: effectiveMaxTokens },
          {
            onChunk: handleStreamChunk,
            onError: handleStreamError,
            onDone: handleStreamDone,
          }
        )
      } else {
        const modelClient = await createModelClient(provider.provider, provider.baseUrl)
        const request = { ...commonRequest }

        // 本地模型需要从 localModelStore 读取 apiKey / temperature / maxTokens
        if (isLocalModelProvider(provider.provider)) {
          const localConfig = useLocalModelStore.getState().config
          request.apiKey = localConfig.apiKey || undefined
          request.temperature = localConfig.temperature
        }
        request.maxTokens = effectiveMaxTokens

        streamAbort = modelClient.streamChat(request, {
          onChunk: handleStreamChunk,
          onError: handleStreamError,
          onDone: handleStreamDone,
        })
      }
    } else if (enableFrontendToolLoop) {
      // MESCLI-Online 前端循环：后端仅作 LLM 流代理
      const backendProxy = createBackendProxyModelClient()
      streamAbort = backendProxy.streamChat(commonRequest, {
        onChunk: handleStreamChunk,
        onError: handleStreamError,
        onDone: handleStreamDone,
      })
    } else {
      // MESCLI-Online 传统路径：走后端 SSE，由后端执行工具
      const request = {
        provider: commonRequest.provider,
        model: commonRequest.model,
        apiKey: commonRequest.apiKey,
        baseUrl: commonRequest.baseUrl,
        conversationId: commonRequest.conversationId,
        messages: commonRequest.messages,
        executionMode: commonRequest.executionMode,
        tools: commonRequest.tools,
      }

      streamAbort = chatApi.streamChat(
        request,
        handleStreamChunk,
        handleStreamError,
        handleStreamDone
      )
    }
  }

  // ── Phase 2 渲染调度器（自适应节拍 + 双车道） ──
  // 替换固定 200ms 节流：content/reasoning 走常规车道（自适应定时 + 量子触发），
  // 工具/错误/完成走快车道（立即冲刷）。公式：flushInterval = clamp(1200, 1200×√(pending/4), 2000)ms
  const scheduler = new RenderScheduler({
    onFlush: () => {
      // BUG-15: scheduler flush 时统一执行 syncRenderNodes + push display，
      // 避免 content/reasoning 每个 chunk 都全量 project(eventLog) 导致 O(N²)
      syncRenderNodes()
      const display = cloneMessage(currentAssistant)
      callbacks.onAssistantUpdate(display)
    },
  })

  // 保留 pushAssistantDisplay 供快车道（abort / settle 等）直接使用
  const pushAssistantDisplay = (): void => {
    const display = cloneMessage(currentAssistant)
    callbacks.onAssistantUpdate(display)
  }

  /** 常规车道入口：content / reasoning chunk 排入调度器 */
  const scheduleContentDisplay = (answerChars = 0): void => {
    scheduler.noteEvent('content', { answerChars })
  }
  const scheduleReasoningDisplay = (): void => {
    scheduler.noteEvent('reasoning')
  }

  /** 快车道：立即冲刷调度器缓冲并更新显示 */
  const flushAssistantDisplay = (): void => {
    scheduler.flushNow()
  }

  const handleStreamChunk = (chunk: StreamChunk): void => {
    if (aborted) return

    // 记录首 token 时间（TTFT）
    if (
      firstTokenTime === undefined &&
      (chunk.type === 'content' || chunk.type === 'reasoning' || chunk.type === 'tool_call')
    ) {
      firstTokenTime = Date.now()
    }

    // 记录停止原因与真实用量
    if (chunk.type === 'done' && chunk.stopReason) {
      stopReason = chunk.stopReason
    }
    if (chunk.type === 'usage' && chunk.usage) {
      if (typeof chunk.usage.tokensIn === 'number') realTokensIn = chunk.usage.tokensIn
      if (typeof chunk.usage.tokensOut === 'number') realTokensOut = chunk.usage.tokensOut
      if (chunk.stopReason) stopReason = chunk.stopReason
      // 水位基准（Layer 4）：真实 usage = tokensIn + cacheReadTokens，
      // 其后新增消息由 estimateCurrentWater 增量粗估
      if (typeof chunk.usage.tokensIn === 'number') {
        waterBaseTokens = chunk.usage.tokensIn + (chunk.usage.cacheReadTokens ?? 0)
        waterBaseIndex = currentMessages.length
        // 上行校准（打磨任务7 P3）：请求成功证明窗口装得下当前 prompt，
        // 抬升注册表下界（函数内部有单调性判断，不会回退）
        recordObservedLowerBound(provider.provider, provider.model, waterBaseTokens)
      }
    }

    callbacks.onChunk?.(chunk)

    switch (chunk.type) {
      case 'content': {
        const text = chunk.content || ''
        turnContentBuffer += text
        currentAssistant.content = (currentAssistant.content || '') + text
        if (currentAssistant.status === 'thinking' || currentAssistant.status === 'calling_tools') {
          currentAssistant.status = 'streaming'
        }
        // ── RenderNode: 首段内容到达，结束思考并开始回答 ──
        if (builder.thinkingNode) {
          builder.finishThinking()
        }
        builder.appendAnswer(text)
        // BUG-15: syncRenderNodes 由 scheduler flush 统一执行，每 chunk 不再独立全量投影
        scheduleContentDisplay(text.length)
        break
      }

      case 'reasoning': {
        const text = chunk.reasoning || ''
        turnReasoningBuffer += text
        currentAssistant.reasoningContent =
          (currentAssistant.reasoningContent || '') + text
        // ── RenderNode: 推理内容追加到思考节点 ──
        builder.appendThinking(text)
        // BUG-15: syncRenderNodes 由 scheduler flush 统一执行
        scheduleReasoningDisplay()
        break
      }

      case 'tool_call': {
        const incoming = chunk.toolCalls || []
        if (incoming.length > 0) {
          // ── RenderNode: 首次工具调用到达，结束思考阶段 ──
          if (builder.thinkingNode) {
            builder.finishThinking()
          }

          // 按 id 累积流式 tool_call，兼容增量与累积两种 delta 格式，避免重复/残缺
          for (const tc of incoming) {
            const existing = pendingToolCalls.calls.get(tc.id)
            const accumulatedName = tc.function?.name || existing?.function.name || ''
            const accumulatedArgs = mergeToolArguments(
              existing?.function.arguments || '',
              tc.function?.arguments || ''
            )
            pendingToolCalls.calls.set(tc.id, {
              id: tc.id,
              type: 'function',
              function: {
                name: accumulatedName,
                arguments: accumulatedArgs,
              },
              hasReceivedArgs: existing?.hasReceivedArgs || (tc.function?.arguments || '').length > 0,
              updatedAt: Date.now(),
            })
            ensureToolPlaceholder(tc.id, accumulatedName)
            if (accumulatedName) {
              callbacks.onToolUpdate(tc.id, {
                toolCallName: accumulatedName,
                toolCallStatus: 'calling',
              })
            }

            // ── RenderNode: 启动/更新工具节点 ──
            if (accumulatedName) {
              builder.startTool(tc.id, accumulatedName, accumulatedArgs)
            }

            // 流式执行：参数一旦完整且未被启动过，立即开始执行
            if (
              useFrontendToolLoop &&
              accumulatedName &&
              isCompleteJson(accumulatedArgs) &&
              !startedToolExecutions.has(tc.id)
            ) {
              tryStartToolExecution(tc.id, accumulatedName, accumulatedArgs)
            }
          }
          currentAssistant.toolCalls = getNormalizedToolCalls(pendingToolCalls)
          currentAssistant.status = 'calling_tools'
          // N-10: 工具调用到达走短车道（tool_start），让并行工具在同一缓冲窗口出生
          scheduler.noteEvent('tool_start')
        }
        break
      }

      case 'tool_start': {
        const toolName = chunk.content || ''
        const toolCallId = chunk.toolCallId || generateId()
        // ── RenderNode: 后端 SSE 工具的 thinking→acting 转换 ──
        if (builder.thinkingNode) {
          builder.finishThinking()
        }
        builder.startTool(toolCallId, toolName)
        currentAssistant.status = 'calling_tools'
        if (!currentAssistant.thinkingProcess) {
          currentAssistant.thinkingProcess = {
            executionLog: '',
            status: 'running',
            isExpanded: true,
          }
        } else {
          currentAssistant.thinkingProcess = { ...currentAssistant.thinkingProcess, status: 'running' }
        }
        // N-10: 后端工具启动走短车道，与前端 tool_call 缓冲窗口一致
        scheduler.noteEvent('tool_start')

        ensureToolPlaceholder(toolCallId, toolName)

        // 无论前后端 loop，都保证 assistant.toolCalls 包含该 tool_use，
        // 否则后端 SSE 路径保存的 assistant 消息缺少 toolCalls，重载时 tool 结果会被当 orphan 删除。
        if (!pendingToolCalls.calls.has(toolCallId)) {
          pendingToolCalls.calls.set(toolCallId, {
            id: toolCallId,
            type: 'function',
            function: { name: toolName, arguments: '' },
            hasReceivedArgs: false,
            updatedAt: Date.now(),
          })
        }
        if (!currentAssistant.toolCalls?.some((tc) => tc.id === toolCallId)) {
          currentAssistant.toolCalls = getNormalizedToolCalls(pendingToolCalls)
          callbacks.onAssistantUpdate(cloneMessage(currentAssistant))
        }

        if (useFrontendToolLoop) {
          // 前端本地 loop 已接管工具执行；后端 tool_start 仅作为 UI 占位，不进入后端驱动流程
          console.warn(
            `[agenticLoop] backend tool_start received while frontend tool loop is active (tool=${toolName}, id=${toolCallId})`
          )
          break
        }

        callbacks.onToolUpdate(toolCallId, { toolCallStatus: 'calling' })
        break
      }

      case 'tool_stdout': {
        const toolCallId = chunk.toolCallId || ''
        if (currentAssistant.thinkingProcess) {
          currentAssistant.thinkingProcess = {
            ...currentAssistant.thinkingProcess,
            executionLog: (currentAssistant.thinkingProcess.executionLog + '\n' + (chunk.content || '')).trim(),
          }
          callbacks.onAssistantUpdate(cloneMessage(currentAssistant))
        }
        callbacks.onToolStdout?.(toolCallId, chunk.content || '')
        // ── RenderNode: 工具输出日志 ──
        builder.appendToolLog(toolCallId, chunk.content || '')
        break
      }

      case 'tool_result': {
        const toolCallId = chunk.toolCallId || ''
        const toolName = chunk.content || ''

        if (useFrontendToolLoop) {
          // 前端本地 loop 已接管工具执行；忽略后端 tool_result，由本地执行器更新最终结果
          console.warn(
            `[agenticLoop] backend tool_result received while frontend tool loop is active (tool=${toolName}, id=${toolCallId})`
          )
          break
        }

        callbacks.onToolUpdate(toolCallId, {
          content: chunk.content || '',
          structuredData: chunk.structuredData,
          toolCallStatus: 'done',
        })

        // 后端生成的文件即时同步到工作区面板
        if (chunk.structuredData) {
          const workspaceFiles = extractWorkspaceFiles(chunk.structuredData)
          if (workspaceFiles.length > 0) {
            try {
              useWorkspaceFileStore.getState().importBackendFiles(workspaceFiles)
            } catch (err) {
              console.warn('[agenticLoop] 同步后端工作区文件失败:', err)
            }
          }
        }

        const spanId = toolSpanMap.get(toolCallId)
        if (spanId) {
          traceCollector.completeSpan(spanId, {
            toolName,
            toolCallId,
            structuredData: chunk.structuredData,
          })
        }

        if (currentAssistant.thinkingProcess) {
          const isError = !chunk.structuredData && /(失败|错误|error|exception)/i.test(chunk.content || '')
          currentAssistant.thinkingProcess = {
            ...currentAssistant.thinkingProcess,
            status: isError ? 'error' : 'completed',
          }
          callbacks.onAssistantUpdate(cloneMessage(currentAssistant))
        }

        // ── RenderNode: 工具完成 ──
        const resultText = chunk.content || ''
        const isToolError = !chunk.structuredData && /(失败|错误|error|exception)/i.test(resultText)
        builder.finishTool(toolCallId, {
          success: !isToolError,
          summary: resultText.slice(0, 120),
          result: chunk.structuredData,
        })
        // v4.0: 暂停自动产物分类，仅通过 present_artifact 工具显式呈现
        // N-10: 工具完成走常规车道，与 content/reasoning 合批
        scheduler.noteEvent('tool_done')
        break
      }

      case 'approval_required': {
        if (useFrontendToolLoop) {
          console.warn(
            `[agenticLoop] backend approval_required ignored while frontend tool loop is active (tool=${chunk.approval?.toolName}, id=${chunk.approval?.toolCallId})`
          )
          break
        }
        if (chunk.approval) {
          // ── RenderNode: 审批请求 → 注意力节点 ──
          builder.requestAttention(
            chunk.approval.reason || chunk.approval.impactStatement || '该工具需要人工审批',
            'approval',
            chunk.approval.toolName,
            undefined, undefined,
            chunk.approval.toolCallId,
          )
          syncRenderNodes()

          const rawParams =
            (chunk.approval.rawParams as Record<string, unknown> | undefined) ?? {}
          const baseImpact =
            chunk.approval.impactStatement || chunk.approval.reason || '该工具需要人工审批'
          const sqlRuleHint =
            chunk.approval.toolName === 'execute_sql_query' &&
            isSqlWriteOperation(typeof rawParams.sql === 'string' ? rawParams.sql : '')
              ? '（此 SQL 将修改数据库，请确认影响范围）'
              : ''
          const request: ApprovalRequest = {
            toolCallId: chunk.approval.toolCallId,
            toolName: chunk.approval.toolName,
            riskLevel: (chunk.approval.riskLevel as import('./types').ToolRiskLevel) ?? 'standard',
            impactStatement: sqlRuleHint ? `${baseImpact} ${sqlRuleHint}` : baseImpact,
            rawParams,
            argumentsSummary: JSON.stringify(rawParams),
            reason: chunk.approval.reason || '该工具需要人工审批',
            requestedAt: Date.now(),
            expiresAt: chunk.approval.expiresAt ?? Date.now() + 5 * 60 * 1000,
          }
          callbacks.onApprovalRequested?.(request, (approved, reason) => {
            const executionId = chunk.approval?.executionId
            if (!executionId) {
              const errMsg = '[agenticLoop] approval_required chunk missing executionId'
              console.error(errMsg)
              callbacks.onError(new Error('审批通道异常：缺少 executionId'))
              builder.resolveAttention(false, '审批通道异常：缺少 executionId', chunk.approval?.toolCallId)
              syncRenderNodes()
              return
            }
            toolApi
              .submitApproval({
                executionId,
                toolUseId: request.toolCallId,
                approved,
                reason,
              })
              .catch((err) => {
                const message = err instanceof Error ? err.message : String(err)
                console.error('[agenticLoop] 提交审批决策失败:', err)
                callbacks.onError(new Error(`审批决策提交失败：${message}`))
                builder.resolveAttention(false, message, chunk.approval?.toolCallId)
                syncRenderNodes()
              })
          })
        }
        break
      }

      case 'approval_result': {
        if (useFrontendToolLoop) {
          console.warn(
            `[agenticLoop] backend approval_result ignored while frontend tool loop is active (tool=${chunk.approval?.toolName}, id=${chunk.approval?.toolCallId})`
          )
          break
        }
        if (chunk.approval) {
          callbacks.onToolUpdate(chunk.approval.toolCallId, {
            approvalStatus: chunk.approval.approved ? 'approved' : 'rejected',
          })
          // ── RenderNode: 审批结果到达，关闭 attention 卡片 ──
          builder.resolveAttention(chunk.approval.approved ?? true, undefined, chunk.approval.toolCallId)
          syncRenderNodes()
        }
        break
      }

      case 'error': {
        currentAssistant.content = `${currentAssistant.content || ''}\n[错误] ${chunk.content || ''}`.trim()
        currentAssistant.status = 'error'
        // ── RenderNode: 流错误 ──
        if (builder.answerNode) {
          builder.errorAnswer(chunk.content || '')
        }
        syncRenderNodes()
        callbacks.onAssistantUpdate(cloneMessage(currentAssistant))
        break
      }

      case 'done':
      case 'conversation':
        // 这些事件由 onDone / chatStore 处理
        break
    }
  }

  const ensureToolPlaceholder = (toolCallId: string, toolName: string): void => {
    if (createdToolMessages.has(toolCallId)) return
    createdToolMessages.add(toolCallId)

    const toolMsg: ChatMessage = {
      id: generateId(),
      role: 'tool',
      content: '',
      toolCallStatus: 'calling',
      toolCallName: toolName,
      toolCallId,
      timestamp: Date.now(),
    }
    callbacks.onToolStart(toolMsg)

    // 避免 MESCLI tool_start 与 OpenAI tool_call 重复创建 span
    if (!toolSpanMap.has(toolCallId)) {
      const span = traceCollector.startSpan('tool_call', toolName, modelSpanId, {
        toolName,
        toolCallId,
      })
      toolSpanMap.set(toolCallId, span.spanId)
    }
  }

  /**
   * 兼容兜底：如果 assistant 在普通对话中输出了 <webbridge>...</webbridge> JSON，
   * 且当前走的是前端本地工具循环，就把它转换为一个 webbridge_execute 工具调用。
   * 这样即使模型没有按新 prompt 使用 tool-call，也能保证浏览器自动化请求被执行。
   */
  function tryInjectWebBridgeFallback(): boolean {
    if (!useFrontendToolLoop) return false
    if (currentAssistant.toolCalls && currentAssistant.toolCalls.length > 0) return false
    if (!toolRegistry.get(WEBBRIDGE_EXECUTE_TOOL_NAME)) return false
    if (!turnContentBuffer.includes('<webbridge>')) return false

    const { cleanedContent, jsonText } = extractWebBridgeWorkflowSafe(turnContentBuffer)
    if (!jsonText) return false

    let workflow: Record<string, unknown>
    try {
      workflow = JSON.parse(sanitizeControlCharacters(jsonText)) as Record<string, unknown>
    } catch {
      return false
    }

    const toolCallId = generateId()
    const rawArgs = JSON.stringify({ workflow })
    pendingToolCalls.calls.set(toolCallId, {
      id: toolCallId,
      type: 'function',
      function: { name: WEBBRIDGE_EXECUTE_TOOL_NAME, arguments: rawArgs },
      hasReceivedArgs: true,
      updatedAt: Date.now(),
    })

    currentAssistant.toolCalls = getNormalizedToolCalls(pendingToolCalls)
    currentAssistant.status = 'calling_tools'
    turnContentBuffer = cleanedContent
    currentAssistant.content = cleanedContent

    ensureToolPlaceholder(toolCallId, WEBBRIDGE_EXECUTE_TOOL_NAME)
    tryStartToolExecution(toolCallId, WEBBRIDGE_EXECUTE_TOOL_NAME, rawArgs)
    callbacks.onAssistantUpdate(cloneMessage(currentAssistant))

    return true
  }

  /**
   * 判断一段参数串是否已构成完整 JSON 对象/数组。
   *
   * 注意：空对象/空数组视为不完整，防止 Anthropic/Kimi Code 在
   * content_block_start 先给 `{}` 时提前启动执行。
   */
  function isCompleteJson(raw: string): boolean {
    if (!raw || raw.trim().length === 0) return false
    try {
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object') return false
      if (Array.isArray(parsed)) return parsed.length > 0
      return Object.keys(parsed).length > 0
    } catch {
      return false
    }
  }

  /**
   * 构造工具执行进度回调，复用到单条执行与批量执行。
   */
  function buildToolProgressHandler(): (update: import('./types').ToolProgressUpdate) => void {
    const statusMap: Record<string, ChatMessage['toolCallStatus']> = {
      pending: 'calling',
      running: 'calling',
      awaiting_approval: 'calling',
      completed: 'done',
      error: 'error',
      cancelled: 'cancelled',
    }
    return (update) => {
      // Watchdog: 刷新最后进展时间
      const w = toolWatch.get(update.toolCallId)
      if (w) w.lastProgressAt = Date.now()

      callbacks.onToolUpdate(update.toolCallId, {
        toolCallStatus: statusMap[update.status],
      })
      if (update.message) {
        callbacks.onToolStdout?.(update.toolCallId, update.message)
      }
    }
  }

  /**
   * 单条工具调用流式启动。
   * 参数一旦在 SSE 中完整到达即被触发，不等待整轮 assistant 消息结束。
   */
  function tryStartToolExecution(
    toolCallId: string,
    toolName: string,
    rawArgs: string
  ): Promise<ToolResult> {
    const existing = inflightToolExecutions.get(toolCallId)
    if (existing) return existing

    const lowerToolName = toolName.toLowerCase()
    if (lowerToolName === TOOL_SEARCH_TOOL_NAME) {
      if (toolSearchCallsThisTurn >= MAX_TOOL_SEARCH_PER_TURN) {
        const limitResult: ToolResult = {
          toolCallId,
          name: toolName,
          success: false,
          output: null,
          outputText: 'tool_search 每轮最多调用 1 次。请基于当前已可用工具继续推理，不要再搜索。',
          isTruncated: false,
          startedAt: Date.now(),
          endedAt: Date.now(),
          error: 'tool_search 每轮最多调用 1 次',
        }
        const promise = Promise.resolve(limitResult)
        inflightToolExecutions.set(toolCallId, promise)
        startedToolExecutions.add(toolCallId)
        return promise
      }
      if (toolSearchCallsTotal >= MAX_TOOL_SEARCH_TOTAL) {
        const limitResult: ToolResult = {
          toolCallId,
          name: toolName,
          success: false,
          output: null,
          outputText: 'tool_search 总会话调用次数已达上限（3 次）。请使用当前已可用工具完成剩余推理。',
          isTruncated: false,
          startedAt: Date.now(),
          endedAt: Date.now(),
          error: 'tool_search 总会话调用次数已达上限（3 次）',
        }
        const promise = Promise.resolve(limitResult)
        inflightToolExecutions.set(toolCallId, promise)
        startedToolExecutions.add(toolCallId)
        return promise
      }
    }

    // ── RenderNode: queued → running ──
    builder.transitionToolToRunning(toolCallId)
    // Watchdog: 追踪工具启动时间与最后进展
    const nowWatch = Date.now()
    toolWatch.set(toolCallId, { startedAt: nowWatch, lastProgressAt: nowWatch })
    startWatchdog()

    const toolSchema = toolRegistry.get(toolName)?.inputSchema
    const { args, parseError } = parseToolArguments(rawArgs, toolSchema)
    if (parseError) {
      const errorResult: ToolResult = {
        toolCallId,
        name: toolName,
        success: false,
        output: null,
        outputText: parseError,
        isTruncated: false,
        startedAt: Date.now(),
        endedAt: Date.now(),
        error: parseError,
      }
      const promise = Promise.resolve(errorResult)
      inflightToolExecutions.set(toolCallId, promise)
      startedToolExecutions.add(toolCallId)
      return promise
    }

    const traceId = traceCollector.getCurrentTrace()?.traceId || ''
    const startedAt = Date.now()

    if (lowerToolName === TOOL_SEARCH_TOOL_NAME) {
      toolSearchCallsThisTurn++
      toolSearchCallsTotal++
    }

    const toolController = createChildAbortController(loopAbortController.signal)
    toolAbortControllers.set(toolCallId, toolController)

    const makeCancelledResult = (): ToolResult => ({
      toolCallId,
      name: toolName,
      success: false,
      output: null,
      outputText: '用户已中断',
      isTruncated: false,
      startedAt,
      endedAt: Date.now(),
      error: '用户已中断',
      cancelled: true,
    })

    const promise = toolExecutor
      .execute({
        traceId,
        conversationId,
        systemCode,
        userMessage: userMessage.content,
        contextType: 'chat',
        toolName,
        args,
        toolCallId,
        abortSignal: toolController.signal,
        approvalGate,
        approvalDecisions: approvalGate?.getDecisions(),
        permissionContext: buildPermissionContext(executionMode, conversationId),
        onProgress: buildToolProgressHandler(),
      })
      .then((result) => {
        toolAbortControllers.delete(toolCallId)
        toolWatch.delete(toolCallId)  // 从 watchdog 移除
        if (cancelledToolIds.has(toolCallId)) {
          cancelledToolIds.delete(toolCallId)
          return makeCancelledResult()
        }
        return result
      })
      .catch((err) => {
        toolAbortControllers.delete(toolCallId)
        cancelledToolIds.delete(toolCallId)
        const message = err instanceof Error ? err.message : String(err)
        const failed: ToolResult = {
          toolCallId,
          name: toolName,
          success: false,
          output: null,
          outputText: message,
          isTruncated: false,
          startedAt,
          endedAt: Date.now(),
          error: message,
        }
        return failed
      })

    inflightToolExecutions.set(toolCallId, promise)
    startedToolExecutions.add(toolCallId)
    return promise
  }

  /**
   * 收集本轮所有工具调用结果。
   * 已流式启动的调用直接 await；未启动的（如 fallback 场景）在本轮结束时补执行。
   */
  async function collectToolResults(
    calls: import('@/types/mescli').ToolCall[]
  ): Promise<ToolResult[]> {
    // 阶段一：全部启动（不 await），已有 inflight 的直接复用
    const entries = calls.map((call) => {
      const toolCallId = call.id
      const toolName = call.function?.name || ''
      const rawArgs =
        typeof call.function?.arguments === 'string'
          ? call.function.arguments
          : safeStringify(call.function?.arguments)
      return {
        toolCallId,
        promise:
          inflightToolExecutions.get(toolCallId) ??
          tryStartToolExecution(toolCallId, toolName, rawArgs),
      }
    })
    // 阶段二：统一等待；结果按原顺序返回
    return Promise.all(entries.map((e) => e.promise))
  }

  /**
   * 从工具结果中提取 workspaceFiles 元数据，供工作区面板即时同步。
   */
  function extractWorkspaceFiles(output: unknown): WorkspaceFileMetadata[] {
    if (!output || typeof output !== 'object') return []
    const data = output as Record<string, unknown>
    const files = data.workspaceFiles
    if (!Array.isArray(files)) return []

    return files.filter((f): f is WorkspaceFileMetadata => {
      if (!f || typeof f !== 'object') return false
      const file = f as Partial<WorkspaceFileMetadata>
      return typeof file.path === 'string' && typeof file.sourceTool === 'string'
    })
  }

  /**
   * 把一组工具执行结果写入上下文并更新 UI / trace。
   */
  async function processToolResults(toolResults: ToolResult[]): Promise<void> {
    for (const result of toolResults) {
      const isCancelled = result.cancelled === true
      let resultText = isCancelled
        ? '用户已中断'
        : result.success
          ? (result.outputText ?? safeStringify(result.output))
          : `执行失败: ${result.error}`

      // tool_search 结果需要格式化为模型可读的文本，并提取已发现工具名
      if (!isCancelled && result.name.toLowerCase() === TOOL_SEARCH_TOOL_NAME && result.success) {
        const searchOutput = result.output as {
          matches?: { name: string; description: string; category?: string; reason: string }[]
          total?: number
        }
        if (searchOutput?.matches) {
          resultText = formatToolSearchResult(searchOutput as any)
          const discovered = extractDiscoveredToolNames(resultText)
          for (const name of discovered) {
            discoveredToolNames.add(name)
          }
          if (discovered.length > 0) {
            callbacks.onToolsDiscovered?.(discovered)
          }
        }
      }

      // list_capabilities 结果格式化为模型可读的目录文本
      if (!isCancelled && result.name.toLowerCase() === LIST_CAPABILITIES_TOOL_NAME && result.success) {
        const listOutput = result.output as {
          path: string
          text: string
          nodes: { path: string; kind: string; description: string; children?: string[] }[]
          note?: string
        }
        if (listOutput?.nodes) {
          resultText = formatListCapabilitiesResult(listOutput as any)
        }
      }

      // read_capability 结果格式化为模型可读的 schema 文本，并提取实际工具名加入发现集合
      if (!isCancelled && result.name.toLowerCase() === READ_CAPABILITY_TOOL_NAME && result.success) {
        const readOutput = result.output as {
          path: string
          name: string
          description: string
          parameters?: unknown
          schemaText: string
        }
        if (readOutput?.name) {
          resultText = formatReadCapabilityResult(readOutput as any)
          const discoveredName = extractDiscoveredNameFromReadCapability(resultText)
          if (discoveredName) {
            discoveredToolNames.add(discoveredName)
            callbacks.onToolsDiscovered?.([discoveredName])
          }
        }
      }

      // 后端生成的文件即时同步到工作区面板
      if (!isCancelled && result.success) {
        const workspaceFiles = extractWorkspaceFiles(result.output)
        if (workspaceFiles.length > 0) {
          try {
            useWorkspaceFileStore.getState().importBackendFiles(workspaceFiles)
          } catch (err) {
            console.warn('[agenticLoop] 同步后端工作区文件失败:', err)
          }
        }
      }

      currentMessages.push({
        role: 'tool',
        content: resultText,
        toolCallId: result.toolCallId,
      })

      callbacks.onToolUpdate(result.toolCallId, {
        content: resultText,
        toolCallStatus: isCancelled ? 'cancelled' : result.success ? 'done' : 'error',
        structuredData: result.output,
      })

      // ── RenderNode: 工具结果回写 ──
      if (isCancelled) {
        builder.cancelTool(result.toolCallId)
      } else {
        builder.finishTool(result.toolCallId, {
          success: result.success,
          summary: resultText.slice(0, 120),
          result: result.output,
        })
      }

      const spanId = toolSpanMap.get(result.toolCallId)
      if (spanId) {
        if (isCancelled) {
          traceCollector.failSpan(spanId, '用户已中断')
        } else {
          traceCollector.completeSpan(spanId, {
            toolName: result.name,
            toolCallId: result.toolCallId,
            success: result.success,
            outputSummary: resultText.slice(0, 200),
          })
        }
      }
    }

    // ── RenderNode: 同步本轮工具结果到助手消息 ──
    // N-10: 批量工具完成走常规车道，与 content 合批
    scheduler.noteEvent('tool_done')
  }

  const tryCompressForRetry = async (): Promise<
    { messages: Message[]; result?: AssembleContextResult } | null
  > => {
    if (!assembleOptions) return null

    // 每次重试进一步收紧上下文窗口，迫使装配器丢弃更多旧消息并触发压缩
    // 基准取已学习窗口与装配窗口的较小者（400 校准后 contextWindow 可能已收紧）
    const reductionFactor = 1 - 0.2 * (promptTooLongRetries + 1)
    const baseWindow = Math.min(assembleOptions.contextWindow, contextWindow)
    const retryContextWindow = Math.max(2048, Math.floor(baseWindow * reductionFactor))

    try {
      const result = await assembleRequestMessages({
        ...assembleOptions,
        userMessage,
        contextWindow: retryContextWindow,
        forceCompress: true,
      })
      const shortened =
        result.messages.length < currentMessages.length || !!result.compression?.summary
      if (shortened) {
        return { messages: result.messages, result }
      }
    } catch (err) {
      console.warn('[agenticLoop] prompt_too_long 重试时压缩上下文失败:', err)
    }
    return null
  }

  const handleStreamError = (error: Error): void => {
    if (aborted) return
    const modelError = classifyModelError(error)

    // 打磨任务7 P3：max_tokens 超限错误 → 学习真实输出上限并收紧升级帽
    const parsedMaxOutput = parseMaxOutputLimitFromError(error.message)
    if (parsedMaxOutput !== undefined) {
      recordLearnedMaxOutput(provider.provider, provider.model, parsedMaxOutput)
      maxOutputCap = Math.min(maxOutputCap, parsedMaxOutput)
      if (effectiveMaxTokens > maxOutputCap) {
        effectiveMaxTokens = maxOutputCap
      }
    }

    // prompt_too_long 时自动截断早期消息并重试当前轮次（Claude Code autoCompact 简化版）
    if (
      isPromptTooLongError(error) &&
      promptTooLongRetries < MAX_PROMPT_TOO_LONG_RETRIES &&
      currentMessages.length > 2
    ) {
      // ── 打磨任务7 P2：400 下行校准——从错误学习真实窗口并写回注册表 ──
      // 400 证明 limit < 当前 prompt 大小：能解析出精确 limit 用精确值，
      // 解析不出就用当前水位估算作软上界（后续 400 会继续收紧，二分收敛）。
      const parsedLimit = parseContextLimitFromError(error.message)
      const learnedLimit =
        parsedLimit ?? Math.max(8192, estimateCurrentWater() - 1)
      const { userOverrideFalsified } = recordLearnedUpperBound(
        provider.provider,
        provider.model,
        learnedLimit
      )
      if (learnedLimit < contextWindow) {
        contextWindow = learnedLimit
      }
      callbacks.onWindowLearned?.({
        learnedWindow: contextWindow,
        userOverrideFalsified,
        fromErrorMessage: parsedLimit !== undefined,
      })

      tryCompressForRetry().then((compressed) => {
        if (aborted) return

        let compacted = compressed?.messages
        const reassembledResult = compressed?.result

        // 压缩未生效或没有装配选项时，回退到粗暴丢弃最旧 2 条非 system 消息
        if (!compacted) {
          compacted = compactMessagesForRetry(currentMessages)
        }

        if (compacted.length < currentMessages.length) {
          promptTooLongRetries++
          currentMessages = compacted
          if (reassembledResult) {
            callbacks.onContextAssembled?.(reassembledResult)
          }

          // 回滚本轮已产生的部分输出
          currentAssistant.content = currentAssistant.content.slice(0, lastTurnStartContentLength)
          currentAssistant.reasoningContent = (currentAssistant.reasoningContent || '').slice(
            0,
            lastTurnStartReasoningLength
          )
          currentAssistant.isStreaming = true
          currentAssistant.status = 'thinking'
          currentAssistant.errorMessage = undefined

          // 清理本轮工具状态，避免重试轮次被脏 tool_calls / 执行中任务污染
          for (const controller of toolAbortControllers.values()) {
            if (!controller.signal.aborted) {
              controller.abort(new Error('上下文过长重试，取消正在执行的工具'))
            }
          }
          toolAbortControllers.clear()
          cancelledToolIds.clear()
          resetToolState()

          // 重试轮次视为新一轮流：重置调度器并让首个 chunk 立即渲染
          scheduler.clear()

          callbacks.onAssistantUpdate(cloneMessage(currentAssistant))

          if (modelSpanId) {
            traceCollector.completeSpan(modelSpanId, {
              promptTooLongRetry: true,
              droppedCount: currentMessages.length - compacted.length,
              remainingMessages: compacted.length,
              compressionUsed: !!reassembledResult?.compression,
            })
          }

          runTurn(compacted, true)
        } else {
          // 无法再压缩，按普通错误处理
          handleFinalStreamError(error, modelError)
        }
      })
      return
    }

    // 模型 fallback：限流/服务错误/模型不可用时切换到 fallbackModel
    const fallbackEligibleCodes: import('./modelClient/modelErrors').ModelErrorCode[] = [
      'RATE_LIMIT',
      'SERVER_ERROR',
      'INVALID_MODEL',
    ]
    if (
      fallbackEligibleCodes.includes(modelError.code) &&
      provider.fallbackModel &&
      modelFallbackRetries < MAX_MODEL_FALLBACK_RETRIES
    ) {
      synthesizeOrphanToolResults()

      // 回滚本轮已产生的部分输出
      currentAssistant.content = currentAssistant.content.slice(0, lastTurnStartContentLength)
      currentAssistant.reasoningContent = (currentAssistant.reasoningContent || '').slice(
        0,
        lastTurnStartReasoningLength
      )
      currentAssistant.isStreaming = true
      currentAssistant.status = 'thinking'
      currentAssistant.errorMessage = undefined
      currentAssistant.toolCalls = undefined
      callbacks.onAssistantUpdate(cloneMessage(currentAssistant))

      provider.model = provider.fallbackModel
      modelFallbackRetries++

      if (modelSpanId) {
        traceCollector.completeSpan(modelSpanId, {
          modelFallback: true,
          fallbackModel: provider.fallbackModel,
          errorCode: modelError.code,
        })
      }

      // 清理 pending tool calls，避免 fallback 轮次被脏状态污染
      resetToolCallNormalizer(pendingToolCalls)
      createdToolMessages.clear()
      inflightToolExecutions.clear()
      startedToolExecutions.clear()
      for (const controller of toolAbortControllers.values()) {
        if (!controller.signal.aborted) {
          controller.abort(new Error('模型 fallback，取消正在执行的工具'))
        }
      }
      toolAbortControllers.clear()
      cancelledToolIds.clear()

      runTurn(currentMessages, true)
      return
    }

    handleFinalStreamError(error, modelError)
  }

  const handleFinalStreamError = (error: Error, modelError: ReturnType<typeof classifyModelError>): void => {
    stopWatchdog()
    synthesizeOrphanToolResults()

    // N-08: 错误路径销毁调度器，释放 visibility 监听
    scheduler.destroy()

    currentAssistant.isStreaming = false
    currentAssistant.status = 'error'
    currentAssistant.errorMessage = modelError.message

    // BUG-06: turnAbort('error') 自行将 answer streaming→stopped + answerStatus→error，
    // 不先调 finishAnswer() 避免 answer 被错误标为 'done'
    if (projectedBuilder) {
      projectedBuilder.eventLog.append(eventFactory.turnAbort('error'))
    } else {
      builder.finishAnswer()
      builder.settle()
    }
    syncRenderNodes()

    callbacks.onAssistantUpdate(cloneMessage(currentAssistant))
    if (modelSpanId) {
      traceCollector.failSpan(modelSpanId, modelError.message, {
        errorClass: error.constructor.name,
        errorCode: modelError.code,
        isRetryable: modelError.isRetryable,
        isPromptTooLong: isPromptTooLongError(error),
      })
    }
    traceCollector.fail(modelError.originalError instanceof Error ? modelError.originalError : error, modelError.message)
    callbacks.onError(error)
  }

  const handleStreamDone = async (): Promise<void> => {
    if (aborted) return

    // R1 (N-02): 不在入口标 done/finishAnswer——只有 !shouldLoop 终止路径才标。
    // 工具循环和 max_tokens 续写路径中，当前 turn 仍在进行。

    // BUG-11: 兼容兜底提前到 settle 之前——避免在已闭幕日志上追加工具节点
    tryInjectWebBridgeFallback()

    // 同步本轮模型输出的 renderNodes（不 finishAnswer——等真正终止时再做）
    syncRenderNodes()

    // 记录本轮 assistant 消息，用于追加到后续请求上下文
    const assistantMessage: Message = {
      role: 'assistant',
      content: turnContentBuffer,
    }
    if (currentAssistant.toolCalls && currentAssistant.toolCalls.length > 0) {
      assistantMessage.toolCalls = currentAssistant.toolCalls
    }
    currentMessages.push(assistantMessage)

    if (modelSpanId) {
      const ttftMs = firstTokenTime ? firstTokenTime - turnStartTime : undefined
      traceCollector.completeSpan(modelSpanId, {
        finalContentLength: turnContentBuffer.length,
        turn,
        stopReason,
        ttftMs,
        tokensIn: realTokensIn,
        tokensOut: realTokensOut,
      })
    }

    // 自动结束未关闭的 tool span
    for (const [, spanId] of toolSpanMap) {
      const span = traceCollector.getSpan(spanId)
      if (span?.status === 'running') {
        traceCollector.completeSpan(spanId)
      }
    }

    // 流结束：强制刷出节流的末态，保证终态完整
    flushAssistantDisplay()

    // v4.0: 闭幕当前 round（max_tokens 续写除外——同一 round 继续输出）
    const isLengthStop = stopReason === 'length' || stopReason === 'max_tokens'
    if (projectedBuilder && !(isLengthStop && maxOutputTokensRetries < MAX_MAX_OUTPUT_TOKENS_RETRIES)) {
      projectedBuilder.settleRound()
      syncRenderNodes()
    }

    // max_output_tokens / length 停止原因：自动提升 max_tokens 上限并续写
    if (isLengthStop && maxOutputTokensRetries < MAX_MAX_OUTPUT_TOKENS_RETRIES) {
      maxOutputTokensRetries++
      effectiveMaxTokens = Math.min(effectiveMaxTokens * 2, maxOutputCap)

      // 如果本轮助手已经发出 tool_calls，先执行并收集结果，再继续输出
      const pendingToolCallsForLength = currentAssistant.toolCalls || []
      if (useFrontendToolLoop && pendingToolCallsForLength.length > 0) {
        try {
          const toolResults = await collectToolResults(pendingToolCallsForLength)
          await processToolResults(toolResults)
          // 步骤间隙：注入用户过程中补充（§7 SupplementGateway）
          applyPendingSupplements()
          // 清理执行状态，避免续写轮次被污染
          inflightToolExecutions.clear()
          startedToolExecutions.clear()
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err))
          handleFatalError(error)
          return
        }
      }

      currentMessages.push({
        role: 'user',
        content: '请继续输出剩余内容',
      })
      // v4.0: max_tokens 续写在同 round 内继续
      eventLogCheckpoint = 0
      currentAssistant.isStreaming = true
      currentAssistant.status = 'thinking'
      callbacks.onAssistantUpdate(cloneMessage(currentAssistant))
      await runTurn(currentMessages, true)
      return
    }

    const toolCalls = currentAssistant.toolCalls || []

    // BUG-22: 同一轮次 ≥2 个工具调用归入同一 FlowGroup
    if (projectedBuilder && toolCalls.length >= 2) {
      const batchId = `parallel:${currentAssistant.id}:${turn}`
      for (const tc of toolCalls) {
        projectedBuilder.setToolGroupId(tc.id, batchId)
      }
      syncRenderNodes()
    }

    const shouldLoop = useFrontendToolLoop && toolCalls.length > 0 && turn < maxTurns

    // v9.1：自然终止前有 pending 补充 → 不闭幕，把补充注入后再跑一轮
    if (!shouldLoop && supplementQueue.length > 0 && !aborted) {
      applyPendingSupplements()
      currentAssistant.isStreaming = true
      currentAssistant.status = 'thinking'
      callbacks.onAssistantUpdate(cloneMessage(currentAssistant))
      await runTurn(currentMessages)
      return
    }

    if (!shouldLoop) {
      // ── R1 (N-02): 真正的终止路径──
      builder.finishAnswer()
      syncRenderNodes()
      currentAssistant.isStreaming = false
      currentAssistant.status = currentAssistant.status === 'error' ? 'error' : 'done'

      if (useFrontendToolLoop && toolCalls.length > 0 && turn >= maxTurns) {
        if (!maxTurnsCompactRetried) {
          maxTurnsCompactRetried = true
          try {
            const toolResults = await collectToolResults(toolCalls)
            await processToolResults(toolResults)
            applyPendingSupplements()
            inflightToolExecutions.clear()
            startedToolExecutions.clear()
            const compacted = await tryAutoCompact(true)
            if (compacted && !aborted) {
              turn = 0
              currentAssistant.isStreaming = true
              currentAssistant.status = 'thinking'
              callbacks.onAssistantUpdate(cloneMessage(currentAssistant))
              await runTurn(currentMessages)
              return
            }
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err))
            handleFatalError(error)
            return
          }
        }
        synthesizeOrphanToolResults()
        const limitNote = `\n\n---\n*已达到本轮最大工具循环次数限制（${maxTurns} 轮），任务可能尚未完成。如需继续，请发送"继续"或进一步说明。*`
        currentAssistant.content = (currentAssistant.content || '') + limitNote
        callbacks.onAssistantUpdate(cloneMessage(currentAssistant))
      }

      finalizeLoop()
      return
    }

    // 前端本地执行工具调用并进入下一轮
    try {
      const toolResults = await collectToolResults(toolCalls)
      await processToolResults(toolResults)

      // 步骤间隙：注入用户过程中补充
      applyPendingSupplements()

      inflightToolExecutions.clear()
      startedToolExecutions.clear()

      currentAssistant.isStreaming = true
      currentAssistant.status = 'thinking'
      syncRenderNodes()
      callbacks.onAssistantUpdate(cloneMessage(currentAssistant))

      await runTurn(currentMessages)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      handleFatalError(error)
    }
  }

  const finalizeLoop = (): void => {
    stopWatchdog()
    currentAssistant.isStreaming = false
    if (currentAssistant.status === 'thinking' || currentAssistant.status === 'streaming' || currentAssistant.status === 'calling_tools') {
      currentAssistant.status = 'done'
    }
    if (projectedBuilder) {
      projectedBuilder.settle()
    } else {
      builder.settle()
    }
    syncRenderNodes()
    flushAssistantDisplay()
    scheduler.destroy()
    traceCollector.complete('对话完成')
    callbacks.onDone(cloneMessage(currentAssistant))
  }

  const handleFatalError = (error: Error): void => {
    stopWatchdog()
    synthesizeOrphanToolResults()
    scheduler.destroy()
    currentAssistant.isStreaming = false
    currentAssistant.status = 'error'
    currentAssistant.errorMessage = error.message
    if (projectedBuilder) {
      projectedBuilder.eventLog.append(eventFactory.turnAbort('error'))
    } else {
      builder.finishAnswer()
      builder.settle()
    }
    syncRenderNodes()
    callbacks.onAssistantUpdate(cloneMessage(currentAssistant))
    traceCollector.fail(error)
    callbacks.onError(error)
  }

  const cancelTool = (toolCallId: string): void => {
    const controller = toolAbortControllers.get(toolCallId)
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error('用户已中断'))
    }
    cancelledToolIds.add(toolCallId)
    builder.cancelTool(toolCallId)
    scheduler.noteEvent('tool_done')
    callbacks.onToolUpdate(toolCallId, {
      content: '用户已中断',
      toolCallStatus: 'cancelled',
    })
  }

  const abort = (): void => {
    aborted = true
    stopWatchdog()
    if (builder.answerNode && builder.answerNode.status === 'streaming') {
      builder.stopAnswer()
    } else {
      if (projectedBuilder) {
        projectedBuilder.eventLog.append(eventFactory.turnAbort('user'))
      }
    }
    syncRenderNodes()
    flushAssistantDisplay()
    synthesizeOrphanToolResults()
    streamAbort?.()
    loopAbortController.abort()
    approvalGate?.abort()
    scheduler.destroy()
  }

  const supplement = (text: string): void => {
    if (aborted) return
    supplementQueue.push(text)
  }

  const unsupplement = (text: string): boolean => {
    const idx = supplementQueue.indexOf(text)
    if (idx === -1) return false
    supplementQueue.splice(idx, 1)
    return true
  }

  const resolveAttention = (nodeId: string, resolved: boolean, value?: string): void => {
    if (aborted) return
    builder.resolveAttention(resolved, value, nodeId)
    syncRenderNodes()
    if (value) {
      supplementQueue.push(value)
    }
  }

  run()
  return { abort, cancelTool, supplement, unsupplement, resolveAttention }
}

function cloneMessage(m: ChatMessage): ChatMessage {
  return { ...m }
}
