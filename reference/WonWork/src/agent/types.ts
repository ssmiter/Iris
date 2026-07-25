import type { ChatMessage } from '@/types/chat'

/**
 * Agentic 内核共享类型定义
 *
 * 设计借鉴 Claude Code 的 Tool 抽象与 Trace/Span 可观测模型，
 * 但去除文件化记忆、MCP 适配器、auto classifier 等 WonWork 当前不需要的概念。
 */

// ==================== 风险与执行模式 ====================

export type ToolRiskLevel = 'read_only' | 'standard' | 'elevated' | 'destructive'

export type ExecutionMode = 'auto' | 'confirm' | 'sandbox' | 'bypass'

export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

// ==================== 权限上下文（M3 最小实现） ====================

export type PermissionMode = 'auto' | 'confirm' | 'sandbox' | 'bypass' | 'dontAsk'

export type PermissionRuleBehavior = 'allow' | 'deny' | 'ask'

export interface PermissionRule {
  behavior: PermissionRuleBehavior
  /** 工具名、路径、命令子串等匹配模式 */
  pattern: string | RegExp
  source?: string
}

export interface PermissionResult {
  allowed: boolean
  reason?: string
  behavior?: PermissionRuleBehavior
  /**
   * 底线确认标记（打磨任务2 S1 拍板项1）：
   * 即使在 bypass（全部自动）模式下也保留人工确认——用于删表/删文件类破坏性操作。
   */
  alwaysAsk?: boolean
}

export interface ToolPermissionContext {
  mode: PermissionMode
  /** 显式允许规则 */
  allowRules?: PermissionRule[]
  /** 显式拒绝规则 */
  denyRules?: PermissionRule[]
  /** 必须询问规则 */
  askRules?: PermissionRule[]
  /** 当前会话已授权/拒绝的权限集合 */
  grantedPermissions?: Set<string>
  /** 是否允许绕过审批（headless/agent 模式） */
  canBypass?: boolean
}

// ==================== Tool 抽象 ====================

/**
 * 工具目录项，与后端 ToolDefinition / OpenAI tools 格式对齐
 */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: unknown
  }
}

export interface ToolExecutionContext {
  traceId: string
  conversationId?: number
  systemCode?: string
  userId?: number
  userName?: string
  abortSignal?: AbortSignal
  onProgress?: (update: ToolProgressUpdate) => void
}

export interface ToolProgressUpdate {
  toolCallId: string
  toolName: string
  status: 'pending' | 'running' | 'awaiting_approval' | 'completed' | 'error' | 'cancelled'
  message?: string
  detail?: unknown
}

/**
 * 工具定义
 *
 * - `execute` 在 MESCLI 前端镜像中可不实现，实际执行在后端；
 * - Standalone / DAG 本地执行场景可挂函数。
 */
