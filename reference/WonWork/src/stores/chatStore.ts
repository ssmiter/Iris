import { create } from 'zustand'
import type { Message, StreamChunk, ProviderConfig, FileAttachmentDto } from '@/types/mescli'
import type { ChatMessage, ThinkingProcessData } from '@/types/chat'
import { chatApi, historyApi, userConfigApi, toolApi, API_BASE } from '@/api/client'
import { useLocalModelStore } from '@/stores/localModelStore'
import { useMemoryStore } from '@/stores/memoryStore'
import { useAuthStore } from '@/stores/authStore'
import { useContextPanelStore } from '@/stores/contextPanelStore'
import { useSettingsStore } from '@/stores/settingsStore'
import type { ExecutionMode } from '@/agent/types'
import { useFileStore } from '@/stores/fileStore'
import { useWebBridgeStore } from '@/stores/webbridgeStore'
import { useWorkflowExecutionAgentStore } from '@/stores/workflowExecutionAgentStore'
import { runDagWorkflowAsAgent } from '@/utils/dagWorkflowExecutionAgent'
import { safeStringify } from '@/utils/safeSerialize'
import type { DagWorkflow, DagExecutionContext } from '@/types/dagWorkflow'
import { useDagWorkflowStore } from '@/stores/dagWorkflowStore'
import { useQuotaStore } from '@/stores/quotaStore'
import { useLicenseStore } from '@/stores/licenseStore'
import { useApiKeyStore } from '@/stores/apiKeyStore'
import { useTokenHubStore } from '@/stores/tokenHubStore'
import { websiteCloudApi } from '@/api/websiteCloudApi'
import {
  getWebBridgeSystemPrompt,
  extractWebBridgeWorkflow,
  extractWebBridgeWorkflowSafe,
  sanitizeControlCharacters,
  buildWebBridgeResultMessage,
  getWebBridgeSummaryPrompt,
  getWebBridgeRetryPrompt,
  buildWebBridgeRetryMessage,
} from '@/utils/webbridgePrompt'
import { loadWebBridgePreset } from '@/types/webbridge'
import { getFormattingPrompt } from '@/utils/formattingPrompt'
import { getRuntimeMode, isLocalRuntime } from '@/utils/runtimeMode'
import { buildCapabilityRegistry } from '@/utils/capabilityRegistry'
import { updateTasksFromText, removeTaskTags } from '@/utils/taskExtractor'
import { useSkillStore } from '@/stores/skillStore'
import { estimateContextTokens } from '@/utils/tokenEstimator'
import { resolveContextWindow, type WindowSourceLabel } from '@/services/modelCapabilityRegistry'
import { getProviderKeyEntry, setProviderKeyEntry } from '@/services/providerKeyVault'
import { ensureToolResultPairing } from '@/agent/modelClient/messageNormalizer'
import {
  buildSystemPromptSections,
  buildMemorySection,
  buildSkillSections,
  sectionsToMessages,
} from '@/utils/systemPromptBuilder'
import { supportsLocalModel } from '@/config/product'
import { PPT_TEMPLATES, buildPptTemplatePrompt } from '@/data/pptTemplates'
import { toast } from 'sonner'
import { getErrorMessage, isAbortError } from '@/utils/error'
import { useConversationStore } from '@/stores/conversationStore'
import { useConversationTitleStore } from '@/stores/conversationTitleStore'
import { generateConversationTitle, isDefaultTitle } from '@/utils/conversationTitle'
import {
  generateSessionTitle,
  abortSessionTitleGeneration,
} from '@/agent/pipelines/sessionTitle'
import { generateSqlExplainSummary } from '@/agent/pipelines/approvalExplain'
import { isSqlWriteOperation } from '@/agent/pipelines/approvalExplain/sqlClassifier'
import { createTraceCollector } from '@/agent/traceCollector'
import { createToolRegistry } from '@/agent/toolRegistry'
import { createToolExecutor } from '@/agent/toolExecutor'
import { startAgenticLoop } from '@/agent/agenticLoop'
import { classifyModelError } from '@/agent/modelClient/modelErrors'
import type { ApprovalRequest } from '@/agent/types'
import type { AgenticLoopHandle } from '@/agent/agenticLoop'
import { setFileHistorySession, makeFileSnapshot, applyFileSnapshot, remapSnapshot } from '@/services/fileHistory'
import { viewStateGet, viewStateSet } from '@/api/viewState'
import { registerStandaloneTools, registerFilePrimitives, registerWebTools, createToolSearchTool, createListCapabilitiesTool, createReadCapabilityTool } from '@/agent/tools'
import { applyBackendToolOverrides } from '@/agent/backendToolOverrides'
import { compressMessages } from '@/services/contextCompression'
import { useSessionToolStore } from '@/stores/sessionToolStore'
import { addSessionGrant, PROJECT_WRITE_GRANT } from '@/agent/sessionGrants'

const IS_STANDALONE = import.meta.env.VITE_STANDALONE_MODE === 'true'

function isLocalModelProvider(provider: string): boolean {
  return provider === 'ollama' || provider === 'lmstudio' || provider === 'webllm'
}

/**
 * 从官网拉取 TokenHub Key 明文并加密缓存到本地。
 *
 * 供两处使用：
 * 1. resolveProviderCredentials —— 本地无缓存时的首次获取
 * 2. handleTokenHubAuthError —— 推理 401（Key 被回收/套餐变更）后的自动重揭
 *
 * reveal 接口限频每用户每小时 10 次，调用方需控制触发频率（401 一次只重试一次）。
 */
async function fetchAndCacheTokenHubKey(): Promise<{ apiKey: string; baseUrl: string; model: string }> {
  const [planRes, revealRes, keyMetaRes] = await Promise.all([
    websiteCloudApi.getCurrentPlan(),
    websiteCloudApi.revealTokenHubKey(),
    // key meta 接口带 endpointId（plan/current 的 tokenHub 不一定返回），失败不阻塞主流程
    websiteCloudApi.getTokenHubKeyMeta().catch(() => null),
  ])
  const info = planRes.plan?.tokenHub
  if (!info || !revealRes.key) {
    throw new Error('无法获取 TokenHub Key，请确认已购买套餐或联系客服')
  }

  // 推理时 model 字段必须是腾讯端点 ID（ep-xxxx），不能是套餐模型名（wonwork-flash）；
  // 官网 plan/current 暂未返回 endpointId，优先取 key meta 的。
  const endpointId = keyMetaRes?.key?.endpointId || info.endpointId
  if (!endpointId) {
    throw new Error('TokenHub 端点 ID 缺失，请在设置页点击"重新获取 Key"或联系客服')
  }

  await useTokenHubStore.getState().saveKey({
    apiKeyId: revealRes.apiKeyId,
    key: revealRes.key,
    keyHint: `sk-tp-•••${revealRes.key.slice(-4)}`,
    model: info.model,
    endpointId,
    baseUrl: info.baseUrl,
    monthlyTokenQuota: info.monthlyTokenQuota,
    status: 'active',
    activatedAt: new Date().toISOString(),
  })

  return {
    apiKey: revealRes.key,
    baseUrl: info.baseUrl,
    model: endpointId,
  }
}

/**
 * TokenHub 推理 401 自动恢复：
 * 清除本地缓存 Key（可能已被官网回收/轮换）→ 重新 reveal 并缓存。
 * 成功返回 true（下一次发送将使用新 Key）；失败返回 false（引导购买/联系客服）。
 *
 * 注意：不自动重发消息——重新 reveal 成功后提示用户重新发送即可，
 * 避免在 onError 回调中重入 sendMessage 造成消息重复。
 */
async function handleTokenHubAuthError(): Promise<boolean> {
  const tokenHubStore = useTokenHubStore.getState()
  tokenHubStore.clear()
  try {
    await fetchAndCacheTokenHubKey()
    return true
  } catch {
    return false
  }
}

/**
 * 统一解析当前 provider 的调用凭据。
 *
 * - tokenhub：从加密缓存读取 sk-tp-...，无缓存时调用官网 reveal 接口并缓存。
 * - 本地模型：使用 localModelStore 配置。
 * - 其他：优先使用 BYOK 默认 Key，否则请求后端 /api/userconfig/{provider}/apikey。
 *
 * 同时在 activeKeySource 记录来源，供 UI 展示"当前在用哪把钥匙"
 * （三套密钥来源并存调试期，用户需要一眼看清）。
 */
async function resolveProviderCredentials(
  provider: ProviderConfig
): Promise<{ apiKey?: string; baseUrl: string; model: string }> {
  const setSource = (source: string | null) =>
    useChatStore.setState({ activeKeySource: source })

  if (isLocalModelProvider(provider.provider)) {
    const localConfig = useLocalModelStore.getState().config
    setSource('本地模型')
    return {
      apiKey: localConfig.apiKey || undefined,
      baseUrl: provider.baseUrl,
      model: provider.model,
    }
  }

  if (provider.provider === 'tokenhub') {
    const cached = await useTokenHubStore.getState().revealKey()
    // 老缓存可能缺 endpointId（plan/current 未返回时写入的），
    // 此时 model 会退化成套餐模型名（wonwork-flash）导致腾讯 200+JSON 错误体，必须重新拉取
    if (cached && cached.endpointId) {
      setSource('TokenHub 套餐')
      return {
        apiKey: cached.key,
        baseUrl: cached.baseUrl,
        model: cached.endpointId,
      }
    }
    setSource('TokenHub 套餐')
    return fetchAndCacheTokenHubKey()
  }

  let apiKey: string | undefined
  let baseUrl: string | undefined = provider.baseUrl
  let source: string | null = null

  const defaultByok = useApiKeyStore.getState().getDefaultApiKey('chat')
  if (defaultByok && !defaultByok.isPlatformManaged && defaultByok.key) {
    apiKey = defaultByok.key
    baseUrl = defaultByok.baseUrl
    source = `BYOK（${defaultByok.name || defaultByok.provider}）`
  } else {
    // 本地保险柜优先于后端 userconfig：Key 是"本机用户"的凭据，与登录哪个后端无关。
    // 修复：website-online 配置的 kimi-code Key 登录 mescli-online 后"消失"（后端换了一台、
    // localStorage 换作用域），模型看似不回答。保险柜全局存储，一次配置跨模式可用。
    const vaultEntry = getProviderKeyEntry(provider.provider)
    if (vaultEntry?.apiKey) {
      apiKey = vaultEntry.apiKey
      if (vaultEntry.baseUrl) baseUrl = vaultEntry.baseUrl
      source = '自配 API（本机）'
    }
    try {
      const keyResult = await userConfigApi.getApiKey(provider.provider)
      if (keyResult.apiKey) {
        // 后端取到 Key：若保险柜没有则回写自愈（下次换模式/换后端不再丢）
        if (!apiKey) {
          apiKey = keyResult.apiKey
          source = '自配 API（设置页）'
          setProviderKeyEntry(provider.provider, { apiKey: keyResult.apiKey })
        }
      }
    } catch {
      // 忽略，让后端使用默认配置
    }
  }

  if (getRuntimeMode() === 'mescli-local' && !isLocalModelProvider(provider.provider)) {
    try {
      const cfg = await userConfigApi.getConfig(provider.provider)
      if (cfg.baseUrl) {
        baseUrl = cfg.baseUrl
      }
    } catch {
      // 忽略，使用 provider 默认 baseUrl
    }
  }

  // 前端未取到 key 时，后端代理还会依次尝试：AiUserConfig → appsettings 全局
  setSource(source ?? '后端配置（未在前端取到 Key）')
  return { apiKey, baseUrl: baseUrl || provider.baseUrl, model: provider.model }
}

export type { ChatMessage, ThinkingProcessData }

/** 对话分支变体（v9.1）：同一锚点用户消息的一次"重新发问"及其后续对话线 */
export interface BranchVariant {
  id: string
  /** 该变体锚点用户消息的文本 */
  text: string
  /** 活跃时该变体锚点消息在 messages 中的 id（切换/渲染定位用） */
  anchorMsgId?: string
  /** 从锚点用户消息开始的分支尾部快照（renderNodes 已剥离，恢复走 legacy 渲染） */
  tail: ChatMessage[]
}

/** 对话分支锚点：一条被编辑重发过的用户消息及其全部变体 */
export interface BranchAnchor {
  /** 锚点 key（首个变体锚点消息的 id） */
  anchorId: string
  /** 锚点匹配文本（水合时按内容找回锚点） */
  anchorText: string
  /** 锚点时刻的文件快照键（首个变体锚点消息 id；水合后 remap 到新 id） */
  snapshotMsgId?: string
  variants: BranchVariant[]
  active: number
}

/** 同一锚点允许的最大分支变体数（v9.4：2 → 5；变体尾巴是完整快照，需控制存储） */
const MAX_BRANCH_VARIANTS = 5

/**
 * 压缩边界（v9.2/v9.4）：历史不动，只标记"context 从哪算起"——一条"压缩线"。
 * 多条边界按 cutoffTs 形成多段；第 0 条线 = 链表头（无压缩，全原始上下文）。
 * branchPath 仅作产生时的记录信息；适用判定走位置语义（见 selectActiveBoundary）。
 */
export interface CompactBoundary {
  id: string
  /** 摘要文本（context 起点背景） */
  summary: string
  /** 切点：此时间戳及之前的消息被摘要覆盖（之后原样保留进 context） */
  cutoffTs: number
  trigger: 'manual' | 'auto'
  /** 压缩前的消息条数（标记展示用） */
  coveredCount: number
  /** 产生时的分支路径签名（记录用，不参与适用判定） */
  branchPath: string
  at: number
}

/** 当前活跃分支路径签名（边界隔离的匹配键） */
export function currentBranchPath(branches: Record<string, BranchAnchor>): string {
  return Object.values(branches)
    .map((a) => `${a.anchorId}:${a.active}`)
    .sort()
    .join('|')
}

/**
 * 活路径上的最早分叉点时间戳：只看锚点消息仍在当前消息链上的锚点
 * （被截掉的死锚点不参与）。无分叉 → +∞。
 */
function earliestLiveDivergenceTs(
  messages: ChatMessage[],
  branches: Record<string, BranchAnchor>
): number {
  let min = Infinity
  for (const a of Object.values(branches)) {
    const anchorMsgId = a.variants[a.active]?.anchorMsgId ?? a.anchorId
    const msg = messages.find((m) => m.id === anchorMsgId)
    if (msg) min = Math.min(min, msg.timestamp || 0)
  }
  return min
}

