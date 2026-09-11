import type { StreamChunk, ProviderConfig, Message, WorkspaceFileMetadata } from '@/types/mescli'
import type { ChatMessage, RenderNode } from '@/types/chat'
import type { ExecutionMode, ToolCall as AgentToolCall, ToolResult, ApprovalRequest, ToolPermissionContext } from './types'
import type { TraceCollector } from './traceCollector'
import type { FrontendToolRegistry } from './toolRegistry'
import { computeToolBudgetChars } from './toolRegistry'
import type { ToolExecutor } from './toolExecutor'
import { createChildAbortController } from './toolExecutor'
import type { AssembleContextResult, AssembleContextOptions } from './contextAssembler'
import type { ApprovalGate } from './approvalGate'
import { createApprovalGate } from './approvalGate'
import { createClarifyGate } from './clarifyGate'
import { ASK_USER_TOOL_NAME } from './tools/askUserTool'
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
import { createDsmlStreamFilter, parseDsmlToolCalls } from './dsmlToolCallRecovery'
import { createModelClient, modelClientSupportsTools, providerSupportsDeferredLoading } from './modelClient'
import type { ModelClient, ModelClientRequest } from './modelClient'
import { createBackendProxyModelClient, resolveProxyProviderId } from './modelClient/backendProxyModelClient'
import { ensureToolResultPairing } from './modelClient/messageNormalizer'
import { createProjectedBuilder, type ProjectedBuilder, eventFactory } from './renderKernel'
import { RenderScheduler } from './renderKernel/renderScheduler'
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
  resolveUserEffort,
} from '@/services/modelCapabilityRegistry'
import { classifyModelError } from './modelClient/modelErrors'
import {
  LIST_CAPABILITIES_TOOL_NAME,
  READ_CAPABILITY_TOOL_NAME,
  formatListCapabilitiesResult,
  formatReadCapabilityResult,
  extractDiscoveredNameFromReadCapability,
} from './tools/capabilityDiscoveryTools'
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
 * （注：前端本地 loop 实际是全程复用同一条 assistant 消息、轮次在 runTurn 内递增——
 *  "每轮新建"是早期注释遗留，以代码为准。）
 */

export interface AgenticLoopCallbacks {
  /** 上下文装配完成（可选，用于 chatStore 更新 token 计数） */
  onContextAssembled?: (result: AssembleContextResult) => void
  /** 助手占位消息首次创建（整个 run 仅一次——全程复用同一条 assistant 消息，
   *  轮次信号请用 onTurnStart，不要在此计数） */
  onAssistantCreated: (assistant: ChatMessage) => void
  /** 每轮模型调用开始（turn 已递增；压缩续命 turn=0 重置后此回调仍按真实轮次继续触发，
   *  需要"已用轮数"语义的消费者应自行累计调用次数，不要直接用 turn 值） */
  onTurnStart?: (turn: number, maxTurns: number) => void
  /** 模型自然收尾判定（流正常结束且无工具调用待续跑）：运行体可在此 handle.supplement
   *  顶回（由随后的 supplementQueue 分支接住续跑）——Stop-hook 等价物挂点。
   *  错误/中断路径不会触发；turn 达上限时触发但顶回不会被消费（防假注入）。 */
  onTurnFinish?: (assistant: ChatMessage) => void
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
  /** 发现新工具（read_capability）时通知上层持久化 */
  onToolsDiscovered?: (names: string[]) => void
  /** 租约驱逐（2026-08-05）：预算不足被降回 deferred 的工具名，上层同步持久化移除 */
  onToolsEvicted?: (names: string[]) => void
  /** loop 收尾时回传最终租约表（小写名 → 最近使用时间戳），上层一次性持久化。
   *  续租在 loop 内高频发生，只在收尾落盘一次，避免每轮写存储。 */
  onLeasesUpdated?: (leases: Record<string, number>) => void
  /** 自动压缩开始（可选，UI 提示"正在压缩"） */
  onCompactStart?: (segmentCount: number) => void
  /** 自动压缩完成（boundary 轻标记：已压缩段消息数 / 保留段消息数） */
  onCompacted?: (info: { summarizedCount: number; keptCount: number; keptNonToolCount: number; summary: string }) => void
  /** 2026-07-31：自动压缩失败（含减半重试后仍失败）必须用户可见——否则进度条
   * 永远卡在"正在自动压缩…"，且失败被静默吞掉（熔断计数仅 console.warn）。 */
  onCompactFailed?: (info: { consecutiveFailures: number; maxFailures: number }) => void
  /** v9 双轨：补充在步骤间隙真正注入模型上下文后回调（上屏+持久化时机） */
  onSupplementInjected?: (text: string) => void
  /** 400 下行校准学到真实窗口（打磨任务7）：UI toast + store 刷新窗口值 */
  onWindowLearned?: (info: {
    learnedWindow: number
    userOverrideFalsified: boolean
    fromErrorMessage: boolean
  }) => void
  /** 上下文兜底动作的用户可见提示（如压缩熔断后的粗暴丢弃）——不弹错，但必须留痕 */
  onContextNotice?: (message: string) => void
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
  /** 实时读取最新权限模式（对话过程中切换即时生效）；缺省时回退到 executionMode 快照 */
  getExecutionMode?: () => ExecutionMode
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
  /** 发现工具的租约表（小写名 → 最近使用时间戳），与 initialDiscoveredToolNames 同源恢复；
   *  缺失的名字按 0（最老）处理——旧格式会话恢复后优先成为驱逐候选，方向安全 */
  initialToolLeases?: Map<string, number>
  /**
   * 压缩后重注入消息（对标 claude-code buildPostCompactMessages 的 attachments 槽位）。
   * 用途：子 Agent 任务原文 / 存活任务枚举等"承重状态"不应依赖压缩摘要的复述保真——
   * 由调用方提供，每次 autoCompact 回写时插在摘要之后、保留段之前。
   * 数组形态：内容须静态不变（如子 Agent 任务原文）；
   * 函数形态：每次压缩时重新求值（动态枚举，如后台子 Agent 存活状态——
   * 对齐 claude-code compact 后 task_status 附件，防重复派遣+防结果丢失）。
   * 重注入前按"role+首行"键控去重：上一次注入的消息若仍留在保留段会被最新版替换，
   * 避免连续压缩累积重复或残留过期状态（调用方保证首行是唯一标记）。
   */
  postCompactMessages?: Message[] | (() => Message[])
  /**
   * consult_state 写前门控豁免（2026-08-08 双 agent P0）：子 Agent 循环置 true——
   * 写前对账是主 loop 层职责（主 Agent 派遣写子任务前先自己对账），子 Agent 没有
   * 派遣工具，被拦后引导文案对它无解。缺省 false（主 loop 正常受门控）。
   */
  stateConsultExempt?: boolean
  /**
   * turn 级中断信号（2026-08-31 打断治理，对照 claude-code：query 消费 REPL 层 controller）。
   * 由 chatStore.sendMessage 在 isStreaming 置位时创建，loopAbortController 挂为其子——
   * 前置段（loop 句柄未创建）与 loop 期共用同一中断源，停止只需 abort 一处。
   * 子 Agent / DAG / webBridge 路径不传，行为不变。
   */
  turnSignal?: AbortSignal
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
  conversationId?: number | null,
  stateConsultExempt?: boolean
): ToolPermissionContext {
  return {
    mode,
    canBypass: false,
    // 会话级授权记忆（sessionGrants，当前无在用授权键，机制保留）
    grantedPermissions: getSessionGrants(conversationId),
    // consult_state 门控按会话匹配活跃状态任务；子 Agent 循环豁免（stateConsultExempt）
    conversationId,
    stateConsultExempt,
  }
}