export interface Tool<TInput = unknown, TOutput = unknown> {
  name: string
  description: string
  /** JSON Schema；鼓励使用 type: 'object' */
  inputSchema: unknown
  /** 可选：已验证的 JSON Schema（当 inputSchema 是运行时对象时使用） */
  inputJSONSchema?: unknown
  execute?: (input: TInput, ctx: ToolExecutionContext) => Promise<TOutput>
  riskLevel: ToolRiskLevel
  /** 是否只读；可为布尔值或按输入动态判断 */
  isReadOnly: boolean | ((input: TInput) => boolean)
  /** 是否可安全并发；可为布尔值或按输入动态判断 */
  isConcurrencySafe: boolean | ((input: TInput) => boolean)
  /** 是否破坏性；可为布尔值或按输入动态判断 */
  isDestructive: boolean | ((input: TInput) => boolean)
  /** 需要的功能权限标识 */
  requiredPermissions?: string[]
  /** 自定义校验函数，用于 schema 无法表达的复杂约束 */
  validateInput?: (input: unknown) => { valid: boolean; error?: string }
  /** 自定义权限检查 */
  checkPermissions?: (input: TInput, context: ToolPermissionContext) => PermissionResult
  maxResultSizeChars: number
  /** 工具分类，用于 prompt 分段、UI 分组与工具发现 */
  category?: string
  /** 是否延迟加载：首次不注入上下文，需通过 tool_search 发现后才可用 */
  deferred?: boolean
  /** 是否强制始终加载（覆盖 deferred） */
  alwaysLoad?: boolean
  /** OpenAI/Anthropic structured-output strict mode */
  strict?: boolean
  /** 工具层级（v1.3） */
  tier?: import('@/types/mescli').ToolTier
  /** 加载策略（v1.4） */
  loadStrategy?: import('@/types/mescli').ToolLoadStrategy
  /** 操作类型（v1.4） */
  operationType?: import('@/types/mescli').ToolOperationType
  /** 审批模式（v1.4） */
  approvalMode?: import('@/types/mescli').ApprovalMode
  /** 是否需要显式审批（v1.2） */
  requiresApproval?: boolean
  /** 是否幂等（v1.2） */
  idempotent?: boolean
  /**
   * 用户可读的影响陈述句模板或函数。
   * 支持 {key} 占位符，运行时由实际参数填充；函数形式用于参数需要转换的场景。
   * 用于审批卡片中的"影响陈述句"，让用户不展开参数即可判断后果。
   */
  impactStatement?: string | ((input: TInput) => string)
  /** 受影响实体类型（v1.4） */
  affectedEntityTypes?: string[]
  /** 可选输出 schema，用于结果校验与渲染 */
  outputSchema?: unknown
  /** 针对该工具的补充使用说明，会追加到 system prompt 的工具使用原则中 */
  usagePrompt?: string
  /** 使用示例，供 prompt 或 UI 展示 */
  examples?: Array<{ input: TInput; notes?: string }>
}

// ==================== ToolCall / ToolResult ====================

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  status: 'pending' | 'running' | 'awaiting_approval' | 'completed' | 'error' | 'cancelled'
  executionMode?: ExecutionMode
  approvalStatus?: ApprovalStatus
}

export interface ToolResult {
  toolCallId: string
  name: string
  success: boolean
  output: unknown
  outputText?: string
  isTruncated: boolean
  persistedUrl?: string
  startedAt: number
  endedAt: number
  error?: string
  /** 是否被用户主动中断 */
  cancelled?: boolean
}

// ==================== 审批（M3 预埋数据模型） ====================

export interface ApprovalRequest {
  toolCallId: string
  toolName: string
  riskLevel: ToolRiskLevel
  /** 用户可读的影响陈述句 */
  impactStatement: string
  /** 原始参数，用于"查看完整参数"展开区 */
  rawParams: Record<string, unknown>
  argumentsSummary: string
  reason: string
  requestedAt: number
  /** 审批过期时间戳（毫秒），未设置时由前端按默认超时兜底 */
  expiresAt?: number
  /** SQL 写操作影响解释（approval_explain pipeline 试点，按需生成） */
  sqlExplainSummary?: string
}

// ==================== AgenticState ====================

export interface AgenticState {
  traceId: string
  turn: number
  executionMode: ExecutionMode
  messages: ChatMessage[]
  pendingToolCalls: ToolCall[]
  pendingApprovals: ApprovalRequest[]
  completedToolResults: ToolResult[]
}

// ==================== Trace / Span 可观测骨架 ====================

export type SpanKind =
  | 'model_call'
  | 'tool_call'
  | 'tool_execution'
  | 'context_assembly'
  | 'webbridge'
  | 'approval'
  | 'dag'

export interface SpanEvent {
  name: string
  timestamp: number
  attributes?: Record<string, unknown>
}

export interface Span {
  spanId: string
  parentSpanId?: string
  traceId: string
  kind: SpanKind
  name: string
  status: 'running' | 'completed' | 'error'
  startedAt: number
  endedAt?: number
  durationMs?: number
  attributes: Record<string, unknown>
  events: SpanEvent[]
}

export interface Trace {
  traceId: string
  type: 'chat' | 'dag' | 'webbridge' | 'workflow' | 'tool'
  rootSpan: Span
  spans: Span[]
  status: 'running' | 'completed' | 'error'
  startedAt: number
  endedAt?: number
  durationMs?: number
  input: string
  summary?: string
  error?: string
  metadata?: Record<string, unknown>
}