/**
 * 压缩线位置语义（v9.4）：分叉点落在哪条线之后，就用哪条线。
 * - 适用 = 所有 cutoffTs 早于"活路径最早分叉点"的边界（分叉在切点后 →
 *   切点前的内容对该分支是共享前缀，摘要有效；分叉在切点前 → 该线不适用，
 *   此分支用更原始的线）。
 * - 多线时取 cutoffTs 最新的适用边界（摘要逐级累积，最新一条覆盖全部此前内容）。
 * - 无适用边界 = 第 0 条线：全原始上下文。
 * 分支隔离由此自然成立：切点前分叉的分支自动落回更早的线。
 */
export function selectActiveBoundary(
  messages: ChatMessage[],
  boundaries: CompactBoundary[],
  branches: Record<string, BranchAnchor>
): CompactBoundary | null {
  if (boundaries.length === 0) return null
  const divTs = earliestLiveDivergenceTs(messages, branches)
  const applicable = boundaries.filter((b) => b.cutoffTs < divTs)
  if (applicable.length === 0) return null
  return applicable.reduce((a, b) => (b.cutoffTs > a.cutoffTs ? b : a))
}

/**
 * context 装配：应用压缩线位置语义选中的边界——
 * 切点及之前的消息整体替换为摘要背景消息，之后原样保留。
 */
function applyCompactBoundary(
  history: ChatMessage[],
  boundaries: CompactBoundary[],
  branches: Record<string, BranchAnchor>
): ChatMessage[] {
  const latest = selectActiveBoundary(history, boundaries, branches)
  if (!latest) return history
  const kept = history.filter((m) => (m.timestamp || 0) > latest.cutoffTs)
  if (kept.length >= history.length) return history
  // 与 pipelines/compactSummary 的 buildCompactContinuationContent 同文案（此处内联避免模块环）
  const summaryMsg: ChatMessage = {
    id: `compact-bg-${latest.id}`,
    role: 'user',
    content: `本次对话因上下文长度限制进行了压缩。以下是此前对话的摘要，覆盖了压缩前的全部内容。

摘要：
${latest.summary}

请直接从摘要中断处继续工作，不要向用户确认、不要复述摘要内容、不要以"我继续"之类的寒暄开头——就像中断从未发生一样，接着完成未完成的任务。`,
    timestamp: latest.cutoffTs,
    status: 'done',
  }
  return [summaryMsg, ...kept]
}

interface PendingApproval extends ApprovalRequest {
  resolve: (approved: boolean, reason?: string) => void
  status: 'pending' | 'approved' | 'rejected' | 'expired'
}

// 审批超时定时器（模块级，全局共享）
const approvalTimers = new Map<string, ReturnType<typeof setTimeout>>()
function clearApprovalTimer(toolCallId: string): void {
  const t = approvalTimers.get(toolCallId)
  if (t) { clearTimeout(t); approvalTimers.delete(toolCallId) }
}

/**
 * 分支快照：完整保留结构信息（renderNodes/rounds/工具结果等）。
 * 历史上曾剥离 renderNodes 靠 legacyToRenderNodes 重建，但重建丢失工具结果与
 * 轮次编组，导致切分支后工具调用无法展开——对话是一棵树，快照必须完整。
 */
function stripForBranch(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({ ...m }))
}

/** 分支记录持久化（v9.4：IndexedDB conversationViews，旧 localStorage 数据在水合时迁移） */
function persistBranches(convId: number | null, branches: Record<string, BranchAnchor>): void {
  if (convId == null) return
  viewStateSet(`branches-${convId}`, Object.values(branches))
}
function scheduleApprovalTimer(toolCallId: string, expiresAt: number): void {
  clearApprovalTimer(toolCallId)
  const delay = Math.max(expiresAt - Date.now(), 1000)
  approvalTimers.set(toolCallId, setTimeout(() => {
    useChatStore.getState().expireToolCall(toolCallId)
  }, delay))
}

interface ChatState {
  messages: ChatMessage[]
  isLoading: boolean
  isStreaming: boolean
  error: string | null

  providers: ProviderConfig[]
  activeProvider: ProviderConfig | null
  /** 当前对话凭据来源（TokenHub 套餐 / BYOK / 自配 API / 后端配置） */
  activeKeySource: string | null

  currentContextTokens: number
  contextWindowSize: number
  /** 窗口值来源：user=用户设置 / learned=运行中学到 / api=模型列表 / guess=名字猜测（估算） */
  contextWindowSource: WindowSourceLabel

  lastAssistantWorkflowJson: unknown | null
  pendingSecurityPreset: string | null

  pptTemplateSelection: {
    isPending: boolean
    content: string
    attachmentIds?: string[]
  } | null

  /** 用于序列化 loadMessages 请求，旧请求不会覆盖新请求或用户已发送的消息 */
  loadMessagesSeq: number

  /** 权限模式会话级覆盖（打磨任务2 S1）：null = 跟随设置页全局默认 */
  permissionMode: ExecutionMode | null

  /** M3 审批闸：待审批工具调用列表 */
  pendingApprovals: PendingApproval[]

  /** 排队消息：运行中 Enter 提交，turn 结束后 FIFO 消费为新 user turn（v9 双轨之一） */
  queuedMessages: Array<{ id: string; text: string }>
  /** 待注入补充：运行中 Ctrl+Enter 提交，步骤间隙注入当前 turn；注入前可撤回（v9 双轨之二） */
  pendingSupplements: Array<{ id: string; text: string; injected: boolean }>

  loadMessages: (conversationId: number) => Promise<void>

  sendMessage: (content: string, attachmentIds?: string[], pptTemplate?: { id: string; name: string; toolValue: string; index: number }) => Promise<void>
  /** 过程中补充：在模型工作中发送额外指令，将于步骤间隙注入（§7 SupplementGateway） */
  sendSupplement: (text: string) => void
  /** 撤回尚未注入的补充（v9：注入前可取消） */
  cancelSupplement: (id: string) => void
  /** 移除已注入的补充条目（chip 绿色态 1.6s 后自动消失用；不影响已上屏气泡） */
  dismissSupplement: (id: string) => void
  /** 排队一条消息，turn 结束后自动发送（v9） */
  queueMessage: (text: string) => void
  /** 从队列移除（chip ✕） */
  dequeueMessage: (id: string) => void
  /** 弹出最后一条排队消息文本供输入框回收（↑ 键，claude-code popAllEditable 单条版） */
  popLastQueued: () => string | undefined
  /** 清空排队与待注入（/clear 用；待注入未注入的直接丢弃） */
  clearQueueAndSupplements: () => void
  /** turn 结束后的队列消费（内部：onDone/onError/stopStreaming 调用） */
  consumeQueueAfterTurn: () => void
  /** 对话分支（v9.1）：锚点用户消息 id → 分支记录 */
  branches: Record<string, BranchAnchor>
  /** 编辑锚点用户消息并重发：当前分支尾部快照保存，截断后以新文本开新分支 */
  resendEditedMessage: (anchorId: string, newText: string) => Promise<void>
  /** 切换分支（delta ±1）：当前变体快照更新后换成目标变体尾部 */
  switchBranch: (anchorKey: string, delta: number) => void
  /**
   * 压缩边界（v9.2）：历史完全不动，边界只决定"context 从哪算起"。
   * branchPath 绑定产生时的分支路径——切到别的分支不受影响，切回来恢复。
   */
  compactBoundaries: CompactBoundary[]
  /** 压缩进行中（manual / auto 共用同一条进度条） */
  compactProgress: { trigger: 'manual' | 'auto'; startedAt: number } | null
  /** 运行中触发 /compact → 本轮结束后自动执行（claude-code 排队语义） */
  pendingCompactAfterTurn: string | null
  /** 取消进行中的手动压缩（进度条 ✕） */
  cancelCompact: () => void
  /** 主动压缩上下文（/compact）：与 autoCompact 同一语义——只改 context 起点，不动历史 */
  compactConversation: (userInstructions?: string) => Promise<void>
  /** WebBridge 斜杠命令主体（/web save|run|list|policy|<自然语言>） */
  runWebCommand: (body: string) => Promise<void>
  stopStreaming: () => void
  cancelToolCall: (toolCallId: string) => void
  /** BUG-17: 解决脊柱上的 attention 卡片（审批/澄清），可选注入选择值到模型上下文 */
  resolveAttention: (nodeId: string, value?: string, resolved?: boolean) => void

  runWebBridgeFromAssistant: (
    jsonText: string,
    assistantMessageId: string,
    originalUserContent: string,
    conversationId: number
  ) => Promise<void>
  requestWebBridgeWorkflowFromLlm: (
    userContent: string,
    conversationId: number,
    assistantMessageId: string
  ) => Promise<string | null>
  summarizeWebBridgeResults: (
    workflowName: string,
    results: unknown[],
    originalUserContent: string,
    conversationId: number
  ) => Promise<void>

  requestPptTemplateSelection: (content: string, attachmentIds?: string[]) => void
  confirmPptTemplateSelection: (templateId: string) => void
  cancelPptTemplateSelection: () => void

  runDagWorkflowAsAgent: (workflow: DagWorkflow, inputs?: Record<string, unknown>) => Promise<void>

  setActiveProvider: (provider: ProviderConfig) => void
  /** 注册表学习到新窗口值后重算（P2 自愈链路调用） */
  refreshContextWindow: () => void
  /** 设置会话级权限模式覆盖（打磨任务2 S1） */
  setPermissionMode: (mode: ExecutionMode | null) => void
  setProviders: (providers: ProviderConfig[]) => void
  setContextTokens: (tokens: number) => void

  appendAssistantMessage: (content: string) => Promise<void>

  /** 手动刷新会话标题（基于最近对话内容重新生成） */
  refreshConversationTitle: (conversationId?: number) => Promise<void>

  clearError: () => void
  clearMessages: () => void
  setLoading: (value: boolean) => void
  setStreaming: (value: boolean) => void
  setMessageFeedback: (messageId: string, feedback: 'like' | 'dislike' | null) => void

  /** M3 审批闸：添加/批准/拒绝待审批工具调用 */
  addPendingApproval: (request: PendingApproval) => void
  approveToolCall: (toolCallId: string, reason?: string) => void
  rejectToolCall: (toolCallId: string, reason?: string) => void
  expireToolCall: (toolCallId: string) => void
  clearPendingApprovals: () => void
  /** 更新指定审批请求的 SQL 影响解释（approval_explain 结果） */
  updateApprovalSqlExplain: (toolCallId: string, summary: string) => void
  /** 为指定 SQL 写操作审批请求请求模型解释（用户点击触发） */
  requestSqlExplain: (toolCallId: string) => Promise<void>
}

let currentAbortController: (() => void) | null = null
let currentLoopHandle: AgenticLoopHandle | null = null
/** 手动压缩的取消句柄（cancelCompact / 切会话时 abort） */
let compactAbortController: AbortController | null = null

const toolTaskIdMap = new Map<string, string>()

function clearToolTaskMap() {
  toolTaskIdMap.clear()
}

function getToolTaskTitle(toolName: string): string {
  const titleMap: Record<string, string> = {
    web_search: '正在联网搜索...',
    create_word_document: '正在生成 Word 文档...',
    create_excel_document: '正在生成 Excel 表格...',
    create_pptx_document: '正在生成 PPT 文稿...',
  }
  return titleMap[toolName] || (toolName ? `执行工具：${toolName}` : '正在执行生成任务...')
}

function formatWorkflowOutputValue(value: unknown): string {
  if (value && typeof value === 'object' && 'downloadUrl' in value) {
    const v = value as { downloadUrl: string; fileName?: string }
    const fileName = v.fileName || '下载文件'
    const url = v.downloadUrl.startsWith('http')
      ? v.downloadUrl
      : `${API_BASE.replace(/\/$/, '')}${v.downloadUrl}`
    return `[${fileName}](${url})`
  }
  if (typeof value === 'string') return value
  return safeStringify(value, 400)
}

interface WorkflowFileOutput {
  downloadUrl: string
  fileName: string
  sourceNodeId?: string
}