function buildToolDefinitionsOptions(
  registry: FrontendToolRegistry,
  discoveredToolNames: Set<string>,
  providerConfig: ProviderConfig,
  toolLastUsedAt?: Map<string, number>,
  onEvict?: (names: string[]) => void,
  budgetChars?: number
) {
  const supportsDeferredLoading = providerSupportsDeferredLoading(
    providerConfig.provider,
    providerConfig.model
  )
  return {
    discoveredToolNames,
    toolLastUsedAt,
    onEvict,
    supportsDeferredLoading,
    budgetChars,
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
  /** 外部源（如子 Agent）新发现的工具名并入本 loop 发现集——同轮后续轮次即可注入，无需等新 loop */
  addDiscoveredTools: (names: string[]) => void
}

export function startAgenticLoop(options: AgenticLoopOptions): AgenticLoopHandle {
  const {
    userMessage,
    provider,
    apiKey,
    baseUrl,
    executionMode = 'auto',
    getExecutionMode,
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
    initialToolLeases,
    postCompactMessages,
    stateConsultExempt,
    turnSignal,
  } = options

  let aborted = false
  let streamAbort: (() => void) | null = null
  const loopAbortController = new AbortController()
  // turn 级信号联动：父 abort 传播到 loopAbortController（reason 透传）——
  // 在途工具子 controller 与 compact pipeline 全部联动取消。handle.abort() 的
  // 结算职责（合成孤儿 tool_result / 审批闸 / 渲染调度销毁）不经此路径，仍由
  // stopStreaming 显式调用，两处幂等互补。
  if (turnSignal) {
    if (turnSignal.aborted) {
      loopAbortController.abort(turnSignal.reason)
    } else {
      turnSignal.addEventListener(
        'abort',
        () => loopAbortController.abort(turnSignal.reason),
        { once: true }
      )
    }
  }

  // 是否真正由前端本地执行工具循环：
  // - enableFrontendToolLoop 为 true 且已注册前端本地工具
  // - provider 支持 function calling（本地模型、OpenAI 兼容云端模型、Anthropic 兼容云端模型）
  // - MESCLI Local + 云端 Provider 时，此前端 loop 优先于后端 SSE tool 事件
  // - MESCLI Online + frontend_loop_online 时，走 BackendProxyModelClient 由前端本地执行工具
  const providerSupportsTools = modelClientSupportsTools(provider.provider, provider.baseUrl)
  const useFrontendToolLoop = enableFrontendToolLoop && toolRegistry.list().length > 0 && providerSupportsTools

  // 权限模式解析：优先用 getExecutionMode 读实时值（用户可在对话过程中切换，
  // 与 claude-code 行为一致——每次工具权限检查都取当前模式），否则用启动快照。
  const resolveExecutionMode = (): ExecutionMode => getExecutionMode?.() ?? executionMode

  // 当前轮次的 assistant 消息。每轮工具调用后会新建一条，避免 tool_calls 跨轮串扰。
  let currentAssistant = createAssistantMessage(resolveExecutionMode())

  // P0-5a（2026-07-28）：本 loop 每轮实际发送的 assistant 序列，逐轮在 handleStreamDone 追加，
  // 终态挂上 ChatMessage.sentTurns 持久化——装配历史时按它展开，跨 turn 字节=实际发送序列。
  const sentTurns: NonNullable<ChatMessage['sentTurns']> = []

  // Fix6（2026-08-01 前缀缓存保真）：max_tokens 续写时 wire 上会插一条合成 user
  // （"请继续输出剩余内容"）但该消息不进 store——下轮重装配相邻 assistant 被 normalizer
  // 合并，字节与实发发散。这里在插入时挂起注记，下一轮 sentTurns.push 消费并记入
  // precededByUserNote，重装配时按原文补插（见 contextAssembler.expandSentTurns）。
  let pendingContinuationNote: string | null = null

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

  // 反问闸：ask_user 工具暂停等待用户作答，脊柱 clarify attention 卡承载交互。
  // 与审批不同——无条件创建（不需要外部回调，卡片由 builder 直接渲染）；
  // 无交互通道的环境（DAG/子 Agent）不会拿到此 gate，工具内 fail-soft。
  const clarifyNodeToToolCall = new Map<string, string>()
  const clarifyGate = createClarifyGate({
    onClarifyRequested: (request) => {
      const attentionNode = builder.requestAttention(
        request.question,
        'clarify',
        ASK_USER_TOOL_NAME,
        undefined,
        request.options,
        request.toolCallId,
        request.hints,
      )
      clarifyNodeToToolCall.set(attentionNode.id, request.toolCallId)
      syncRenderNodes()
      callbacks.onAssistantUpdate(cloneMessage(currentAssistant))
    },
  })

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
  // 已通过 read_capability 发现的延迟加载工具名（小写），后续轮次会注入上下文
  const discoveredToolNames = new Set<string>(initialDiscoveredToolNames ?? [])
  // 租约表（2026-08-05 租约式生命周期）：小写名 → 最近使用时间戳。
  // read_capability 注册=立约、实际调用=续租；预算不足时最老租约被状态性驱逐。
  const toolLeases = new Map<string, number>(initialToolLeases ?? [])
  for (const name of discoveredToolNames) {
    if (!toolLeases.has(name)) toolLeases.set(name, 0)
  }

  // 租约驱逐回写：registry 降回 deferred 后，同步 loop 内发现集/租约表并通知上层持久化
  const handleToolsEvicted = (names: string[]): void => {
    for (const name of names) {
      const lower = name.toLowerCase()
      discoveredToolNames.delete(lower)
      toolLeases.delete(lower)
    }
    callbacks.onToolsEvicted?.(names)
  }
  let modelSpanId: string | undefined

  // read_capability 单轮加载上限（2026-08-05 工具生命周期阶段 1）：
  // 替代原 tool_search 每轮 1 次/总会话 3 次的死限制（tool_search v1.6 起废弃不再注册）。
  // read_capability 是唯一发现入口，无上限时模型失控一轮刷几十个 read 会打爆
  // 工具 schema 预算并反复推动前缀缓存断点；10 与 MAX_CONCURRENT_TOOLS 对齐。
  let readCapabilityCallsThisTurn = 0
  const MAX_READ_CAPABILITY_PER_TURN = 10
  const MAX_CONSECUTIVE_IDENTICAL_TOOL_FAILURES = 3
  let lastToolFailureSignature = ''
  let consecutiveIdenticalToolFailures = 0

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

  // DSML 兜底（2026-08-24）：DeepSeek 系偶发把工具调用以 <｜｜DSML｜｜tool_calls> 标记
  // 写进正文 content（"先出正文再调工具"的混合轮高发）。流式过滤器把疑似标记段扣住
  // 不上屏，流结束时解析成结构化工具调用走正常工具循环；解析失败原文回落显示。
  // 每轮重置（resetToolState 内）。
  let dsmlFilter = createDsmlStreamFilter()

  // ── RenderNode builder（事件驱动单轨：EventLog + TurnProjector） ──
  // 2026-07-31 减法：旧 createRenderNodeBuilder 双轨开关退役（flag 硬编码 true，
  // false 分支永不可达），projectedBuilder 成为唯一事实路径。
  let builder: ProjectedBuilder = createProjectedBuilder()
  let projectedBuilder: ProjectedBuilder | null = builder

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

  // max_output_tokens 续写状态
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
      executionMode: resolveExecutionMode(),
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
      callbacks.onCompactFailed?.({
        consecutiveFailures: autoCompactFailures,
        maxFailures: MAX_AUTOCOMPACT_FAILURES,
      })
      return false
    }

    // 回写：system 前缀 + 摘要 user 消息 + （可选）压缩后重注入消息 + 保留段
    // 函数形态每次压缩重新求值（动态枚举存活子 Agent 等，对齐 claude-code task_status 附件）。
    // 重注入前按"role+首行"键控去重：上一次压缩注入的 pinned 消息若仍留在保留段，
    // 被最新版替换——静态原文逐字命中同旧逻辑；动态枚举淘汰过期状态行，
    // 避免连续压缩时重复累积。
    const pinned =
      typeof postCompactMessages === 'function' ? postCompactMessages() : (postCompactMessages ?? [])
    const pinnedKeys = new Set(pinned.map((p) => `${p.role}\n${p.content.split('\n', 1)[0]}`))
    const keptDeduped =
      pinned.length > 0
        ? kept.filter((m) => !pinnedKeys.has(`${m.role}\n${m.content.split('\n', 1)[0]}`))
        : kept
    currentMessages = [
      ...systemPrefix,
      { role: 'user', content: buildCompactContinuationContent(result.value) },
      ...pinned,
      ...keptDeduped,
    ]
    // 消息已整体替换，水位基准失效——下次退化为全量估算
    waterBaseTokens = undefined
    waterBaseIndex = 0
    autoCompactFailures = 0
    // keptNonToolCount：保留段中 user/assistant 消息数（tool 消息不存在于 store.messages，
    // store 侧定位切点需要按 store 可见消息数回数，2026-08-05 cutoff 修复）
    callbacks.onCompacted?.({
      summarizedCount: segment.length,
      keptCount: kept.length,
      keptNonToolCount: keptDeduped.filter((m) => m.role !== 'tool').length,
      summary: result.value,
    })
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
        executionMode: resolveExecutionMode(),
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
    dsmlFilter = createDsmlStreamFilter()
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
    if (!isRetry) callbacks.onTurnStart?.(turn, maxTurns)
    turnContentBuffer = ''
    turnReasoningBuffer = ''
    readCapabilityCallsThisTurn = 0
    resetToolState()

    // ── 每轮模型调用处理 RenderNode builder ──
    // R1: 一个用户 turn 只创建一次 builder；工具循环迭代复用同一 builder + 节点累积
    if (!isRetry) {
      if (isFirstModelCall) {
        isFirstModelCall = false
        builder = createProjectedBuilder(userMessage.id)
        projectedBuilder = builder
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
    // P0-6（2026-07-28）：工具预算裁剪显式通知。裁剪集合变化时 consumeBudgetDropNotice
    // 返回一次性文本，注入本请求轨迹末尾（副本，不动 currentMessages 本体）——
    // 模型能知道哪些工具被卸载、可经 grep /capabilities + read_capability 找回，而不是"工具不存在"裸死。
    const toolDefinitions = useFrontendToolLoop
      ? toolRegistry.toToolDefinitions(
          buildToolDefinitionsOptions(
            toolRegistry,
            discoveredToolNames,
            provider,
            toolLeases,
            handleToolsEvicted,
            // 预算随窗口百分比（2026-08-05 阶段 3）：1M 窗口→65536、256K→32000、≤128K→16000；
            // 每轮重算——400 下行校准学到真实窗口后 budgetChars 同步跟随
            computeToolBudgetChars(contextWindow)
          )
        )
      : undefined
    // P0-6（2026-07-28）：工具预算裁剪显式通知。裁剪集合变化时 consumeBudgetDropNotice
    // 返回一次性文本——模型能知道哪些工具被卸载、可经 grep /capabilities + read_capability 找回，
    // 而不是"工具不存在"裸死。
    // 2026-08-01 缓存审计：注入点从 messages[0] identity 段尾部挪到轨迹末尾（user 通知）。
    // 此前改 messages[0] = 从前缀位置 0 破缓存且下轮还原再破一次；尾部追加则当轮前缀仍可
    // 全量命中（claude-code 一次性通知=尾部 attachment 同款）。
    // Fix3+6 联动：通知推进 currentMessages 本体（后续轮次 wire 稳定携带），并挂起
    // pendingContinuationNote 记入 sentTurns——重装配时按原文补插，跨会话重放字节=实发字节；
    // 只做"副本注入"会让下轮 wire 丢掉这条通知，从该位置起前缀再断一次。
    const budgetNotice = useFrontendToolLoop ? toolRegistry.consumeBudgetDropNotice() : null
    if (budgetNotice !== null) {
      currentMessages.push({ role: 'user', content: budgetNotice })
      pendingContinuationNote = budgetNotice
    }
    const requestMessages = currentMessages

    const commonRequest: ModelClientRequest = {
      provider: provider.provider,
      model: provider.model,
      apiKey,
      baseUrl,
      conversationId,
      systemCode,
      messages: requestMessages,
      executionMode: resolveExecutionMode(),
      tools: toolDefinitions,
      // 思考强度（2026-09-04）：仅声明支持且用户显式选择过的模型带值，其余 undefined=不发送
      effort: resolveUserEffort(provider.provider, provider.model),
    }

    if (isLocalRuntime()) {
      // MESCLI Local 模式下，Anthropic 兼容 Provider（Kimi Code / Claude）在浏览器生产包中
      // 直接跨域调用会被 CORS 拦截；统一走后端 /api/chat/proxy，由后端转发。
      // tokenhub（腾讯 tokenhub.tencentmaas.com）同样不发 CORS 头（OPTIONS 预检 405），
      // 也必须走后端代理，否则浏览器直接拦死。
      const useBackendProxy =
        !IS_STANDALONE &&
        !isLocalModelProvider(provider.provider)

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
        // profile:<id> 后端不认识，翻译成 anthropic/custom（与代理路径同一规则；
        // 2026-09-07 审计补齐——原样透传会被 ProviderFactory 拒成 Unknown provider）
        provider: resolveProxyProviderId(commonRequest.provider),
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
  // 工具/错误/完成走快车道（立即冲刷）。公式：flushInterval = clamp(100, 100×√(pending/4), 250)ms
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

  /** 正文上屏唯一入口：累积缓冲 + 助手消息 + RenderNode answer。 */
  const appendVisibleContent = (text: string): void => {
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
        // 经 DSML 过滤器：疑似工具调用标记段被扣住不上屏，收尾时在 handleStreamDone 判定
        const visible = dsmlFilter.push(chunk.content || '')
        if (visible) appendVisibleContent(visible)
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
        // if (!isToolError && chunk.structuredData) {
        //   const hit = classifyArtifact(chunk.structuredData, { toolName, toolCallId: chunk.toolCallId || undefined })
        //   if (hit) {
        //     builder.addArtifact(hit.artifactType, hit.title, hit.payload, chunk.toolCallId || undefined)
        //   }
        // }
        // N-10: 工具完成走常规车道，与 content/reasoning 合批
        scheduler.noteEvent('tool_done')
        break
      }

      case 'approval_required': {
        if (useFrontendToolLoop) {
          // 前端本地 loop 已接管工具执行；后端 approval_required 由 toolExecutor 通过
          // /api/tools/execute 的 SSE 自行处理，避免重复注册 pendingApproval 导致 resolve 错位。
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
          // 前端本地 loop 已接管工具执行；后端 approval_result 与本地执行器无关，忽略。
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
        // 2026-07-31 进度动脉修复：此前前端 loop 的工具进度消息只进了无人消费的
        // onToolStdout 回调，瀑布流 ToolNode.executionLog 在默认路径下永远为空
        // （pip 安装、web 检索、webbridge 步骤全部静默）。统一写进节点日志。
        builder.appendToolLog(update.toolCallId, update.message)
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
    if (lowerToolName === READ_CAPABILITY_TOOL_NAME) {
      if (readCapabilityCallsThisTurn >= MAX_READ_CAPABILITY_PER_TURN) {
        const limitResult: ToolResult = {
          toolCallId,
          name: toolName,
          success: false,
          output: null,
          outputText: `read_capability 每轮最多加载 ${MAX_READ_CAPABILITY_PER_TURN} 个新工具。请优先使用本轮已加载的工具继续任务；确需更多工具时，在下一轮再调用 read_capability 加载。`,
          isTruncated: false,
          startedAt: Date.now(),
          endedAt: Date.now(),
          error: `read_capability 每轮最多加载 ${MAX_READ_CAPABILITY_PER_TURN} 个新工具`,
        }
        const promise = Promise.resolve(limitResult)
        inflightToolExecutions.set(toolCallId, promise)
        startedToolExecutions.add(toolCallId)
        return promise
      }
    }

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

    const startedAt = Date.now()

    if (lowerToolName === READ_CAPABILITY_TOOL_NAME) {
      readCapabilityCallsThisTurn++
    }

    // 租约续租（2026-08-05）：发现工具被实际调用即刷新最近使用时间——
    // 在用的工具永远是最新租约，LRU 驱逐只动最久未用的（I1 推论：工作集天然稳定）
    if (discoveredToolNames.has(lowerToolName)) {
      toolLeases.set(lowerToolName, Date.now())
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
        clarifyGate,
        permissionContext: buildPermissionContext(resolveExecutionMode(), conversationId, stateConsultExempt),
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
   * 判断结构化数据是否适合可视化为 artifact（与 renderNodeBuilder 内部逻辑保持一致）。
   */
  /**
   * 判断结构化数据是否应提升为产物卡。
   * 按 prototype-v3 设计：表格保留在 ToolNode 内联渲染（瀑布脊柱内），
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
          : // 失败也要带上工具给的结构化明细（如发布闸返回的 errors/ledger JSON）——
            // 只报一句错误总结，模型只能猜根因（2026-08-13 发布模具闸复盘）
            result.outputText && result.outputText !== result.error
              ? `执行失败: ${result.error}\n\n${result.outputText}`
              : `执行失败: ${result.error}`

      // persistedUrl 激活（2026-07-28，字段此前声明但无人消费）：工具结果已落盘时
      // 显式告知模型路径，引导用 read_file/grep/python 读回而非重复执行。
      // 截断文案/SQL note 已含路径时（includes 检查）不重复追加。
      if (
        !isCancelled &&
        result.success &&
        result.persistedUrl &&
        !resultText.includes(result.persistedUrl)
      ) {
        resultText += `\n\n[完整结果已保存到 ${result.persistedUrl}，可用 read_file（带 offset/limit 参数）分段阅读、grep 检索或 execute_python_script 交叉分析]`
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
            // 立约：新发现工具即最新租约，当轮必注入（I1）
            toolLeases.set(discoveredName, Date.now())
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
        // 2026-07-31 截断可见性：落盘/截断此前只写进给模型的 resultText，
        // 瀑布流摘要（120 字符头部）恰好把尾部指针裁掉——用户不知道全量在哪。
        let nodeSummary = resultText.slice(0, 120)
        if (result.isTruncated) {
          nodeSummary += result.persistedUrl
            ? `\n[结果过大已截断，全量已落盘：${result.persistedUrl}]`
            : `\n[结果过大已截断]`
        } else if (result.persistedUrl && !resultText.includes(result.persistedUrl)) {
          nodeSummary += `\n[全量已落盘：${result.persistedUrl}]`
        }
        builder.finishTool(result.toolCallId, {
          success: result.success,
          summary: nodeSummary,
          result: result.output,
        })
        // v4.0: 暂停自动产物分类，仅通过 present_artifact 工具显式呈现
        // if (result.success && result.output) {
        //   const hit = classifyArtifact(result.output, { toolName: result.name, toolCallId: result.toolCallId })
        //   if (hit) {
        //     builder.addArtifact(hit.artifactType, hit.title, hit.payload, result.toolCallId)
        //   }
        // }
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

  // P0-4（2026-07-28）：旧 tryCompressForRetry（loop 启动快照重装配，丢本轮工具成果）
  // 已删除，prompt_too_long 重试直接复用 tryAutoCompact(force=true)。

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

      // P0-4（2026-07-28 修复"重试丢成果"）：原实现 tryCompressForRetry 用 loop 启动时
      // 装配的快照重装配——本轮已累积的工具结果不在快照里，长任务最接近成功时撞 400
      // 会成果清空重来。改为复用 tryAutoCompact(force) 对 currentMessages 本体压缩：
      // system 前缀保留、尾部最近段（含本轮工具成果）原样保留，仅前段蒸成摘要。
      void (async () => {
        const compactedOnBody = await tryAutoCompact(true)
        if (aborted) return

        let shortened = compactedOnBody
        // 压缩不可用（熔断/可压缩段太短）时回退：粗暴丢弃最旧 2 条非 system 消息
        if (!compactedOnBody) {
          const crudely = compactMessagesForRetry(currentMessages)
          if (crudely.length < currentMessages.length) {
            const dropped = currentMessages.length - crudely.length
            currentMessages = crudely
            shortened = true
            // 2026-07-31 信息保真：粗暴丢弃是有损兜底，此前静默执行用户完全无感。
            // 留痕告知：早期内容已不可见，模型若"忘记"前文属预期行为。
            callbacks.onContextNotice?.(
              `上下文压缩暂不可用，已丢弃最旧的 ${dropped} 条消息以继续本轮对话（早期内容对模型不可见，必要时请重述关键信息）。`
            )
            // 消息已整体替换，水位基准失效——下次退化为全量估算
            waterBaseTokens = undefined
            waterBaseIndex = 0
          }
        }

        if (shortened) {
          promptTooLongRetries++
          const compacted = currentMessages

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
              remainingMessages: compacted.length,
              compressionUsed: compactedOnBody,
            })
          }

          runTurn(compacted, true)
        } else {
          // 无法再压缩，按普通错误处理
          handleFinalStreamError(error, modelError)
        }
      })()
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

    // ── DSML 兜底回收（2026-08-24）：判定流式期间被过滤器扣住的疑似标记段。
    // 解析成功 → 转成结构化 toolCalls（仅在本轮没有结构化调用时回收，不混两种通道），
    // 后续 shouldLoop/工具执行走既有路径；解析失败 → 原文回落为正文如实展示，不吞。
    // 注意必须在下方 sentTurns.push 之前完成，保证记入轨迹的正文是清理后的版本。
    const dsmlTail = dsmlFilter.finish()
    if (dsmlTail.trailingText) appendVisibleContent(dsmlTail.trailingText)
    if (dsmlTail.dsmlMarkup) {
      const hasStructuredCalls =
        !!currentAssistant.toolCalls && currentAssistant.toolCalls.length > 0
      const recovered =
        useFrontendToolLoop && !hasStructuredCalls
          ? parseDsmlToolCalls(dsmlTail.dsmlMarkup)
          : null
      if (recovered) {
        const now = Date.now()
        currentAssistant.toolCalls = recovered.map((call, index) => ({
          id: `dsml-${now}-${index}`,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        }))
        currentAssistant.status = 'calling_tools'
        if (builder.thinkingNode) builder.finishThinking()
        for (const tc of currentAssistant.toolCalls) {
          ensureToolPlaceholder(tc.id, tc.function.name)
          callbacks.onToolUpdate(tc.id, {
            toolCallName: tc.function.name,
            toolCallStatus: 'calling',
          })
          builder.startTool(tc.id, tc.function.name, tc.function.arguments)
        }
      } else {
        // 解析不出完整 invoke（或本轮已有结构化调用）：原文回落，标记不凭空消失
        appendVisibleContent(dsmlTail.dsmlMarkup)
      }
    }

    // R1 (N-02): 不在入口标 done/finishAnswer——只有 !shouldLoop 终止路径才标。
    // 工具循环和 max_tokens 续写路径中，当前 turn 仍在进行。

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
    // reasoning 回传（2026-08-25 每轮开头 400 根因）：thinking 模型要求同一工具链内的
    // 后续请求把本轮 assistant 的 reasoning_content 原样带回，缺失即确定性 400
    //（"must be passed back"）。reasoningContent 跨轮累计，wire 上只记本轮增量。
    const turnReasoning = currentAssistant.reasoningContent?.slice(lastTurnStartReasoningLength)
    if (turnReasoning) {
      assistantMessage.reasoningContent = turnReasoning
    }
    currentMessages.push(assistantMessage)

    // P0-5a（2026-07-28 历史保真）：逐轮记录实际发送序列到 ChatMessage.sentTurns
    // （快照拷贝——resetToolState 会重指 currentAssistant.toolCalls，不能留引用）。
    // 装配历史时按它展开，跨 turn 字节与实际发送完全一致（前缀缓存命中的总开关）。
    sentTurns.push({
      content: assistantMessage.content,
      ...(assistantMessage.reasoningContent
        ? { reasoningContent: assistantMessage.reasoningContent }
        : {}),
      ...(pendingContinuationNote !== null
        ? { precededByUserNote: pendingContinuationNote }
        : {}),
      ...(assistantMessage.toolCalls
        ? { toolCalls: assistantMessage.toolCalls.map((tc) => ({ ...tc })) }
        : {}),
    })
    pendingContinuationNote = null
    currentAssistant.sentTurns = [...sentTurns]

    if (modelSpanId) {
      const ttftMs = firstTokenTime ? firstTokenTime - turnStartTime : undefined
      traceCollector.completeSpan(modelSpanId, {
        finalContentLength: turnContentBuffer.length,
        turn,
        stopReason,
        ttftMs,
      })
    }

    // 自动结束未关闭的 tool span
    for (const [, spanId] of toolSpanMap) {
      const span = traceCollector.getSpan(spanId)
      if (span?.status === 'running') {
        traceCollector.completeSpan(spanId)
      }
    }

    // 流结束：强制刷出节流的末态，保证终态完整（且后续 maxTurns 提示/工具轮都基于最新显示）
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

      // 如果本轮助手已经发出 tool_calls，先执行并收集结果，再继续输出，避免 tool_calls 被"吃掉"
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
      // Fix6：挂起注记，下一轮 sentTurns.push 消费（保持重装配字节=实发字节）
      pendingContinuationNote = '请继续输出剩余内容'
      // v4.0: max_tokens 续写在同 round 内继续，round 已在 startRound 初始化
      // 清除 checkpoint 禁止 rewind：续写应保留本 round 已产出的 answer/thinking 事件
      eventLogCheckpoint = 0
      currentAssistant.isStreaming = true
      currentAssistant.status = 'thinking'
      callbacks.onAssistantUpdate(cloneMessage(currentAssistant))
      await runTurn(currentMessages, true)
      return
    }

    const toolCalls = currentAssistant.toolCalls || []

    // BUG-22: 同一轮次 ≥2 个工具调用归入同一 FlowGroup，视觉呈现并行组
    if (projectedBuilder && toolCalls.length >= 2) {
      const batchId = `parallel:${currentAssistant.id}:${turn}`
      for (const tc of toolCalls) {
        projectedBuilder.setToolGroupId(tc.id, batchId)
      }
      syncRenderNodes()
    }

    const shouldLoop = useFrontendToolLoop && toolCalls.length > 0 && turn < maxTurns

    // Stop-hook 等价物挂点（2026-08-03 五路盲猜实验 P0）：模型无工具调用自然收尾前，
    // 给运行体一个注入窗口（结构化输出未提交→supplement 顶回、收尾预警等）。
    // 只挂在终态判定处——onAssistantCreated 全程只触发一次，挂那里等于没挂。
    if (!shouldLoop && !aborted) {
      callbacks.onTurnFinish?.(currentAssistant)
    }

    // v9.1：自然终止前有 pending 补充 → 不闭幕，把补充注入后再跑一轮。
    // 否则补充只进了上下文却没有模型响应（用户看到"已注入"但无人回答）。
    // 对齐 claude-code：turn 结束时的排队消息会成为新的 turn，而不是被吞掉。
    // turn 达上限时不续跑：runTurn 入口会被 maxTurns 兜底直接返回，注入变"假注入"
    // （UI 显示已注入但模型从未回答）； queued 补充留待 chatStore.consumeQueueAfterTurn。
    if (!shouldLoop && supplementQueue.length > 0 && !aborted && turn < maxTurns) {
      applyPendingSupplements()
      currentAssistant.isStreaming = true
      currentAssistant.status = 'thinking'
      callbacks.onAssistantUpdate(cloneMessage(currentAssistant))
      await runTurn(currentMessages)
      return
    }

    if (!shouldLoop) {
      // ── R1 (N-02): 真正的终止路径——这里才标 done + finishAnswer ──
      builder.finishAnswer()
      syncRenderNodes()
      currentAssistant.isStreaming = false
      currentAssistant.status = currentAssistant.status === 'error' ? 'error' : 'done'

      // BUG-13b 已改由上方"pending 补充续跑一轮"处理——此处不再 flush，
      // 终止后仍待注入的补充由 chatStore.consumeQueueAfterTurn 转为排队下轮发送，
      // 避免"标记已注入却没有模型响应"的假注入。
      // 前端本地循环因达到最大轮次而终止时，给用户一个可感知的提示
      if (useFrontendToolLoop && toolCalls.length > 0 && turn >= maxTurns) {
        // 达上限时先尝试"压缩续命"一次：执行 pending 工具 → 压缩上下文 → 重置轮次继续。
        // 压缩腾出的不只是窗口，也让长任务不必在用户眼皮底下断掉。
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
              // v4.0: turn=0 后 runTurn() 会调 startRound 重置所有 per-round 标志
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
        // 压缩续命不可用：补齐 synthetic tool_result——否则带 toolCalls 的 assistant
        // 消息毒化历史，用户发"继续"时各 provider 会因 tool_use/tool_result 失配确定性 400
        synthesizeOrphanToolResults()
        const limitNote = `\n\n---\n*已达到本轮最大工具循环次数限制（${maxTurns} 轮），任务可能尚未完成。如需继续，请发送“继续”或进一步说明。*`
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

      const failedResults = toolResults.filter((result) => !result.success)
      if (failedResults.length === 1 && toolResults.length === 1) {
        const failed = failedResults[0]
        const signature = `${failed.name}:${failed.error || failed.outputText}`
        if (signature === lastToolFailureSignature) {
          consecutiveIdenticalToolFailures += 1
        } else {
          lastToolFailureSignature = signature
          consecutiveIdenticalToolFailures = 1
        }
      } else {
        lastToolFailureSignature = ''
        consecutiveIdenticalToolFailures = 0
      }

      if (
        consecutiveIdenticalToolFailures >=
        MAX_CONSECUTIVE_IDENTICAL_TOOL_FAILURES
      ) {
        currentAssistant.toolCalls = []
        currentAssistant.content =
          (currentAssistant.content || '') +
          '\n\n同一工具调用已连续失败 3 次，已停止自动重试。请检查工具参数或补充目标信息后重试。'
        builder.finishAnswer()
        syncRenderNodes()
        currentAssistant.isStreaming = false
        currentAssistant.status = 'done'
        callbacks.onAssistantUpdate(cloneMessage(currentAssistant))
        finalizeLoop()
        return
      }

      // 步骤间隙：注入用户过程中补充（§7 SupplementGateway）
      applyPendingSupplements()

      // 清理本轮执行状态，避免跨轮串扰
      inflightToolExecutions.clear()
      startedToolExecutions.clear()

      // v4.0: 下一轮 runTurn() 会调 startRound 重置所有 per-round 标志
      // R1 (N-02): 工具循环中保持 streaming 状态，直到真正终止
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

  /**
   * 从可能重复/嵌套的流式参数串中抢救出最长合法 JSON 对象/数组。
   * 已迁移到 toolCallNormalizer.ts，此处保留注释作为追溯。
   */

  const finalizeLoop = (): void => {
    stopWatchdog()
    // 终止时清零流式标志——内核 phase 才是终态的事实来源
    currentAssistant.isStreaming = false
    if (currentAssistant.status === 'thinking' || currentAssistant.status === 'streaming' || currentAssistant.status === 'calling_tools') {
      currentAssistant.status = 'done'
    }
    // BUG-10: 所有终止路径统一闭幕。phase 保护使重复调用无害。
    if (projectedBuilder) {
      projectedBuilder.settle()
    } else {
      builder.settle()
    }
    syncRenderNodes()
    // N-09: flush 必须在 destroy 之前——destroy 置 _destroyed=true 会使 flushNow() 变成 no-op，
    // 导致 turnPhase='settled' 永远无法推入 Zustand store，"已完成" 永远不显示。
    flushAssistantDisplay()
    // 租约表收尾落盘（2026-08-05）：loop 内高频续租只在内存，收尾一次性回传持久化。
    // 只回传仍存活的租约（被驱逐的已在 handleToolsEvicted 中删除）。
    callbacks.onLeasesUpdated?.(Object.fromEntries(toolLeases))
    // BUG-19: 销毁调度器，释放 visibilitychange 监听器（放在最后，确保末态已推入 store）
    scheduler.destroy()
    traceCollector.complete('对话完成')
    callbacks.onDone(cloneMessage(currentAssistant))
  }

  const handleFatalError = (error: Error): void => {
    // 与 handleFinalStreamError 保持一致的清理逻辑
    stopWatchdog()
    synthesizeOrphanToolResults()

    // N-08: 销毁调度器，释放 visibility 监听
    scheduler.destroy()
    currentAssistant.isStreaming = false
    currentAssistant.status = 'error'
    currentAssistant.errorMessage = error.message
    // BUG-06: turnAbort('error') 自行将 answer streaming→stopped + answerStatus→error
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
    // BUG-21 残余: 通知 builder 标记工具为 cancelled（而非 done）
    builder.cancelTool(toolCallId)
    // N-10: 工具取消走常规车道（取消也是终态，可合批）
    scheduler.noteEvent('tool_done')
    callbacks.onToolUpdate(toolCallId, {
      content: '用户已中断',
      toolCallStatus: 'cancelled',
    })
  }

  const abort = (): void => {
    aborted = true
    stopWatchdog()
    // ── RenderNode: 用户停止 → answer 标为 stopped，其余闭幕 ──
    // BUG-05: stopAnswer() emit turn.abort 已自行闭幕所有节点；
    // 不再追加 turn.settle，避免 phase 从 stopped 被覆盖为 settled。
    if (builder.answerNode && builder.answerNode.status === 'streaming') {
      builder.stopAnswer()
    } else {
      // 没有流式 answer 时（如纯工具阶段停止），手动追加 turn.abort
      if (projectedBuilder) {
        projectedBuilder.eventLog.append(eventFactory.turnAbort('user'))
      }
    }
    syncRenderNodes()
    // N-09: flush 必须在 destroy 之前——destroy 置 _destroyed=true 会使 flushNow() 变成 no-op，
    // 导致 turnPhase='stopped' 永远无法推入 Zustand store。
    flushAssistantDisplay()
    // 用户主动中断时，为已发出但尚未返回结果的 tool_use 生成 synthetic tool_result，
    // 避免后续请求出现 tool_use / tool_result 失配。
    synthesizeOrphanToolResults()
    streamAbort?.()
    loopAbortController.abort()
    approvalGate?.abort()
    // 反问闸同链兜底：挂起中的 clarify 卡逐张关闭，工具以"用户中断"结算不悬挂
    clarifyGate.abort()
    for (const nodeId of clarifyNodeToToolCall.keys()) {
      builder.resolveAttention(false, '用户中断', nodeId)
    }
    syncRenderNodes()
    // N-08: 销毁调度器（含清空缓冲），避免 ghost flush + 释放 visibility 监听（放在最后）
    scheduler.destroy()
  }

  const supplement = (text: string): void => {
    if (aborted) return
    supplementQueue.push(text)
  }

  /** v9 双轨：撤回尚未注入的补充。只移除队列中第一个匹配项（FIFO 语义与注入顺序一致） */
  const unsupplement = (text: string): boolean => {
    const idx = supplementQueue.indexOf(text)
    if (idx === -1) return false
    supplementQueue.splice(idx, 1)
    return true
  }

  // BUG-17: clarify/approval 回调统一入口——关闭 attention 卡片 + 可选注入选择值到上下文
  const resolveAttention = (nodeId: string, resolved: boolean, value?: string): void => {
    if (aborted) return
    // 关闭 builder 中的 attention 节点（按 nodeId 精确寻址）
    builder.resolveAttention(resolved, value, nodeId)
    syncRenderNodes()
    // ask_user 挂起分流：答案经反问闸作为 tool result 返回模型，不走 supplement 通道
    // （supplementQueue 只在 loop 边界消费，无法解锁中途挂起的工具）
    const clarifyToolCallId = clarifyNodeToToolCall.get(nodeId)
    if (clarifyToolCallId) {
      clarifyNodeToToolCall.delete(nodeId)
      if (resolved && value) {
        clarifyGate.resolve(clarifyToolCallId, value)
      }
      return
    }
    // 如果用户选了具体选项，作为补充注入到模型上下文
    if (value) {
      supplementQueue.push(value)
    }
  }

  run()
  return {
    abort,
    cancelTool,
    supplement,
    unsupplement,
    resolveAttention,
    addDiscoveredTools: (names: string[]) => {
      // 子 Agent 发现回流：同轮并入主 loop 发现集 + 立约（最新租约）
      for (const n of names) {
        const lower = n.toLowerCase()
        discoveredToolNames.add(lower)
        toolLeases.set(lower, Date.now())
      }
    },
  }
}

function cloneMessage(m: ChatMessage): ChatMessage {
  return { ...m }
}
