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
   * 2026-08-31 扩展（用户拍板）：bash 开放命令的 ask 与目录登记 ask 同属不委托集
   * （对齐 claude-code permissions.ts 1f/1g：内容级 ask 与路径类 safetyCheck 免疫
   * bypassPermissions——bypass 委托执行风险判断，授权边界扩张不委托）。
   */
  alwaysAsk?: boolean
  /**
   * 批准时可沉淀的权限规则建议（2026-08-30 下限工程 P0-2 按对话权限表）。
   * checkPermissions 返回 ask 时附带，审批卡据此展示"记住"选项；
   * 删除/移动类破坏性命令不得附带（不沉淀）。非破坏性的 alwaysAsk 可以附带——
   * 沉淀后同类调用在 checkPermissions 内部命中 allow 规则直接放行，不再触发确认。
   */
  suggestedRule?: SuggestedPermissionRule
}

/** 权限表规则建议（审批卡"记住"按钮的载荷；command=命令族前缀 / directory=目录读前缀 / directory-write=目录写前缀） */
export interface SuggestedPermissionRule {
  kind: 'command' | 'directory' | 'directory-write'
  pattern: string
  /** 卡片上的展示说明（如「"svn commit" 开头的命令」） */
  label: string
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
  /** 当前会话 id（consult_state 门控按会话匹配活跃状态任务） */
  conversationId?: number | null
  /**
   * consult_state 门控豁免（2026-08-08 双 agent P0）：子 Agent 循环置 true——
   * 写前对账是主 loop 层的职责（主 Agent 派遣写子任务前自己先对账），
   * 子 Agent 没有派遣工具，被拦后引导文案对它无解。
   */
  stateConsultExempt?: boolean
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
  conversationId?: number
  systemCode?: string
  userId?: number
  userName?: string
  abortSignal?: AbortSignal
  onProgress?: (update: ToolProgressUpdate) => void
  /** 本次工具调用的 toolCallId（2026-08-01 接缝：子 Agent 运行记录与父瀑布节点精确挂靠用） */
  toolCallId?: string
  /** 反问闸（ask_user 等交互工具暂停等待用户作答）；缺省环境（DAG/子 Agent）不支持交互 */
  clarifyGate?: import('./clarifyGate').ClarifyGate
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
  /** 单次执行超时（毫秒）。缺省用执行器默认 120s；长程工具（如子 Agent 闭环）必须显式放宽，
   *  否则跑到一半被超时切断（超时以 abort 信号下发，工具应能把它收敛为"中断+部分结果"） */
  timeoutMs?: number
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
  /**
   * 写前状态对账（2026-08-08 双 agent P0，consult_state）：会话存在活跃状态任务时，
   * 本工具的写调用必须持有 state agent 的 proceed 回执（一次性令牌）才放行，
   * 否则结构性拒绝并引导先对账。无活跃状态任务时零影响。
   */
  requiresStateConsult?: boolean
  /** 是否幂等（v1.2） */
  idempotent?: boolean
  /**
   * 用户可读的影响陈述句模板或函数。
   * 支持 {key} 占位符，运行时由实际参数填充；函数形式用于参数需要转换的场景。
   * 用于审批卡片中的“影响陈述句”，让用户不展开参数即可判断后果。
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
  /** 原始参数，用于“查看完整参数”展开区 */
  rawParams: Record<string, unknown>
  argumentsSummary: string
  reason: string
  requestedAt: number
  /** 审批过期时间戳（毫秒），未设置时由前端按默认超时兜底 */
  expiresAt?: number
  /** SQL 写操作影响解释（approval_explain pipeline 试点，按需生成） */
  sqlExplainSummary?: string
  /** 批准时可沉淀的权限规则建议（P0-2 权限表，由 checkPermissions 经 toolExecutor 透传） */
  suggestedRule?: SuggestedPermissionRule
}

// ==================== Trace / Span 可观测骨架 ====================

export type SpanKind =
  | 'model_call'
  | 'tool_call'
  | 'tool_execution'
  | 'context_assembly'
  | 'webbridge'
  | 'approval'

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
  type: 'chat' | 'webbridge' | 'tool'
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