function collectWorkflowFileOutputs(ctx: DagExecutionContext): WorkflowFileOutput[] {
  const files: WorkflowFileOutput[] = []
  const seen = new Set<string>()

  const addValue = (value: unknown, sourceNodeId?: string, depth = 0) => {
    if (depth > 3) return
    if (Array.isArray(value)) {
      const limit = Math.min(value.length, 50)
      for (let i = 0; i < limit; i++) {
        addValue(value[i], sourceNodeId, depth + 1)
      }
      return
    }
    if (!value || typeof value !== 'object') return
    if (!('downloadUrl' in value) || typeof (value as Record<string, unknown>).downloadUrl !== 'string') {
      return
    }
    const v = value as { downloadUrl: string; fileName?: string }
    const url = v.downloadUrl.startsWith('http')
      ? v.downloadUrl
      : `${API_BASE.replace(/\/$/, '')}${v.downloadUrl}`
    if (seen.has(url)) return
    seen.add(url)
    files.push({ downloadUrl: url, fileName: v.fileName || '下载文件', sourceNodeId })
  }

  const outputs = ctx.nodeOutputs.get('__outputs__') as Record<string, unknown> | undefined
  if (outputs) {
    Object.values(outputs).forEach((v) => addValue(v))
  }

  for (const [nodeId, value] of ctx.nodeOutputs.entries()) {
    if (nodeId === '__outputs__') continue
    addValue(value, nodeId)
  }

  return files
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

const streamingContentBuffers = new Map<string, string>()
const streamingFlushTimers = new Map<string, number>()
const streamingFirstTokenFlushed = new Map<string, boolean>()
const STREAMING_FLUSH_INTERVAL = 200

function flushStreamingContent(assistantId: string, set: (fn: (state: ChatState) => ChatState | Partial<ChatState>) => void) {
  const buffer = streamingContentBuffers.get(assistantId)
  if (!buffer) return

  streamingContentBuffers.delete(assistantId)
  streamingFlushTimers.delete(assistantId)

  set((state) => {
    const messages = [...state.messages]
    const assistantIndex = messages.findIndex((m) => m.id === assistantId)
    if (assistantIndex === -1) return state

    const assistant = { ...messages[assistantIndex] }
    assistant.content += buffer
    assistant.status = 'streaming'
    processAssistantTasks(assistant)

    messages[assistantIndex] = assistant
    return { messages }
  })
}

function scheduleStreamingFlush(assistantId: string, set: (fn: (state: ChatState) => ChatState | Partial<ChatState>) => void) {
  if (streamingFlushTimers.has(assistantId)) return

  const timer = window.setTimeout(() => {
    streamingFlushTimers.delete(assistantId)
    flushStreamingContent(assistantId, set)
  }, STREAMING_FLUSH_INTERVAL)

  streamingFlushTimers.set(assistantId, timer)
}

/**
 * 流式内容写入 buffer。
 * 首 token 立即 flush，后续 token 按 STREAMING_FLUSH_INTERVAL 批量刷新，
 * 兼顾首 token 即时渲染和后续高频 chunk 的渲染性能。
 */
function appendStreamingContent(
  assistantId: string,
  content: string,
  set: (fn: (state: ChatState) => ChatState | Partial<ChatState>) => void
) {
  streamingContentBuffers.set(
    assistantId,
    (streamingContentBuffers.get(assistantId) || '') + content
  )

  const isFirstToken = !streamingFirstTokenFlushed.get(assistantId)
  if (isFirstToken) {
    streamingFirstTokenFlushed.set(assistantId, true)
    flushStreamingContent(assistantId, set)
    return
  }

  scheduleStreamingFlush(assistantId, set)
}

function clearStreamingState(assistantId: string) {
  streamingContentBuffers.delete(assistantId)
  streamingFlushTimers.delete(assistantId)
  streamingFirstTokenFlushed.delete(assistantId)
}

function processAssistantTasks(assistant: ChatMessage) {
  const panelStore = useContextPanelStore.getState()

  const newTasks = updateTasksFromText(panelStore.tasks, assistant.content)
  if (newTasks.length > 0) {
    panelStore.setTasks(newTasks)
    // 不自动弹出面板（用户手动控制）
    assistant.content = removeTaskTags(assistant.content)
  }
}

function finalizeTaskPanel(finalStatus: 'completed' | 'error') {
  const { tasks, setTasks } = useContextPanelStore.getState()
  if (tasks.length === 0) return
  const hasOpen = tasks.some((t) => t.status === 'running' || t.status === 'pending')
  if (!hasOpen) return
  setTasks(
    tasks.map((t) =>
      t.status === 'running' || t.status === 'pending' ? { ...t, status: finalStatus } : t
    )
  )
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isLoading: false,
  isStreaming: false,
  error: null,
  providers: [],
  activeProvider: null,
  activeKeySource: null,
  currentContextTokens: 0,
  // 初始默认值与 tokenEstimator.MODEL_CONTEXT_WINDOW 对齐（256K，2026-07-24 统一）；
  // 实际值在 setActiveProvider/refreshContextWindow 时由 resolveContextWindow 覆盖
  contextWindowSize: 256000,
  contextWindowSource: 'guess',
  lastAssistantWorkflowJson: null,
  pendingSecurityPreset: null,
  pptTemplateSelection: null,
  loadMessagesSeq: 0,
  permissionMode: null,
  pendingApprovals: [],
  queuedMessages: [],
  pendingSupplements: [],
  branches: {},
  compactBoundaries: [],
  compactProgress: null,
  pendingCompactAfterTurn: null,

  loadMessages: async (conversationId) => {
    const seq = get().loadMessagesSeq + 1
    // 切换会话：压缩状态完全隔离——中止在途压缩、清空边界/进度/待执行标记，
    // 新会话从干净状态开始（目标会话的边界由下方水合恢复）
    compactAbortController?.abort()
    compactAbortController = null
    set({
      loadMessagesSeq: seq,
      isLoading: true,
      compactBoundaries: [],
      compactProgress: null,
      pendingCompactAfterTurn: null,
    })
    setFileHistorySession(conversationId)
    try {
      const messages = await historyApi.getMessages(conversationId)
      const chatMessages = messages.map((m) => {
        let structuredData = m.structuredData
        if (typeof structuredData === 'string' && structuredData) {
          try {
            structuredData = JSON.parse(structuredData)
          } catch {
            // 单条消息 structuredData 解析失败不应阻断整页加载
          }
        }
        // RenderNodes 防御性解析：IndexedDB 存对象，但后端 History API 返回 JSON 字符串
        let renderNodes = (m as any).renderNodes
        if (typeof renderNodes === 'string' && renderNodes) {
          try {
            renderNodes = JSON.parse(renderNodes)
          } catch {
            renderNodes = undefined
          }
        }
        return {
          ...m,
          renderNodes,
          id: generateId(),
          // 保留原消息时间，避免切换对话后所有历史消息都变成当前时间戳
          timestamp: (m as any).createdAt
            ? new Date((m as any).createdAt).getTime()
            : Date.now(),
          content: m.role === 'assistant' ? removeTaskTags(m.content || '') : m.content,
          structuredData,
        }
      })
      // 毒化历史修复： dangling toolCalls / orphan tool_result 会在下次发送时
      // 触发 provider 确定性 400（尤其 Online 代理链路）。加载时做一次配对修复：
      // orphan 结果剔除、缺失结果补齐 synthetic（新消息补 id/timestamp）。
      const pairedMessages = (ensureToolResultPairing(chatMessages) as ChatMessage[]).map((m) => ({
        ...m,
        id: m.id || generateId(),
        timestamp: m.timestamp || Date.now(),
      }))
      const estimate = estimateContextTokens(pairedMessages, undefined, get().contextWindowSize)

      // 仅当没有更新请求（切换会话、新发送消息）时才应用结果
      if (get().loadMessagesSeq !== seq) {
        set({ isLoading: false })
        return
      }

      // 压缩边界水合（v9.4）：IndexedDB 优先，旧 localStorage 记录自动迁移。
      // 历史完全不动，只载入边界列表；视图在切点画分隔标记，context 装配按位置语义选线。
      let hydratedBoundaries: CompactBoundary[] = []
      try {
        const fromDb = await viewStateGet<CompactBoundary[]>(`compacts-${conversationId}`)
        if (fromDb && fromDb.length > 0) {
          hydratedBoundaries = fromDb
        } else {
          const rawList = localStorage.getItem(`ww-compacts-${conversationId}`)
          if (rawList) hydratedBoundaries = JSON.parse(rawList) as CompactBoundary[]
          const legacy = localStorage.getItem(`ww-compact-${conversationId}`)
          if (legacy) {
            const old = JSON.parse(legacy) as { summary: string; cutoffTs: number; at?: number }
            if (old.summary) {
              hydratedBoundaries.push({
                id: `cb-legacy-${old.cutoffTs}`,
                summary: old.summary,
                cutoffTs: old.cutoffTs,
                trigger: 'manual',
                coveredCount: 0,
                branchPath: '',
                at: old.at ?? old.cutoffTs,
              })
            }
            localStorage.removeItem(`ww-compact-${conversationId}`)
          }
          if (rawList || legacy) {
            localStorage.removeItem(`ww-compacts-${conversationId}`)
            viewStateSet(`compacts-${conversationId}`, hydratedBoundaries)
          }
        }
      } catch {
        hydratedBoundaries = []
      }
      let hydratedMessages: ChatMessage[] = pairedMessages
      let hydratedTokens = estimate.used

      // 对话分支水合（v9.4：IndexedDB 优先，旧 localStorage 迁移）：按锚点变体文本
      // 找回锚点（首个匹配处截断 DB 线性历史），接回活跃分支尾部（含 renderNodes 完整结构）；
      // 文件快照 remap 到新锚点 id 保持回滚可用
      set({ branches: {} })
      try {
        let anchors = await viewStateGet<BranchAnchor[]>(`branches-${conversationId}`)
        if (!anchors || anchors.length === 0) {
          const rawBranches = localStorage.getItem(`ww-branches-${conversationId}`)
          if (rawBranches) {
            anchors = JSON.parse(rawBranches) as BranchAnchor[]
            localStorage.removeItem(`ww-branches-${conversationId}`)
            viewStateSet(`branches-${conversationId}`, anchors)
          }
        }
        if (anchors && anchors.length > 0) {
          let msgs = hydratedMessages
          const restored: Record<string, BranchAnchor> = {}
          for (const a of anchors) {
            let idx = -1
            for (let i = 0; i < msgs.length; i++) {
              const m = msgs[i]
              if (m.role === 'user' && !m.isSupplement && a.variants.some((v) => v.text === m.content)) {
                idx = i
                break
              }
            }
            if (idx === -1) continue
            const active = Math.min(a.active, a.variants.length - 1)
            const target = a.variants[active]
            const remappedTail = (target.tail.length > 0 ? target.tail : msgs.slice(idx)).map((m) => ({ ...m }))
            if (remappedTail[0]) remappedTail[0] = { ...remappedTail[0], content: target.text }
            msgs = [...msgs.slice(0, idx), ...remappedTail]
            const newAnchorMsgId = remappedTail[0]?.id ?? a.anchorId
            if (a.snapshotMsgId && a.snapshotMsgId !== newAnchorMsgId) {
              void remapSnapshot(a.snapshotMsgId, newAnchorMsgId)
            }
            restored[a.anchorId] = {
              ...a,
              active,
              snapshotMsgId: newAnchorMsgId,
              variants: a.variants.map((v, i) => (i === active ? { ...v, anchorMsgId: newAnchorMsgId } : v)),
            }
          }
          if (Object.keys(restored).length > 0) {
            hydratedMessages = msgs
            hydratedTokens = estimateContextTokens(msgs, undefined, get().contextWindowSize).used
            set({ branches: restored })
          }
        }
      } catch {
        // 分支记录损坏时按无分支处理
      }

      set({
        messages: hydratedMessages,
        currentContextTokens: hydratedTokens,
        compactBoundaries: hydratedBoundaries,
        isLoading: false,
      })

      // 打开会话时：如果标题仍是默认且已有对话内容，自动刷新一次标题。
      // 标记为已尝试，避免每次切换都刷新；失败静默。
      const titleStore = useConversationTitleStore.getState()
      const titleState = titleStore.getTitleState(conversationId, useConversationStore.getState().getCurrentConversation()?.title)
      const hasAttempted = titleStore.hasAutoRefreshAttempted(conversationId)
      const hasDialogueMessages = pairedMessages.some((m) => m.role === 'user' || m.role === 'assistant')
      if (titleState === 'default' && !hasAttempted && hasDialogueMessages) {
        titleStore.markAutoRefreshAttempted(conversationId)
        get().refreshConversationTitle(conversationId)
      }
    } catch (err) {
      if (get().loadMessagesSeq !== seq) return
      const msg = getErrorMessage(err, '加载消息失败')
      set({
        error: msg,
        isLoading: false,
      })
      toast.error(msg)
    }
  },

  sendMessage: async (content, attachmentIds, pptTemplate) => {
    // ===== Agentic Trace 收集器 =====
    // 正常对话流程中由 agenticLoop 内部调用 startTrace；
    // 此处提前声明，供早期返回路径（登录失败、remember、配额等）使用。
    const traceCollector = createTraceCollector()

    const { isLoggedIn } = useAuthStore.getState()
    if (!isLoggedIn) {
      set({ error: '请先登录后再发送消息' })
      traceCollector.startTrace(content, 'chat', { attachmentCount: attachmentIds?.length || 0 })
      traceCollector.fail('用户未登录')
      return
    }

    // ===== 斜杠命令统一分发（v9 命令注册表）=====
    // 本地命令（/export /remember /compact /model /clear /help）不依赖 provider，
    // 故分发放在 provider 检查之前；/web 走 ctx.runWebCommand 回到本 store。
    if (content.startsWith('/')) {
      const { dispatchSlashCommand } = await import('@/agent/commands/dispatcher')
      const result = await dispatchSlashCommand(content, {
        appendAssistantMessage: get().appendAssistantMessage,
        setActiveProvider: get().setActiveProvider,
        providers: get().providers,
        createConversation: async () => {
          const id = await useConversationStore.getState().createConversation()
          // /clear 语义：新会话 + 清空当前消息视图与水位（原来只切 id 不清视图，用户感知"没反应"）
          if (id != null) {
            get().clearMessages()
            set({ currentContextTokens: 0, error: null })
          }
          return id
        },
        clearQueueAndSupplements: get().clearQueueAndSupplements,
        compactConversation: get().compactConversation,
        runWebCommand: get().runWebCommand,
        isStreaming: get().isStreaming,
      })
      // 'handled' = 已处理；'keep-input' = 缺参数（理论上 InputArea 已拦截，这里兜底同 handled）
      if (result) return
    }

    const state = get()
    let provider = state.activeProvider

    if (!provider) {
      set({ error: '请先选择 LLM 提供商' })
      return
    }

    if (IS_STANDALONE && supportsLocalModel && typeof navigator !== 'undefined' && !navigator.onLine) {
      if (!isLocalModelProvider(provider.provider)) {
        const localModelStore = useLocalModelStore.getState()
        await localModelStore.detect()
        const localProvider = localModelStore.getDefaultProviderConfig()
        if (localProvider) {
          provider = localProvider
        } else {
          set({ error: '当前处于离线状态，且未检测到可用本地模型（Ollama / LM Studio），请启动本地模型后重试。' })
          return
        }
      }
    }

    const fileStore = useFileStore.getState()
    const pendingSnapshot = attachmentIds
      ? fileStore.pendingAttachments.filter((a) => attachmentIds.includes(a.id))
      : []

    let conversationId = useConversationStore.getState().currentConversationId
    if (!conversationId) {
      conversationId = await useConversationStore.getState().createConversation()
      if (!conversationId) return
    }

    const quotaStore = useQuotaStore.getState()
    if (quotaStore.isExhausted()) {
      const license = useLicenseStore.getState().license
      const tier = license?.tier || 'free'
      if (tier === 'free') {
        set({ error: '当月 Token 额度已用完，请升级套餐继续使用。' })
        return
      }
    }

    if (pendingSnapshot.length > 0) {
      await fileStore.commitPendingFiles(conversationId, attachmentIds, pendingSnapshot)
    }

    const messageAttachments = pendingSnapshot.length > 0
      ? pendingSnapshot.map((a) => ({ ...a, conversationId }))
      : undefined

    const workspaceUploads = messageAttachments
      ?.filter((att) => att.isWorkspaceUpload && att.type !== 'image')
      .map((att) => ({
        path: att.workspacePath || '',
        mimeType: att.mimeType,
        sizeBytes: att.size,
        createdAt: att.createdAt,
      }))
      .filter((u) => u.path) ?? []

    const imageBlocks = messageAttachments
      ?.filter((att) => att.isWorkspaceUpload && att.type === 'image')
      .map((att) => ({
        path: att.workspacePath || '',
        mimeType: att.mimeType,
      }))
      .filter((u) => u.path) ?? []

    const structuredData =
      workspaceUploads.length > 0 || imageBlocks.length > 0
        ? {
            workspaceUploads,
            imageBlocks,
          }
        : undefined

    const userMessage: ChatMessage = {
      id: generateId(),
      role: 'user',
      content,
      timestamp: Date.now(),
      attachments: messageAttachments,
      structuredData,
    }

    // 递增序列号，使任何仍在进行中的 loadMessages 结果不会覆盖刚发送的消息
    set((s) => ({
      loadMessagesSeq: s.loadMessagesSeq + 1,
      messages: [...s.messages, userMessage],
      isLoading: true,
      isStreaming: true,
      error: null,
    }))

    // 文件检查点（v9.1）：以本条用户消息为键打文件快照，支撑分支回滚
    setFileHistorySession(conversationId)
    void makeFileSnapshot(userMessage.id)

    // 持久化用户消息到前端本地存储
    historyApi
      .saveMessage(conversationId, userMessage)
      .catch((err) => console.error('保存用户消息失败:', err))

    // 预计算截断兜底标题，但不立即持久化；等 LLM 生成失败后再写入。
    // 这样刷新页面后不会留下截断标题，而是保留 LLM 生成的语义标题或默认标题。
    const fallbackTitle = generateConversationTitle(content)
    const conversationStore = useConversationStore.getState()
    const currentConversation = conversationStore.getCurrentConversation()

    const recallResults = await useMemoryStore.getState().recall({
      text: content,
      strategy: 'hybrid',
      top_k: 5,
    })
    let memoryPrompt = ''
    if (recallResults.length > 0) {
      memoryPrompt =
        '\n\n以下是与当前话题相关的背景记忆（仅作为参考）：\n' +
        recallResults.map((r) => `- [${r.entry.type}] ${r.entry.content}`).join('\n')
    }

    const skillStore = useSkillStore.getState()
    const activeSkills = skillStore.getActiveSkillsForMessage(content)
    const manualSkills = skillStore.activeSkillIds
      .map((id) => skillStore.skills.find((s) => s.id === id))
      .filter(Boolean) as typeof activeSkills
    const allActiveSkills = [...new Set([...activeSkills, ...manualSkills])]
    const skillPrompts = allActiveSkills.map(
      (s) => `## [Skill: ${s.name}]\n${s.prompt}`
    )

    const mode = getRuntimeMode()
    const webBridgeStatus = useWebBridgeStore.getState().status
    const { isMesLoggedIn } = useAuthStore.getState()

    // 工具镜像需要提前创建，以便注入 system prompt 的工具使用说明
    const systemCode = isLocalRuntime()
      ? 'local'
      : localStorage.getItem('wonclaw_system_code') || undefined
    const toolRegistry = createToolRegistry({ systemCode })
    let frontendLoopOnline = false
    let domainInsight: string | undefined

    if (IS_STANDALONE) {
      // Standalone：仅前端本地原语
      registerStandaloneTools(toolRegistry, systemCode)
    } else {
      // MESCLI Local / Online：从会话级缓存加载后端能力目录，避免每条消息重复请求
      try {
        const { tools: catalog, features, domainInsight: insight } = await useSessionToolStore
          .getState()
          .ensureSessionTools(
            conversationId,
            mode,
            systemCode,
            async () => {
              const capabilities = await toolApi.capabilitiesFull(
                isLocalRuntime() ? 'local' : systemCode
              )
              return {
                tools: capabilities.tools || [],
                features: capabilities.features || [],
                domainInsight: capabilities.domainInsight,
              }
            }
          )
        domainInsight = insight
        // 每轮都根据（缓存或新拉的）features 重算，避免缓存命中时开关被跳过而回落旧 ChatService
        if (!isLocalRuntime()) {
          frontendLoopOnline = features.includes('frontend_loop_online')
        }
        if (catalog.length > 0) {
          toolRegistry.loadFromCatalog(catalog)
          // 后端目录只有静态元数据；为风险随输入变化的工具附加动态权限检查
          applyBackendToolOverrides(toolRegistry)
        }
      } catch (err) {
        console.warn('[chatStore] 加载后端能力清单失败，回退到仅本地原语:', err)
      }

      if (isLocalRuntime()) {
        // MESCLI Local：前端本地原语 + 能力发现原语；后端目录已有时不要覆盖
        registerStandaloneTools(toolRegistry, systemCode, { skipExisting: true })
        // MESCLI 模式下写操作走后端 Workspace API，需进入审批流；后端目录已有时不要覆盖
        registerFilePrimitives(toolRegistry, true, { skipExisting: true })
      } else {
        // MESCLI Online：仅注册能力发现原语，MES 业务工具由后端执行
        toolRegistry.register(createListCapabilitiesTool({ systemCode, registry: toolRegistry }))
        toolRegistry.register(createReadCapabilityTool({ systemCode, registry: toolRegistry }))
        toolRegistry.register(createToolSearchTool({ systemCode, registry: toolRegistry }))
        // MESCLI Online 同样启用完整文件原语，写操作走后端审批；后端目录已有时不要覆盖
        registerFilePrimitives(toolRegistry, true, { skipExisting: true })
      }
    }

    // Web 工具（web_search / web_fetch）按 daemon 连接状态统一注册；
    // daemon 可用时本地实现优先覆盖后端目录中的同名工具，避免走付费/后端实现。
    registerWebTools(toolRegistry)

    const initialDiscoveredToolNames = useSessionToolStore
      .getState()
      .getDiscoveredNames(conversationId)
    // MES 后端已经同时提供 /api/chat/proxy 与 /api/tools/execute，统一使用前端工具循环。
    // capabilities 的会话缓存可能来自旧网关版本，不能因为缓存中暂时缺少 feature
    // 就回落到传统 ChatService，否则同一浏览器会出现空助手消息且跨轮确认上下文丢失。
    const enableFrontendToolLoop = isLocalRuntime() || frontendLoopOnline || !IS_STANDALONE
    const toolExecutor = createToolExecutor(toolRegistry)

    const registry = buildCapabilityRegistry({
      mode,
      webBridgeStatus,
      isMesLoggedIn,
    })

    // 构建结构化 system prompt sections（按职责分段，便于截断与 DevTools 观察）
    const systemSections = await buildSystemPromptSections(registry, toolRegistry, {
      systemCode,
      domainInsight,
    })

    // 记忆 section
    const memorySection = memoryPrompt
      ? buildMemorySection(
          '以下是与当前话题相关的背景记忆（仅作为参考）：\n' +
            recallResults.map((r) => `- [${r.entry.type}] ${r.entry.content}`).join('\n')
        )
      : null

    // skill sections（仅 Standalone 模式由前端注入；MESCLI 模式后端处理）
    const skillSections = IS_STANDALONE ? buildSkillSections(skillPrompts) : []

    // 工具镜像与执行器已在上文提前创建

    // 提前解析 provider 凭据，供上下文压缩、标题生成与 Agentic Loop 使用
    let credentials: { apiKey?: string; baseUrl: string; model: string }
    try {
      credentials = await resolveProviderCredentials(provider)
    } catch (err) {
      const msg = getErrorMessage(err, '获取模型调用凭据失败')
      toast.error(msg)
      set({ error: msg, isLoading: false, isStreaming: false })
      return
    }

    // MESCLI Local 下使用云端 Provider 时必须已有 API Key，否则无法直连 LLM
    if (
      mode === 'mescli-local' &&
      !isLocalModelProvider(provider.provider) &&
      !credentials.apiKey
    ) {
      const msg = '本地模式使用云端模型需要配置 API Key，请在设置中填写'
      toast.error(msg)
      set({ error: msg, isLoading: false, isStreaming: false })
      return
    }

    const runtimeProvider: ProviderConfig = {
      ...provider,
      model: credentials.model,
      baseUrl: credentials.baseUrl,
    }

    // 异步 LLM 增强会话标题（失败静默，已有截断兜底）
    if (currentConversation && isDefaultTitle(currentConversation.title)) {
      generateSessionTitle(
        {
          messages: [{ role: 'user', content }],
          attachmentNames: messageAttachments?.map((a) => a.name) ?? [],
        },
        conversationId,
        {
          provider: runtimeProvider,
          apiKey: credentials.apiKey,
          baseUrl: credentials.baseUrl,
          conversationId,
          systemCode,
          executionMode: get().permissionMode ?? useSettingsStore.getState().permissionMode,
          enableFrontendToolLoop,
        },
        { autoOnly: true }
      )
        .then(() => {
          // LLM 成功生成语义标题，标记为自动生成
          useConversationTitleStore.getState().markAutoGenerated(conversationId)
        })
        .catch(() => {
          // LLM 生成失败时，回退到截断兜底标题
          const latestConversation = conversationStore.getCurrentConversation()
          if (latestConversation && isDefaultTitle(latestConversation.title)) {
            conversationStore.updateConversationTitle(conversationId, fallbackTitle)
          }
        })
    }

    // 上下文装配：按 token 预算组装最终请求消息
    // history 中已包含刚追加的 userMessage，需排除后再由装配器重新追加，避免重复
    // 这里只传递装配选项，由 agenticLoop 在内部装配（支持 prompt_too_long 时重新装配并压缩）
    const assembleOptions = {
      systemSections: memorySection
        ? [...systemSections, memorySection, ...skillSections]
        : [...systemSections, ...skillSections],
      history: applyCompactBoundary(
        get().messages.slice(0, -1),
        get().compactBoundaries,
        get().branches
      ),
      contextWindow: get().contextWindowSize,
      reserveTokens: 4096,
      useFrontendContextBudget: true,
      compressor: async (messages: Message[]) =>
        compressMessages({
          messages,
          provider: runtimeProvider,
          apiKey: credentials.apiKey,
          baseUrl: credentials.baseUrl,
        }),
    }

    // ===== Agentic Loop 起点 =====
    useContextPanelStore.getState().clearTasks()
    clearToolTaskMap()

    let currentAssistantId = ''
    // Standalone 模式下需要持久化的 tool 消息 ID，避免同一 tool 消息被重复保存
    const persistedToolCallIds = new Set<string>()
    // 本轮循环中创建的所有 assistant 消息 ID（包括工具调用中间轮次的 assistant），
    // onDone 时统一持久化，确保切换会话后工具调用 renderNodes 不丢失。
    const loopAssistantIds: string[] = []

    currentLoopHandle = startAgenticLoop({
      userMessage,
      provider: runtimeProvider,
      apiKey: credentials.apiKey,
      baseUrl: credentials.baseUrl,
      // 会话级覆盖 ?? 设置页全局默认（打磨任务2 S1，原硬编码 'auto'）
      executionMode: get().permissionMode ?? useSettingsStore.getState().permissionMode,
      conversationId,
      systemCode,
      assembleOptions,
      traceCollector,
      toolRegistry,
      toolExecutor,
      enableFrontendToolLoop,
      initialDiscoveredToolNames,
      maxTurns: 100,
      callbacks: {
        onContextAssembled: (assembled) => {
          set({ currentContextTokens: assembled.usedTokens })
        },
        onChunk: (chunk) => {
          // 循环内水位 UI：usage 到达时用真实 token 数刷新（此前循环开始后就不更新）
          if (chunk.type === 'usage' && typeof chunk.usage?.tokensIn === 'number') {
            set({
              currentContextTokens:
                chunk.usage.tokensIn + (chunk.usage.cacheReadTokens ?? 0),
            })
          }
        },
        onCompactStart: (_segmentCount) => {
          // v9.2：与手动压缩共用同一条进度条（对话框上方），不再 toast 打扰
          set({ compactProgress: { trigger: 'auto', startedAt: Date.now() } })
        },
        onWindowLearned: ({ learnedWindow, userOverrideFalsified, fromErrorMessage }) => {
          // 400 下行校准（打磨任务7）：注册表已写入，刷新 store 窗口值并告知用户
          get().refreshContextWindow()
          const k = (learnedWindow / 1000).toFixed(0)
          if (userOverrideFalsified) {
            toast.warning(
              `你设置的上下文窗口超过该模型实测上限，已自动调整为 ${k}K 并压缩重试（可在设置中重新修改）`
            )
          } else if (fromErrorMessage) {
            toast.info(`上下文超限，已学习该模型窗口上限 ${k}K，正在压缩重试…`)
          } else {
            toast.info(`上下文超限，正在压缩重试…`)
          }
        },
        onCompacted: ({ summarizedCount, summary }) => {
          // v9.2：自动压缩同样落一条边界——历史不动，视图在切点画分隔标记，
          // 后续发送的 context 装配从边界重算（摘要+保留段），刷新后仍生效。
          const msgs = get().messages
          const cutoffTs = msgs[msgs.length - 1]?.timestamp ?? Date.now()
          const branchPath = currentBranchPath(get().branches)
          const boundary: CompactBoundary = {
            id: `cb-${Date.now()}`,
            summary,
            cutoffTs,
            trigger: 'auto',
            coveredCount: summarizedCount,
            branchPath,
            at: Date.now(),
          }
          const boundaries = [...get().compactBoundaries, boundary]
          set({
            compactBoundaries: boundaries,
            compactProgress: null,
            // 压缩后水位大降，先给个粗估，下轮 usage 到达后会用真实值刷新
            currentContextTokens: estimateContextTokens(msgs, undefined, get().contextWindowSize).used,
          })
          const convId = useConversationStore.getState().currentConversationId
          if (convId != null) {
            viewStateSet(`compacts-${convId}`, boundaries)
          }
        },
        /** v9 双轨：loop 在步骤间隙真正注入补充后的回调——此时才上屏气泡+持久化。
         * v9.3：chip 不再停留「已注入」态——注入即移除，气泡上屏就是反馈。 */
        onSupplementInjected: (text: string) => {
          const item = get().pendingSupplements.find((p) => p.text === text && !p.injected)
          if (!item) return // 已撤回/已处理的竞态
          set((s) => ({ pendingSupplements: s.pendingSupplements.filter((p) => p.id !== item.id) }))
          const newMsg: ChatMessage = {
            id: item.id,
            role: 'user',
            content: text,
            timestamp: Date.now(),
            isStreaming: false,
            status: 'done',
            isSupplement: true,
          }
          set((s) => ({ messages: [...s.messages, newMsg] }))
          const convId = useConversationStore.getState().currentConversationId
          if (convId != null) {
            historyApi.saveMessage(convId, newMsg).catch((err) => {
              console.warn('[chatStore] save supplement message failed:', err)
            })
          }
        },
        onAssistantCreated: (assistant) => {
          currentAssistantId = assistant.id
          loopAssistantIds.push(assistant.id)
          set((s) => ({ messages: [...s.messages, assistant] }))
        },
        onAssistantUpdate: (assistant) => {
          set((s) => {
            const messages = [...s.messages]
            const idx = messages.findIndex((m) => m.id === assistant.id)
            if (idx !== -1) {
              messages[idx] = assistant
            }
            return { messages }
          })
        },
        onToolStart: (toolMsg) => {
          set((s) => {
            const messages = [...s.messages]
            const idx = messages.findIndex((m) => m.id === currentAssistantId)
            if (idx !== -1) {
              messages.splice(idx + 1, 0, toolMsg)
            }
            return { messages }
          })
          const taskTitle = getToolTaskTitle(toolMsg.toolCallName || '')
          const panelStore = useContextPanelStore.getState()
          panelStore.addTask({ title: taskTitle, status: 'running' })
          const taskId = panelStore.tasks[panelStore.tasks.length - 1]?.id
          if (taskId && toolMsg.toolCallId) {
            toolTaskIdMap.set(toolMsg.toolCallId, taskId)
          }
          // 不自动弹出面板（用户手动控制）
        },
        onToolUpdate: (toolCallId, update) => {
          set((s) => {
            const messages = [...s.messages]
            const idx = messages.findIndex(
              (m) => m.role === 'tool' && m.toolCallId === toolCallId
            )
            if (idx !== -1) {
              messages[idx] = { ...messages[idx], ...update }
            }
            return { messages }
          })
          if (update.toolCallStatus === 'done' || update.toolCallStatus === 'error') {
            const taskId = toolTaskIdMap.get(toolCallId)
            if (taskId) {
              const panelStore = useContextPanelStore.getState()
              panelStore.updateTaskStatus(
                taskId,
                update.toolCallStatus === 'error' ? 'error' : 'completed'
              )
              toolTaskIdMap.delete(toolCallId)
            }

            // 标记该 tool 消息需要在 assistant 最终消息之后统一持久化，
            // 保证加载时的顺序与展示一致：user -> assistant -> tool。
            if (toolCallId && !persistedToolCallIds.has(toolCallId)) {
              persistedToolCallIds.add(toolCallId)
            }
          }
        },
        onApprovalRequested: (request, resolve) => {
          set((s) => {
            const messages = [...s.messages]
            const idx = messages.findIndex((m) => m.id === currentAssistantId)
            if (idx !== -1) {
              messages[idx] = { ...messages[idx], status: 'awaiting_approval' }
            }
            const pendingApprovals = s.pendingApprovals.some((a) => a.toolCallId === request.toolCallId)
              ? s.pendingApprovals
              : [...s.pendingApprovals, { ...request, resolve, status: 'pending' as const }]
            return { messages, pendingApprovals }
          })
        },
        onToolsDiscovered: (names) => {
          useSessionToolStore.getState().addDiscoveredNames(conversationId, names)
        },
        onError: (error) => {
          currentLoopHandle = null

          // TokenHub 推理 401（Key 被回收 / 套餐变更）：自动清除缓存并重新 reveal，
          // 成功后提示用户重新发送即可，无需手动进设置页操作。
          if (provider.provider === 'tokenhub' && classifyModelError(error).code === 'AUTH') {
            void handleTokenHubAuthError().then((recovered) => {
              if (recovered) {
                toast.info('云套餐密钥已自动更新，请重新发送消息')
              }
            })
            const msg = '云套餐密钥已失效，正在自动重新获取…若已恢复请重新发送消息'
            toast.error(msg)
            set({ isLoading: false, isStreaming: false, error: msg })
            finalizeTaskPanel('error')
            return
          }

          const friendlyMessage = getErrorMessage(error, '对话请求失败，请稍后重试')
          if (!isAbortError(error)) {
            toast.error(friendlyMessage)
          }
          set({ isLoading: false, isStreaming: false, error: friendlyMessage })
          finalizeTaskPanel('error')
          get().consumeQueueAfterTurn()
        },
        onDone: (assistant) => {
          currentLoopHandle = null
          set({ isLoading: false, isStreaming: false })
          finalizeTaskPanel('completed')

          // 持久化本轮循环中产生的所有 assistant 消息（包括工具调用轮次的中间 assistant），
          // 确保切换会话后工具调用 renderNodes 不丢失（此前只保存了最后一轮 assistant）。
          const persistLoop = async () => {
            const allMessages = get().messages
            const loopAssistants = allMessages.filter(
              (m) => m.role === 'assistant' && loopAssistantIds.includes(m.id)
            )

            // 依次保存所有 loop assistant（保持插入顺序）
            for (const msg of loopAssistants) {
              try {
                await historyApi.saveMessage(conversationId, msg)
              } catch (err) {
                console.error('保存助手消息失败:', err)
              }
            }

            // 然后按展示顺序保存 tool 结果消息
            const toolMessages = get().messages.filter(
              (m) => m.role === 'tool' && persistedToolCallIds.has(m.toolCallId || '')
            )
            for (const toolMsg of toolMessages) {
              historyApi
                .saveMessage(conversationId, toolMsg)
                .catch((err) => console.error('保存 tool 消息失败:', err))
            }
            persistedToolCallIds.clear()
          }

          persistLoop()

          if (assistant.content.length > 50) {
            setTimeout(() => {
              useMemoryStore
                .getState()
                .extractAndRemember(assistant.content, conversationId)
                .catch(() => {})
            }, 1000)
          }
          if (traceCollector.getCurrentTrace()) {
            traceCollector.complete('对话完成')
          }
          // v9 双轨：turn 结束后消费排队消息（含未注入补充的兜底转化）
          get().consumeQueueAfterTurn()
        },
      },
    })
  },

  stopStreaming: () => {
    const pendingIds = Array.from(streamingContentBuffers.keys())
    for (const assistantId of pendingIds) {
      flushStreamingContent(assistantId, set)
      clearStreamingState(assistantId)
    }

    if (currentAbortController) {
      currentAbortController()
      currentAbortController = null
    }
    if (currentLoopHandle) {
      currentLoopHandle.abort()
      currentLoopHandle = null
    }

    // 取消在途的会话标题生成，避免旧结果覆盖新会话标题
    const currentConversationId = useConversationStore.getState().currentConversationId
    if (currentConversationId !== null) {
      abortSessionTitleGeneration(currentConversationId)
    }

    const STOP_HINT = '\n\n（已停止生成）'

    set((s) => {
      const messages = s.messages.map((m) => {
        if (!m.isStreaming && m.status !== 'streaming' && m.status !== 'awaiting_approval') return m
        const newContent = m.content && !m.content.includes('（已停止生成）') && !m.content.includes('Generation stopped')
          ? m.content + STOP_HINT
          : m.content
        return {
          ...m,
          isStreaming: false,
          status: 'cancelled' as const,
          content: newContent,
        }
      })
      // BUG-12b: 停止时清理所有待审批请求，避免审批卡永生
      const pendingApprovals = s.pendingApprovals.map((a) =>
        a.status === 'pending' ? { ...a, status: 'expired' as const } : a
      )
      return {
        isLoading: false,
        isStreaming: false,
        messages,
        pendingApprovals,
      }
    })
    finalizeTaskPanel('error')
    // v9.3：手动停止 = 全停。已注入的补充留在历史里即可（模型已看到），
    // 不再复活为排队 chip——想重发用户自己会发；只有尚未注入的 pending 补充
    // 转入排队以防文本丢失（chip 保留，用户决定何时发），
    // 且不自动消费队列、不自动执行排队的 compact——避免"停止后又自动开新轮"的死循环感。
    {
      const staleSupps = get().pendingSupplements.filter(
        (p) => !p.injected && !get().messages.some((m) => m.isSupplement && m.content === p.text)
      )
      if (staleSupps.length > 0 || get().pendingSupplements.length > 0) {
        set((s) => ({
          pendingSupplements: [],
          queuedMessages: [
            ...s.queuedMessages,
            ...staleSupps.map((p) => ({ id: p.id, text: p.text })),
          ],
        }))
      }
      // 取消排队的 compact 与在途 compact，停止后不留任何自动动作
      if (get().pendingCompactAfterTurn !== null) set({ pendingCompactAfterTurn: null })
      get().cancelCompact()
    }
  },

  /**
   * 过程中补充（v9 双轨重写）：先登记 pendingSupplement（chip「待注入」），
   * loop 在步骤间隙真正注入时经 onSupplementInjected 回调上屏+持久化。
   * 注入前可 cancelSupplement 撤回（无痕）。
   */
  sendSupplement: (text: string) => {
    const state = get()
    if (!state.isStreaming) return

    const id = `supp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    set((s) => ({ pendingSupplements: [...s.pendingSupplements, { id, text, injected: false }] }))

    // 通知 agenticLoop 在步骤间隙注入（注入成功走 onSupplementInjected 回调）
    currentLoopHandle?.supplement(text)
  },

  /** 撤回尚未注入的补充（chip ✕） */
  cancelSupplement: (id: string) => {
    const item = get().pendingSupplements.find((p) => p.id === id)
    if (!item) return
    if (item.injected) {
      toast.info('补充已注入，无法撤回')
      return
    }
    // loop 队列里还在 → 撤回成功；不在（已注入/loop 已结束）→ 直接清条目
    const withheld = currentLoopHandle?.unsupplement?.(item.text)
    set((s) => ({ pendingSupplements: s.pendingSupplements.filter((p) => p.id !== id) }))
    if (withheld === false) {
      // 已被 loop 取走但回调尚未到达的竞态：等回调落地（回调里只处理仍在列表的条目）
      toast.info('补充注入中，可能已无法撤回')
    }
  },

  /** 移除已注入条目（chip 自动消失用；仅清状态，不动 loop 与历史） */
  dismissSupplement: (id: string) => {
    set((s) => ({ pendingSupplements: s.pendingSupplements.filter((p) => p.id !== id) }))
  },

  /** 排队一条消息，turn 结束后自动发送（v9 双轨之一） */
  queueMessage: (text: string) => {
    const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    set((s) => ({ queuedMessages: [...s.queuedMessages, { id, text }] }))
  },

  dequeueMessage: (id: string) => {
    set((s) => ({ queuedMessages: s.queuedMessages.filter((q) => q.id !== id) }))
  },

  popLastQueued: () => {
    const queue = get().queuedMessages
    if (queue.length === 0) return undefined
    const last = queue[queue.length - 1]
    set((s) => ({ queuedMessages: s.queuedMessages.slice(0, -1) }))
    return last.text
  },

  clearQueueAndSupplements: () => {
    // 未注入的补充同时从 loop 队列撤回，避免下一轮被意外注入
    const supps = get().pendingSupplements.filter((p) => !p.injected)
    for (const p of supps) currentLoopHandle?.unsupplement?.(p.text)
    set({ queuedMessages: [], pendingSupplements: [] })
  },

  /** turn 结束后的队列消费（onDone/onError/stopStreaming 调用）：
   * 1) 未注入的补充转为排队消息下轮发送（不丢失）
   * 2) 运行中触发的 /compact 优先执行（claude-code 排队语义），压缩完再消费排队
   * 3) FIFO 发送第一条排队消息 */
  consumeQueueAfterTurn: () => {
    // 竞态兜底：loop 结束时仍待注入的补充 → 转为排队消息下轮发送（不丢失）。
    // 去重：注入回调与 onDone 存在竞态（loop 已注入但回调未落地），
    // 跳过已经在消息流里以 isSupplement 存在的文本，避免同一句话发两次。
    const staleSupps = get().pendingSupplements.filter(
      (p) => !p.injected && !get().messages.some((m) => m.isSupplement && m.content === p.text)
    )
    if (staleSupps.length > 0) {
      set((s) => ({
        pendingSupplements: s.pendingSupplements.filter((p) => p.injected),
        queuedMessages: [
          ...s.queuedMessages,
          ...staleSupps.map((p) => ({ id: p.id, text: p.text })),
        ],
      }))
    }
    // 已注入但未清掉的条目（回调已上屏）一律清除
    if (get().pendingSupplements.length > 0) {
      set({ pendingSupplements: [] })
    }
    // 运行中排队的 /compact：turn 结束后先压缩，压缩完成再继续消费排队消息
    const pendingCompact = get().pendingCompactAfterTurn
    if (pendingCompact !== null) {
      set({ pendingCompactAfterTurn: null })
      setTimeout(() => {
        void get()
          .compactConversation(pendingCompact || undefined)
          .then(() => get().consumeQueueAfterTurn())
      }, 300)
      return
    }
    const queue = get().queuedMessages
    if (queue.length === 0) return
    const [first, ...rest] = queue
    set({ queuedMessages: rest })
    // 微任务延迟，让终态渲染/persist 先落地
    setTimeout(() => {
      void get().sendMessage(first.text)
    }, 300)
  },

  /**
   * 编辑锚点用户消息并重发（v9.1 对话分支）：
   * 当前分支尾部快照存入变体 → 文件状态回滚到锚点时刻 → 截断到锚点前 → 以新文本开新分支发送
   */
  resendEditedMessage: async (anchorId, newText) => {
    const s = get()
    if (s.isStreaming) {
      toast.info('请先停止当前任务再编辑重发')
      return
    }
    const idx = s.messages.findIndex((m) => m.id === anchorId)
    if (idx === -1 || s.messages[idx].role !== 'user') return
    const anchorMsg = s.messages[idx]
    const prefix = s.messages.slice(0, idx)
    const tail = s.messages.slice(idx)
    const convId = useConversationStore.getState().currentConversationId

    // 世界状态回滚到锚点时刻（文件检查点；无快照时 no-op）
    // 分支记录以首个变体的锚点消息 id 为 key；从非首个变体上编辑时 anchorId 是
    // 该变体自己的消息 id，直接 s.branches[anchorId] 会 miss 并新建一条只有
    // 2 个变体的记录（用户观测到"最多 x/2"）。这里按变体 anchorMsgId 找回真锚点。
    const existing =
      s.branches[anchorId] ??
      Object.values(s.branches).find((a) => a.variants.some((v) => v.anchorMsgId === anchorId))
    const anchorKey = existing?.anchorId ?? anchorId
    if (existing && existing.variants.length >= MAX_BRANCH_VARIANTS) {
      toast.info(`同一处最多 ${MAX_BRANCH_VARIANTS} 个分支，可先切换到其他分支再编辑`)
      return
    }
    const snapshotMsgId = existing?.snapshotMsgId ?? anchorId
    const restored = await applyFileSnapshot(snapshotMsgId).catch(() => 0)

    let anchor: BranchAnchor
    if (existing) {
      // 更新当前活跃变体快照后再开新变体
      const variants = existing.variants.map((v, i) =>
        i === existing.active ? { ...v, tail: stripForBranch(tail), anchorMsgId: tail[0]?.id ?? v.anchorMsgId } : v
      )
      variants.push({ id: generateId(), text: newText, tail: [] })
      anchor = { ...existing, variants, active: variants.length - 1 }
    } else {
      anchor = {
        anchorId,
        anchorText: anchorMsg.content,
        snapshotMsgId: anchorId,
        variants: [
          { id: generateId(), text: anchorMsg.content, anchorMsgId: anchorMsg.id, tail: stripForBranch(tail) },
          { id: generateId(), text: newText, tail: [] },
        ],
        active: 1,
      }
    }
    const prefixLen = prefix.length
    set((st) => ({ branches: { ...st.branches, [anchorKey]: anchor }, messages: prefix }))
    persistBranches(convId, get().branches)
    if (restored > 0) toast.info(`已回滚 ${restored} 个文件到编辑前状态`)
    void get().sendMessage(newText)

    // 新锚点消息 id 回填（分支 pills 定位）：userMessage 在 sendMessage 同步段内入列
    setTimeout(() => {
      const um = get().messages[prefixLen]
      if (!um || um.role !== 'user') return
      set((st) => {
        const a = st.branches[anchorKey]
        if (!a) return {}
        const variants = a.variants.map((v, i) => (i === a.active ? { ...v, anchorMsgId: um.id } : v))
        const branches = { ...st.branches, [anchorId]: { ...a, variants } }
        persistBranches(convId, branches)
        return { branches }
      })
    }, 120)
  },

  /** 切换分支（‹ › pills）：离开前快照当前变体，换入目标变体尾部，文件状态回到锚点时刻 */
  switchBranch: (anchorKey, delta) => {
    const s = get()
    if (s.isStreaming) {
      toast.info('任务运行中，请先停止再切换分支')
      return
    }
    const anchor = s.branches[anchorKey]
    if (!anchor || anchor.variants.length < 2) return
    const curAnchorMsgId = anchor.variants[anchor.active].anchorMsgId ?? anchor.anchorId
    const idx = s.messages.findIndex((m) => m.id === curAnchorMsgId)
    if (idx === -1) return

    void (async () => {
      const prefix = s.messages.slice(0, idx)
      const curTail = stripForBranch(s.messages.slice(idx))
      const next = (anchor.active + delta + anchor.variants.length) % anchor.variants.length
      const variants = anchor.variants.map((v, i) =>
        i === anchor.active ? { ...v, tail: curTail, anchorMsgId: curTail[0]?.id ?? v.anchorMsgId } : v
      )
      const target = variants[next]
      if (!target || target.tail.length === 0) {
        toast.info('该分支还没有内容')
        return
      }
      const restoredTail = target.tail.map((m) => ({ ...m }))
      const convId = useConversationStore.getState().currentConversationId
      const restored = anchor.snapshotMsgId
        ? await applyFileSnapshot(anchor.snapshotMsgId).catch(() => 0)
        : 0
      const nextMessages = [...prefix, ...restoredTail]
      // v9.4：token 估算与真实 context 一致——套用压缩线位置语义（分叉点决定用哪条线）
      const nextBranches = { ...s.branches, [anchorKey]: { ...anchor, variants, active: next } }
      const assembled = applyCompactBoundary(nextMessages, get().compactBoundaries, nextBranches)
      set(() => ({
        branches: nextBranches,
        messages: nextMessages,
        currentContextTokens: estimateContextTokens(assembled, undefined, s.contextWindowSize).used,
      }))
      persistBranches(convId, get().branches)
      toast.info(
        restored > 0
          ? `已切换到分支 ${next + 1}/${variants.length}，回滚 ${restored} 个文件`
          : `已切换到分支 ${next + 1}/${variants.length}`
      )
    })()
  },

  /** 主动压缩上下文（/compact）：与 autoCompact 同一语义——历史完全不动，
   * 只记录压缩边界（摘要 + 切点 + 分支路径），context 装配从边界重算。
   * 运行中触发 → 本轮结束后自动执行（claude-code 排队语义）。 */
  compactConversation: async (userInstructions) => {
    const state = get()
    if (state.isStreaming) {
      // claude-code：运行中 /compact 排队，turn 结束后执行
      set({ pendingCompactAfterTurn: userInstructions ?? '' })
      toast.info('任务运行中，本轮结束后将自动压缩上下文')
      return
    }
    if (state.compactProgress) return // 已在压缩中
    const provider = state.activeProvider
    if (!provider) {
      toast.error('请先选择 LLM 提供商')
      return
    }

    const conversationId = useConversationStore.getState().currentConversationId
    // 可压缩段：排除 system、保留尾部最近 10 条（与 autoCompact 保留策略同族）
    const KEEP_TAIL = 10
    const all = state.messages
    if (all.length < 12) {
      toast.info('对话还太短，无需压缩')
      return
    }
    const segment = all.slice(0, Math.max(0, all.length - KEEP_TAIL))
    const kept = all.slice(Math.max(0, all.length - KEEP_TAIL))
    // 边界绑定当前分支路径：切走不受影响，切回恢复
    const branchPath = currentBranchPath(state.branches)
    const cutoffTs = segment[segment.length - 1]?.timestamp ?? Date.now()

    compactAbortController = new AbortController()
    set({ isLoading: true, error: null, compactProgress: { trigger: 'manual', startedAt: Date.now() } })
    try {
      const credentials = await resolveProviderCredentials(provider)
      const runtimeProvider: ProviderConfig = {
        ...provider,
        model: credentials.model,
        baseUrl: credentials.baseUrl,
      }
      const { runPipeline, createPipelineTransport } = await import('@/agent/pipelineRunner')
      const { compactSummaryPipeline } = await import('@/agent/pipelines/compactSummary')
      const wireMessages = segment
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
      const transport = createPipelineTransport({
        provider: runtimeProvider,
        apiKey: credentials.apiKey,
        baseUrl: credentials.baseUrl,
        conversationId: conversationId ?? undefined,
        systemCode: isLocalRuntime() ? 'local' : localStorage.getItem('wonclaw_system_code') || undefined,
        executionMode: get().permissionMode ?? useSettingsStore.getState().permissionMode,
        enableFrontendToolLoop: !isLocalRuntime(),
      })
      const result = await runPipeline(
        compactSummaryPipeline,
        { messages: wireMessages, userInstructions },
        transport,
        { signal: compactAbortController.signal }
      )
      const summary = result.ok ? (result.value ?? result.rawText ?? '') : ''
      if (!result.ok || !summary) {
        if (!compactAbortController.signal.aborted) {
          toast.error(`压缩失败：${result.error || '摘要为空'}`)
        }
        set({ isLoading: false, compactProgress: null })
        return
      }

      const boundary: CompactBoundary = {
        id: `cb-${Date.now()}`,
        summary,
        cutoffTs,
        trigger: 'manual',
        coveredCount: segment.length,
        branchPath,
        at: Date.now(),
      }
      // v9.4 多线共存：旧边界一律保留——两条线之间分叉出去的分支仍需要更早的线，
      // selectActiveBoundary 按位置语义自动选用最新适用的一条
      const boundaries = [...get().compactBoundaries, boundary]
      set((s) => ({
        compactBoundaries: boundaries,
        currentContextTokens: estimateContextTokens(
          [{ role: 'user', content: summary } as ChatMessage, ...kept],
          undefined,
          s.contextWindowSize
        ).used,
        isLoading: false,
        compactProgress: null,
      }))
      if (conversationId != null) {
        viewStateSet(`compacts-${conversationId}`, boundaries)
      }
    } catch (err) {
      if (!compactAbortController.signal.aborted) {
        toast.error(getErrorMessage(err, '压缩失败'))
      }
      set({ isLoading: false, compactProgress: null })
    } finally {
      compactAbortController = null
    }
  },

  cancelCompact: () => {
    compactAbortController?.abort()
    set({ isLoading: false, compactProgress: null })
  },

  /** WebBridge 斜杠命令主体（自 sendMessage 迁入，v9 命令注册表 /web 入口） */
  runWebCommand: async (body) => {
    const content = `/web ${body}`
    set({ isLoading: true, error: null })
    const lowerBody = body.toLowerCase()

    try {
      if (lowerBody.startsWith('save ')) {
        const name = body.slice(5).trim()
        const lastJson = get().lastAssistantWorkflowJson
        if (!lastJson) {
          await get().appendAssistantMessage('没有可保存的最近工作流。请先让 AI 生成一个 WebBridge 工作流，或使用 `/web save <名称>` 保存它。')
          set({ isLoading: false })
          return
        }
        const parsed = lastJson as Partial<import('@/types/webbridge').WorkflowDefinition>
        const workflow = useWebBridgeStore.getState().createWorkflow({
          name: name || parsed.name || '未命名工作流',
          description: parsed.description || '',
          workflow_type: parsed.workflow_type || 'custom',
          steps: parsed.steps || [],
          input_schema: parsed.input_schema,
          output_format: parsed.output_format,
          require_login: parsed.require_login,
          target_sites: parsed.target_sites,
          estimated_duration_seconds: parsed.estimated_duration_seconds,
          security_policy: parsed.security_policy,
        })
        set({ lastAssistantWorkflowJson: null, isLoading: false })
        await get().appendAssistantMessage(`已保存工作流「${workflow.name}」，ID：${workflow.id}。之后可用 "/web run ${workflow.name}" 再次运行。`)
        return
      }

      if (lowerBody.startsWith('run ')) {
        const name = body.slice(4).trim()
        const workflow = useWebBridgeStore.getState().getWorkflowByName(name)
        if (!workflow) {
          const workflows = useWebBridgeStore.getState().getWorkflows()
          const names = workflows.slice(0, 10).map((w) => `• ${w.name}`).join('\n')
          await get().appendAssistantMessage(`未找到名为「${name}」的工作流。${names ? `\n已保存的工作流：\n${names}` : ''}`)
          set({ isLoading: false })
          return
        }
        await useWebBridgeStore.getState().runWorkflow(workflow.id)
        set({ isLoading: false })
        await get().appendAssistantMessage(`已运行工作流「${workflow.name}」。`)
        return
      }

      if (lowerBody === 'list') {
        const workflows = useWebBridgeStore.getState().getWorkflows()
        if (workflows.length === 0) {
          await get().appendAssistantMessage('当前没有已保存的 WebBridge 工作流。')
        } else {
          const list = workflows.map((w) => `• ${w.name}（${w.workflow_type}，${w.steps?.length || 0} 步）`).join('\n')
          await get().appendAssistantMessage(`已保存的 WebBridge 工作流：\n${list}`)
        }
        set({ isLoading: false })
        return
      }

      if (lowerBody.startsWith('policy ')) {
        const preset = body.slice(7).trim()
        const validPresets = ['research-assistant', 'form-automation', 'data-extraction', 'monitoring', 'secure-enterprise', 'read_only', 'standard', 'elevated', 'full']
        if (!validPresets.includes(preset)) {
          await get().appendAssistantMessage(`未知的安全策略预设「${preset}」。可用预设：research-assistant、form-automation、data-extraction、monitoring、secure-enterprise，或级别 read_only、standard、elevated、full。`)
          set({ isLoading: false })
          return
        }
        set({ pendingSecurityPreset: preset, isLoading: false })
        await get().appendAssistantMessage(`已将下一次 WebBridge 工作流的安全预设设为「${preset}」。下次 AI 生成工作流时会自动附加该策略。`)
        return
      }

      if (!body.trim()) {
        await get().appendAssistantMessage('请提供 WebBridge 任务描述，例如：/web 打开 example.com 并截图')
        set({ isLoading: false })
        return
      }

      const result = await useWebBridgeStore.getState().executeFromNaturalLanguage(content)
      await get().appendAssistantMessage(result)
    } catch (err) {
      const errorMsg = getErrorMessage(err, 'WebBridge 执行失败')
      toast.error(errorMsg)
      await get().appendAssistantMessage(`WebBridge 执行失败：${errorMsg}`)
    } finally {
      set({ isLoading: false })
    }
  },

  cancelToolCall: (toolCallId: string) => {
    currentLoopHandle?.cancelTool(toolCallId)
  },

  /** BUG-17: 解决 attention 节点并可选注入选择值到模型上下文 */
  resolveAttention: (nodeId: string, value?: string, resolved = true) => {
    currentLoopHandle?.resolveAttention(nodeId, resolved, value)
  },

  appendAssistantMessage: async (content) => {
    let conversationId = useConversationStore.getState().currentConversationId
    if (!conversationId) {
      conversationId = await useConversationStore.getState().createConversation()
      if (!conversationId) return
    }

    const message: ChatMessage = {
      id: generateId(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
    }

    set((s) => ({
      messages: [...s.messages, message],
    }))

    const estimate = estimateContextTokens(get().messages, undefined, get().contextWindowSize)
    set({ currentContextTokens: estimate.used })

    try {
      await historyApi.saveMessage(conversationId, message)
    } catch (err) {
      console.error('保存 Assistant 消息失败:', err)
    }
  },

  refreshConversationTitle: async (targetConversationId) => {
    const conversationId = targetConversationId ?? useConversationStore.getState().currentConversationId
    if (!conversationId) return

    const provider = get().activeProvider
    if (!provider) return

    const mode = getRuntimeMode()
    let credentials: { apiKey?: string; baseUrl: string; model: string }
    try {
      credentials = await resolveProviderCredentials(provider)
    } catch {
      return
    }

    // MESCLI Local 下使用云端 Provider 时必须已有 API Key
    if (mode === 'mescli-local' && !isLocalModelProvider(provider.provider) && !credentials.apiKey) {
      return
    }

    const systemCode = isLocalRuntime()
      ? 'local'
      : localStorage.getItem('wonclaw_system_code') || undefined
    const executionMode = get().permissionMode ?? useSettingsStore.getState().permissionMode

    // 取最近 6 条消息作为标题生成上下文（3 对 user/assistant 或更少）
    const recentMessages = get()
      .messages.slice(-6)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    if (recentMessages.length === 0) return

    const currentTitle = useConversationStore.getState().getCurrentConversation()?.title

    const runtimeProvider: ProviderConfig = {
      ...provider,
      model: credentials.model,
      baseUrl: credentials.baseUrl,
    }

    generateSessionTitle(
      { messages: recentMessages, previousTitle: currentTitle },
      conversationId,
      {
        provider: runtimeProvider,
        apiKey: credentials.apiKey,
        baseUrl: credentials.baseUrl,
        conversationId,
        systemCode,
        executionMode,
        enableFrontendToolLoop: !isLocalRuntime(),
      },
      { autoOnly: false }
    )
      .then(() => {
        useConversationTitleStore.getState().markAutoGenerated(conversationId)
      })
      .catch(() => {
        // 静默失败
      })
  },

  runWebBridgeFromAssistant: async (jsonText, assistantMessageId, originalUserContent, conversationId) => {
    // Agentic Trace：WebBridge 执行开始
    const wbTrace = createTraceCollector()
    wbTrace.startTrace(originalUserContent, 'webbridge', { jsonLength: jsonText.length, assistantMessageId })

    let workflowJson: Record<string, unknown>
    try {
      workflowJson = JSON.parse(sanitizeControlCharacters(jsonText)) as Record<string, unknown>
    } catch {
      wbTrace.fail('LLM 生成的工作流 JSON 格式错误')
      throw new Error('LLM 生成的工作流 JSON 格式错误')
    }

    set({ lastAssistantWorkflowJson: workflowJson })

    const pendingPreset = get().pendingSecurityPreset
    if (pendingPreset) {
      const levelPresets = ['read_only', 'standard', 'elevated', 'full']
      if (levelPresets.includes(pendingPreset)) {
        workflowJson.security_policy = { security_level: pendingPreset }
      } else {
        const preset = loadWebBridgePreset(pendingPreset)
        if (preset.security_policy) {
          workflowJson.security_policy = preset.security_policy
        }
      }
      set({ pendingSecurityPreset: null })
    }

    const updateMessageThinking = (updater: (tp: ThinkingProcessData) => ThinkingProcessData) => {
      set((s) => {
        const messages = [...s.messages]
        const idx = messages.findIndex((m) => m.id === assistantMessageId)
        if (idx !== -1 && messages[idx].thinkingProcess) {
          messages[idx] = {
            ...messages[idx],
            thinkingProcess: updater(messages[idx].thinkingProcess!),
          }
        }
        return { messages }
      })
    }

    const updateWebBridgeState = (state: ChatMessage['webBridgeState']) => {
      set((s) => {
        const messages = [...s.messages]
        const idx = messages.findIndex((m) => m.id === assistantMessageId)
        if (idx !== -1) {
          messages[idx] = { ...messages[idx], webBridgeState: state }
        }
        return { messages }
      })
    }

    const persistAssistantMessage = async () => {
      if (!conversationId) return
      const msg = get().messages.find((m) => m.id === assistantMessageId)
      if (!msg) return
      try {
        await historyApi.saveMessage(conversationId, msg)
      } catch (err) {
        console.error('保存 WebBridge 助手消息失败:', err)
      }
    }

    const executeAndMaybeRetry = async (
      json: unknown,
      isRetry: boolean,
      attempt: number
    ): Promise<{ workflow: import('@/types/webbridge').WorkflowDefinition; results: import('@/types/webbridge').ActionResult[] }> => {
      updateMessageThinking((tp) => ({
        ...tp,
        executionLog:
          tp.executionLog +
          (isRetry
            ? `\n第 ${attempt} 次尝试失败，正在根据页面状态重新生成工作流...`
            : '\n工作流已生成，正在执行 WebBridge 自动化...'),
      }))

      // Agentic Trace：WebBridge 执行步骤
      wbTrace.startSpan('webbridge', 'webbridge_execution', undefined, {
        attempt,
        isRetry,
        workflowName: (json as Record<string, unknown>)?.name || 'unknown',
        maxRetries: 2,
      })

      return await useWebBridgeStore.getState().executeWorkflowFromJson(json, {
        maxRetries: 2,
        screenshotOnFailure: true,
        onStep: (state) => {
          updateWebBridgeState(state)
          updateMessageThinking((tp) => ({
            ...tp,
            executionLog: tp.executionLog + `\n> Step ${state.stepIndex + 1}/${state.totalSteps}: ${state.lastAction || '...'}`,
          }))
        },
      })
    }

    let lastError: Error | null = null
    let workflowResult: { workflow: import('@/types/webbridge').WorkflowDefinition; results: import('@/types/webbridge').ActionResult[] } | null = null
    const maxAttempts = 2

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        workflowResult = await executeAndMaybeRetry(workflowJson, attempt > 1, attempt)
        break
      } catch (err) {
        lastError = err instanceof Error ? err : new Error('WebBridge 执行失败')
        if (attempt < maxAttempts) {
          try {
            const screenshot = await useWebBridgeStore.getState().captureScreenshot()
            const pageContext = await useWebBridgeStore.getState().capturePageContext()
            const pageStateText = JSON.stringify(
              {
                url: pageContext.url,
                title: pageContext.title,
                text: pageContext.text ? pageContext.text.slice(0, 3000) : '',
                hasScreenshot: !!screenshot,
              },
              null,
              2
            )

            const retryMessage = buildWebBridgeRetryMessage(lastError.message, pageStateText)
            const retryJsonText = await get().requestWebBridgeWorkflowFromLlm(
              retryMessage,
              conversationId,
              assistantMessageId
            )

            if (retryJsonText) {
              workflowJson = JSON.parse(sanitizeControlCharacters(retryJsonText)) as Record<string, unknown>
              set({ lastAssistantWorkflowJson: workflowJson })
            } else {
              break
            }
          } catch (retryErr) {
            lastError = retryErr instanceof Error ? retryErr : lastError
            break
          }
        }
      }
    }

    if (!workflowResult) {
      updateMessageThinking((tp) => ({
        ...tp,
        status: 'error',
        executionLog: tp.executionLog + `\n[错误] ${lastError?.message || 'WebBridge 执行失败'}`,
      }))
      await persistAssistantMessage()
      wbTrace.fail(lastError?.message || 'WebBridge 执行失败')
      throw lastError || new Error('WebBridge 执行失败')
    }

    const { workflow, results } = workflowResult

    // Agentic Trace：WebBridge 执行完成
    const successCount = results.filter((r) => r.success).length
    wbTrace.complete(`WebBridge 执行完成：${successCount}/${results.length} 个动作成功`, {
      workflowName: workflow.name,
      stepCount: results.length,
      successCount,
    })

    set((s) => {
      const messages = [...s.messages]
      const idx = messages.findIndex((m) => m.id === assistantMessageId)
      if (idx !== -1 && messages[idx].thinkingProcess) {
        const successCount = results.filter((r) => r.success).length
        messages[idx] = {
          ...messages[idx],
          thinkingProcess: {
            ...messages[idx].thinkingProcess!,
            status: 'completed',
            executionLog:
              messages[idx].thinkingProcess!.executionLog +
              `\n工作流 "${workflow.name}" 执行完成（${successCount}/${results.length} 个动作成功）。`,
          },
        }
      }
      return { messages }
    })

    await persistAssistantMessage()
    await get().summarizeWebBridgeResults(workflow.name, results, originalUserContent, conversationId)
  },

  requestWebBridgeWorkflowFromLlm: async (userContent, conversationId, assistantMessageId) => {
    const state = get()
    const provider = state.activeProvider
    if (!provider) return null

    const retryRegistry = buildCapabilityRegistry({
      mode: getRuntimeMode(),
      webBridgeStatus: useWebBridgeStore.getState().status,
      isMesLoggedIn: useAuthStore.getState().isMesLoggedIn,
    })

    const retryMessages: Message[] = [
      { role: 'system', content: getWebBridgeSystemPrompt(retryRegistry) + '\n\n' + getWebBridgeRetryPrompt() + '\n\n' + getFormattingPrompt() },
      ...state.messages
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.id !== assistantMessageId)
        .map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.toolCalls && m.toolCalls.length > 0 ? { toolCalls: m.toolCalls } : {}),
          ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
        })),
      { role: 'user', content: userContent },
    ]

    let credentials: { apiKey?: string; baseUrl: string; model: string }
    try {
      credentials = await resolveProviderCredentials(provider)
    } catch {
      return null
    }

    const runtimeProvider: ProviderConfig = {
      ...provider,
      model: credentials.model,
      baseUrl: credentials.baseUrl,
    }

    return new Promise<string | null>((resolve, reject) => {
      let collected = ''
      const abort = chatApi.streamChat(
        {
          provider: runtimeProvider.provider,
          model: runtimeProvider.model,
          baseUrl: runtimeProvider.baseUrl,
          apiKey: credentials.apiKey,
          conversationId,
          messages: retryMessages,
          saveToHistory: false,
        },
        (chunk: StreamChunk) => {
          if (chunk.type === 'content') {
            collected += chunk.content || ''
          } else if (chunk.type === 'error') {
            reject(new Error(chunk.content || '请求失败'))
          }
        },
        (error) => {
          reject(error)
        },
        () => {
          const { jsonText } = extractWebBridgeWorkflowSafe(collected)
          resolve(jsonText || null)
        }
      )

      setTimeout(() => {
        abort()
        reject(new Error('重试请求超时'))
      }, 30000)
    })
  },

  summarizeWebBridgeResults: async (workflowName, results, originalUserContent, conversationId) => {
    const state = get()
    const provider = state.activeProvider
    if (!provider) {
      await get().appendAssistantMessage('未选择 LLM 提供商，无法总结 WebBridge 执行结果。')
      return
    }

    let credentials: { apiKey?: string; baseUrl: string; model: string }
    try {
      credentials = await resolveProviderCredentials(provider)
    } catch {
      set({ isLoading: false, isStreaming: false })
      return
    }

    const runtimeProvider: ProviderConfig = {
      ...provider,
      model: credentials.model,
      baseUrl: credentials.baseUrl,
    }

    const resultMessage = buildWebBridgeResultMessage(results)
    const summaryMessages: Message[] = [
      { role: 'system', content: getWebBridgeSummaryPrompt() + '\n\n' + getFormattingPrompt() },
      ...state.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.toolCalls && m.toolCalls.length > 0 ? { toolCalls: m.toolCalls } : {}),
          ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
        })),
      { role: 'user', content: resultMessage },
    ]

    set({ isLoading: true, isStreaming: true, error: null })

    const summaryAssistantId = generateId()
    set((s) => ({
      messages: [
        ...s.messages,
        {
          id: summaryAssistantId,
          role: 'assistant',
          content: '',
          isStreaming: true,
          timestamp: Date.now(),
        },
      ],
    }))

    const abort = chatApi.streamChat(
      {
        provider: runtimeProvider.provider,
        model: runtimeProvider.model,
        baseUrl: runtimeProvider.baseUrl,
        apiKey: credentials.apiKey,
        conversationId,
        messages: summaryMessages,
        saveToHistory: false,
      },
      (chunk: StreamChunk) => {
        if (chunk.type === 'content') {
          appendStreamingContent(summaryAssistantId, chunk.content || '', set)
          return
        }

        flushStreamingContent(summaryAssistantId, set)

        set((s) => {
          const messages = [...s.messages]
          const assistantIndex = messages.findIndex((m) => m.id === summaryAssistantId)
          if (assistantIndex === -1) return s

          const assistant = { ...messages[assistantIndex] }

          if (chunk.type === 'error') {
            assistant.content += `\n[错误] ${chunk.content || ''}`
          }

          messages[assistantIndex] = assistant
          return { messages }
        })
      },
      (error) => {
        flushStreamingContent(summaryAssistantId, set)
        clearStreamingState(summaryAssistantId)
        const friendlyMessage = getErrorMessage(error, '总结请求失败')
        if (!isAbortError(error)) {
          toast.error(friendlyMessage)
        }
        set((s) => {
          const messages = [...s.messages]
          const assistantIndex = messages.findIndex((m) => m.id === summaryAssistantId)
          if (assistantIndex !== -1) {
            messages[assistantIndex] = {
              ...messages[assistantIndex],
              content: messages[assistantIndex].content + `\n[请求失败] ${friendlyMessage}`,
              isStreaming: false,
            }
          }
          return {
            messages,
            isLoading: false,
            isStreaming: false,
            error: friendlyMessage,
          }
        })
      },
      () => {
        flushStreamingContent(summaryAssistantId, set)
        clearStreamingState(summaryAssistantId)
        set((s) => {
          const messages = [...s.messages]
          const assistantIndex = messages.findIndex((m) => m.id === summaryAssistantId)
          if (assistantIndex !== -1) {
            messages[assistantIndex] = {
              ...messages[assistantIndex],
              isStreaming: false,
            }
          }
          return {
            messages,
            isLoading: false,
            isStreaming: false,
          }
        })

        if (conversationId) {
          const summaryMsg = get().messages.find((m) => m.id === summaryAssistantId)
          if (summaryMsg) {
            historyApi.saveMessage(conversationId, summaryMsg).catch((err) => {
              console.error('保存 WebBridge 总结消息失败:', err)
            })
          }
        }
      }
    )

    currentAbortController = abort
  },

  requestPptTemplateSelection: (content: string, attachmentIds?: string[]) => {
    set({
      pptTemplateSelection: {
        isPending: true,
        content,
        attachmentIds,
      },
    })
  },

  confirmPptTemplateSelection: (templateId: string) => {
    const { pptTemplateSelection } = get()
    if (!pptTemplateSelection) return

    const templateIndex = PPT_TEMPLATES.findIndex((t) => t.id === templateId)
    const template = templateIndex !== -1 ? PPT_TEMPLATES[templateIndex] : undefined
    const { content, attachmentIds } = pptTemplateSelection
    const enhancedContent = template
      ? `${content}\n\n${buildPptTemplatePrompt(template, templateIndex + 1)}`
      : content

    set({ pptTemplateSelection: null })
    get().sendMessage(
      enhancedContent,
      attachmentIds,
      template
        ? { id: template.id, name: template.name, toolValue: template.toolValue, index: templateIndex + 1 }
        : undefined
    )
  },

  cancelPptTemplateSelection: () => {
    set({ pptTemplateSelection: null })
  },

  runDagWorkflowAsAgent: async (workflow, inputs = {}) => {
    console.log('[chatStore.runDagWorkflowAsAgent] Agent 执行路径被调用，workflow:', workflow.name)

    // Agentic Trace：DAG 执行开始
    const dagTrace = createTraceCollector()
    dagTrace.startTrace(`DAG: ${workflow.name}`, 'dag', { workflowId: workflow.id, nodeCount: workflow.nodes.length })

    let conversationId = useConversationStore.getState().currentConversationId
    if (!conversationId) {
      conversationId = await useConversationStore.getState().createConversation(workflow.name)
      if (!conversationId) {
        dagTrace.fail('无法创建对话')
        return
      }
    }

    const assistantId = generateId()
    const initialLog = `开始执行工作流「${workflow.name}」...`
    set((s) => ({
      messages: [
        ...s.messages,
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          toolCallName: 'dag_execution',
          thinkingProcess: {
            executionLog: initialLog,
            status: 'running',
            isExpanded: true,
          },
        },
      ],
      isLoading: true,
    }))

    useContextPanelStore.getState().clearTasks()

    const updateThinking = (updater: (tp: ThinkingProcessData) => ThinkingProcessData) => {
      set((s) => {
        const messages = [...s.messages]
        const idx = messages.findIndex((m) => m.id === assistantId)
        if (idx !== -1 && messages[idx].thinkingProcess) {
          messages[idx] = {
            ...messages[idx],
            thinkingProcess: updater(messages[idx].thinkingProcess!),
          }
        }
        return { messages }
      })
    }

    const appendThinkingLog = (line: string) => {
      updateThinking((tp) => ({
        ...tp,
        executionLog: (tp.executionLog + '\n' + line).trim(),
      }))
    }

    try {
      await runDagWorkflowAsAgent(workflow, inputs, {
        onProgress: (snapshot) => {
          const statusLine = snapshot.executionLog[snapshot.executionLog.length - 1]
          if (statusLine) {
            appendThinkingLog(statusLine)
          }
          if (snapshot.status === 'repairing') {
            updateThinking((tp) => ({ ...tp, status: 'running' }))
          }
        },
        onCommitRepairs: async (repairs) => {
          if (repairs.length === 0) return
          for (const r of repairs) {
            if (r.config) {
              await useDagWorkflowStore.getState().updateNodeData(workflow.id, r.nodeId, r.config as Partial<import('@/types/dagWorkflow').DagNodeData>)
            }
          }
          appendThinkingLog(`已自动同步 ${repairs.length} 处修复到工作流定义。`)
        },
        onComplete: (ctx, executedWorkflow) => {
          // Agentic Trace：DAG 执行完成
          const fileOutputs = collectWorkflowFileOutputs(ctx)
          const outputs = ctx.nodeOutputs.get('__outputs__') as Record<string, unknown> | undefined
          const executedNodeIds = Array.from(ctx.nodeOutputs.keys()).filter((k) => k !== '__outputs__')
          dagTrace.complete(`DAG 执行完成：${workflow.name}`, {
            executedNodeCount: executedNodeIds.length,
            outputKeys: outputs ? Object.keys(outputs) : [],
            fileOutputCount: fileOutputs.length,
            durationMs: ctx.endTime ? ctx.endTime - ctx.startTime : undefined,
          })

          let summary = `工作流「${workflow.name}」执行完成，共执行 ${executedNodeIds.length} 个节点。`

          if (outputs && Object.keys(outputs).length > 0) {
            const lines = Object.entries(outputs)
              .map(([k, v]) => `- ${k}: ${formatWorkflowOutputValue(v)}`)
              .join('\n')
            summary += `\n\n输出：\n${lines}`
          } else if (executedNodeIds.length > 0) {
            const recentIds = executedNodeIds.slice(-3)
            const lines = recentIds
              .map((id) => {
                const value = ctx.nodeOutputs.get(id)
                return `- ${id}: ${formatWorkflowOutputValue(value)}`
              })
              .join('\n')
            summary += `\n\n节点输出：\n${lines}`
          }

          if (fileOutputs.length > 0) {
            summary += `\n\n已生成 ${fileOutputs.length} 个文件，可在右侧上下文面板查看或点击下方卡片下载。`
          }

          set((s) => {
            const messages = [...s.messages]
            const idx = messages.findIndex((m) => m.id === assistantId)
            if (idx === -1) return { messages, isLoading: false }

            const toolMessages: ChatMessage[] = fileOutputs.map((file) => {
              const sourceNode = executedWorkflow.nodes.find((n) => n.id === file.sourceNodeId)
              const toolName = sourceNode?.type === 'tool'
                ? String(sourceNode.data.tool?.toolName || 'file_output')
                : 'file_output'
              return {
                id: generateId(),
                role: 'tool',
                content: '',
                toolCallStatus: 'done',
                toolCallName: toolName,
                timestamp: Date.now(),
                structuredData: { downloadUrl: file.downloadUrl, fileName: file.fileName },
              }
            })

            messages[idx] = {
              ...messages[idx],
              content: summary,
              thinkingProcess: {
                ...messages[idx].thinkingProcess!,
                status: 'completed',
                executionLog: messages[idx].thinkingProcess!.executionLog + '\n' + summary,
              },
            }

            return {
              messages: [...messages.slice(0, idx + 1), ...toolMessages, ...messages.slice(idx + 1)],
              isLoading: false,
            }
          })
        },
        onFailed: (_ctx, _wf, error) => {
          // Agentic Trace：DAG 执行失败
          dagTrace.fail(error)

          const summary = `工作流「${workflow.name}」执行失败：${error.message}`
          set((s) => {
            const messages = [...s.messages]
            const idx = messages.findIndex((m) => m.id === assistantId)
            if (idx !== -1) {
              messages[idx] = {
                ...messages[idx],
                content: summary,
                thinkingProcess: {
                  ...messages[idx].thinkingProcess!,
                  status: 'error',
                  executionLog: messages[idx].thinkingProcess!.executionLog + '\n[失败] ' + error.message,
                },
              }
            }
            return { messages, isLoading: false, error: error.message }
          })
        },
      })
    } catch (err) {
      const message = getErrorMessage(err, 'Agent 执行失败')
      toast.error(message)
      // Agentic Trace：DAG 执行异常
      dagTrace.fail(message)
      const summary = `工作流「${workflow.name}」执行失败：${message}`
      set((s) => {
        const messages = [...s.messages]
        const idx = messages.findIndex((m) => m.id === assistantId)
        if (idx !== -1) {
          messages[idx] = {
            ...messages[idx],
            content: summary,
            thinkingProcess: {
              ...messages[idx].thinkingProcess!,
              status: 'error',
              executionLog: messages[idx].thinkingProcess!.executionLog + '\n[失败] ' + message,
            },
          }
        }
        return { messages, isLoading: false, error: message }
      })
    }
  },

  setActiveProvider: (provider) => {
    const resolved = resolveContextWindow(provider.provider, provider.model)
    set({
      activeProvider: provider,
      contextWindowSize: resolved.value,
      contextWindowSource: resolved.source,
    })
  },
  refreshContextWindow: () => {
    const provider = get().activeProvider
    if (!provider) return
    const resolved = resolveContextWindow(provider.provider, provider.model)
    set({ contextWindowSize: resolved.value, contextWindowSource: resolved.source })
  },
  setPermissionMode: (mode) => set({ permissionMode: mode }),
  setProviders: (providers) => set({ providers }),
  setContextTokens: (tokens) => set({ currentContextTokens: tokens }),
  clearError: () => set({ error: null }),
  clearMessages: () => {
    // /clear 等"全新开始"场景：压缩边界/进度/待执行一并清空（新对话是干净的）
    compactAbortController?.abort()
    compactAbortController = null
    // 持久化的视图状态同步清除（分支快照/压缩边界）
    const convId = useConversationStore.getState().currentConversationId
    if (convId != null) {
      viewStateSet(`branches-${convId}`, [])
      viewStateSet(`compacts-${convId}`, [])
    }
    set({
      messages: [],
      branches: {},
      compactBoundaries: [],
      compactProgress: null,
      pendingCompactAfterTurn: null,
    })
  },
  setLoading: (value) => set({ isLoading: value }),
  setStreaming: (value) => set({ isStreaming: value }),
  setMessageFeedback: (messageId, feedback) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, feedback } : m
      ),
    })),

  addPendingApproval: (request) => {
    // resolve 必选——无 resolve 的注册在 dev 环境 fail fast
    if (!request.resolve) {
      const msg = `[approval] 注册审批缺少 resolve: ${request.toolCallId}`
      console.error(msg)
      if (import.meta.env.DEV) throw new Error(msg)
      return
    }
    // 启动超时定时器
    if (request.expiresAt) {
      scheduleApprovalTimer(request.toolCallId, request.expiresAt)
    }
    set((state) => {
      if (state.pendingApprovals.some((a) => a.toolCallId === request.toolCallId)) {
        return state
      }
      return { pendingApprovals: [...state.pendingApprovals, { ...request, status: 'pending' as const }] }
    })
  },

  approveToolCall: (toolCallId, reason) => {
    const approval = get().pendingApprovals.find((a) => a.toolCallId === toolCallId && a.status === 'pending')
    if (!approval) return
    clearApprovalTimer(toolCallId)
    // 1) 乐观更新——按钮立即可见反馈，防重复点击
    set((state) => {
      const stillPending = state.pendingApprovals.some(
        (a) => a.status === 'pending' && a.toolCallId !== toolCallId
      )
      return {
        pendingApprovals: state.pendingApprovals.map((a) =>
          a.toolCallId === toolCallId ? { ...a, status: 'approved' as const } : a
        ),
        messages: state.messages.map((m) => {
          if (m.toolCallId === toolCallId) return { ...m, approvalStatus: 'approved' as const }
          // BUG-23: 只有当前 turn 已无其他 pending approval 时，才把 assistant 从 awaiting_approval 切回 calling_tools
          if (!stillPending && m.role === 'assistant' && m.status === 'awaiting_approval') {
            return { ...m, status: 'calling_tools' as const }
          }
          return m
        }),
      }
    })
    // 2) 通知执行层；resolve 抛错不影响已完成的 UI 迁移
    try { approval.resolve(true, reason) } catch (err) { console.error('[approval] resolve 异常', err) }
    // S4 D3：批准 /project 写入后授予会话级 project-write 授权
    const path = approval.rawParams?.path
    if ((approval.toolName === 'write_file' || approval.toolName === 'str_replace') && typeof path === 'string' && path.trim().startsWith('/project/')) {
      addSessionGrant(useConversationStore.getState().currentConversationId, PROJECT_WRITE_GRANT)
    }
  },

  rejectToolCall: (toolCallId, reason) => {
    const approval = get().pendingApprovals.find((a) => a.toolCallId === toolCallId && a.status === 'pending')
    if (!approval) return
    clearApprovalTimer(toolCallId)
    // 1) 乐观更新
    set((state) => {
      const stillPending = state.pendingApprovals.some(
        (a) => a.status === 'pending' && a.toolCallId !== toolCallId
      )
      return {
        pendingApprovals: state.pendingApprovals.map((a) =>
          a.toolCallId === toolCallId ? { ...a, status: 'rejected' as const } : a
        ),
        messages: state.messages.map((m) => {
          if (m.toolCallId === toolCallId) return { ...m, approvalStatus: 'rejected' as const }
          if (!stillPending && m.role === 'assistant' && m.status === 'awaiting_approval') {
            return { ...m, status: 'calling_tools' as const }
          }
          return m
        }),
      }
    })
    // 2) 通知执行层
    try { approval.resolve(false, reason) } catch (err) { console.error('[approval] resolve 异常', err) }
  },

  expireToolCall: (toolCallId) => {
    const approval = get().pendingApprovals.find((a) => a.toolCallId === toolCallId && a.status === 'pending')
    if (!approval) return
    clearApprovalTimer(toolCallId)
    // 1) 乐观更新
    set((state) => {
      const a = state.pendingApprovals.find((x) => x.toolCallId === toolCallId)
      if (!a || a.status !== 'pending') return state
      return {
        pendingApprovals: state.pendingApprovals.map((x) =>
          x.toolCallId === toolCallId ? { ...x, status: 'expired' as const } : x
        ),
        messages: state.messages.map((m) =>
          m.toolCallId === toolCallId ? { ...m, approvalStatus: 'rejected' as const } : m
        ),
      }
    })
    // 2) 通知执行层
    try { approval.resolve(false, '请求已超时失效') } catch (err) { console.error('[approval] expire resolve 异常', err) }
  },

  clearPendingApprovals: () => set({ pendingApprovals: [] }),

  updateApprovalSqlExplain: (toolCallId, summary) =>
    set((state) => {
      const approval = state.pendingApprovals.find((a) => a.toolCallId === toolCallId)
      if (!approval || approval.status !== 'pending') return state
      const pendingApprovals = state.pendingApprovals.map((a) =>
        a.toolCallId === toolCallId ? { ...a, sqlExplainSummary: summary } : a
      )
      return { pendingApprovals }
    }),

  requestSqlExplain: async (toolCallId) => {
    const approval = get().pendingApprovals.find(
      (a) => a.toolCallId === toolCallId && a.status === 'pending'
    )
    if (!approval) return
    if (approval.toolName !== 'execute_sql_query') return

    const sql = typeof approval.rawParams?.sql === 'string' ? approval.rawParams.sql : ''
    if (!sql || !isSqlWriteOperation(sql)) return

    const provider = get().activeProvider
    if (!provider) return

    let credentials: { apiKey?: string; baseUrl: string; model: string }
    try {
      credentials = await resolveProviderCredentials(provider)
    } catch {
      return
    }

    if (getRuntimeMode() === 'mescli-local' && !isLocalModelProvider(provider.provider) && !credentials.apiKey) {
      return
    }

    const runtimeProvider: ProviderConfig = {
      ...provider,
      model: credentials.model,
      baseUrl: credentials.baseUrl,
    }

    const systemCode = isLocalRuntime()
      ? 'local'
      : localStorage.getItem('wonclaw_system_code') || undefined
    const executionMode = get().permissionMode ?? useSettingsStore.getState().permissionMode
    const enableFrontendToolLoop = !isLocalRuntime()

    const recentContext = get()
      .messages.filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-4)
      .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content.slice(0, 200)}`)
      .join('\n')
      .slice(0, 500)

    const summary = await generateSqlExplainSummary(
      {
        sql,
        systemCode,
        recentContext,
      },
      {
        provider: runtimeProvider,
        apiKey: credentials.apiKey,
        baseUrl: credentials.baseUrl,
        conversationId: useConversationStore.getState().currentConversationId ?? undefined,
        systemCode,
        executionMode,
        enableFrontendToolLoop,
      }
    )

    if (summary) {
      get().updateApprovalSqlExplain(toolCallId, summary)
    }
  },
}))
