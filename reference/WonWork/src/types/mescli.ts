/**
 * MESCLI API 类型定义
 * 与 D:\Sleven\Projects\MESCLI\AIGateway 后端契约完全对应
 * 当 MESCLI 升级时，只需同步更新此文件
 */

// ==================== 认证 ====================

export interface LoginRequest {
  workBarcode: string
  password: string
  dbVersion?: string
  systemCode?: string
}

export interface LoginResponse {
  success: boolean
  error?: string
  errorCode?: string
  token?: string
  user?: UserInfo
}

export interface UserInfo {
  userId: number
  userName: string
  realName: string
  roleId?: number
  factoryId?: number
  deptId?: number
  workshopId?: number
  systemCode: string
}

export interface UserPermissions {
  /** 当前用户可访问的功能标识列表 */
  features: string[]
  /** 是否具备管理员权限 */
  isAdmin?: boolean
}

export type ToolRiskLevel = 'read_only' | 'standard' | 'elevated' | 'destructive'

export type ToolTier = 'domain_operation' | 'primitive' | 'admin' | 'workflow'

export type ToolLoadStrategy = 'always_load' | 'category_load' | 'deferred'

export type ToolOperationType = 'read' | 'write' | 'mixed'

export type ApprovalMode = 'explicit' | 'implicit' | 'auto'

export type ToolExecutionStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'

export type ToolErrorCategory =
  | 'validation_error'
  | 'permission_denied'
  | 'resource_not_found'
  | 'resource_conflict'
  | 'timeout'
  | 'external_system_error'
  | 'business_rule_violation'
  | 'fatal_error'

// ==================== 工具目录 ====================

/**
 * 后端工具目录项。
 *
 * 设计原则：
 * - name / description / parameters 与 OpenAI function calling 工具定义对齐。
 * - riskLevel / isReadOnly / isConcurrencySafe / isDestructive / requiredPermissions
 *   由后端声明，前端用它们决定审批、并发策略和 UI 提示。
 * - 后端未返回这些元数据时，FrontendToolRegistry 会按工具名关键词兜底推断。
 */
export interface ToolCatalogItem {
  name: string
  description: string
  parameters?: unknown
  riskLevel?: ToolRiskLevel
  isReadOnly?: boolean
  isConcurrencySafe?: boolean
  isDestructive?: boolean
  requiredPermissions?: string[]
  maxResultSizeChars?: number
  /** 工具分类，用于工具发现与 UI 分组 */
  category?: string
  /** 是否延迟加载：首次请求不注入模型上下文，需通过 tool_search 发现 */
  deferred?: boolean
  /** 是否强制始终加载（覆盖 deferred） */
  alwaysLoad?: boolean
  strict?: boolean
  /** 工具层级（v1.3） */
  tier?: ToolTier
  /** 加载策略（v1.4） */
  loadStrategy?: ToolLoadStrategy
  /** 操作类型：读 / 写 / 混合（v1.4） */
  operationType?: ToolOperationType
  /** 审批模式（v1.4） */
  approvalMode?: ApprovalMode
  /** 是否需要显式审批（v1.2） */
  requiresApproval?: boolean
  /** 用户可读的影响陈述句模板（v1.5） */
  impactStatement?: string
  /** 是否幂等（v1.2） */
  idempotent?: boolean
  /** 数据作用域要求（v1.2） */
  requiredDataScopes?: string[]
  /** 受影响实体类型（v1.4） */
  affectedEntityTypes?: string[]
  /** 默认结果截断策略（v1.2） */
  defaultTruncation?: string
  /** 默认超时毫秒（v1.2） */
  defaultTimeoutMs?: number
  /** 拒绝模式：命中任一模式的调用应被前端过滤（v1.2） */
  denyPatterns?: string[]
  /** 工具标签（v1.2） */
  tags?: string[]
  /** 业务域 / 系统范围（v1.2） */
  scopes?: string[]
}

export interface ToolInvokeResult {
  toolName: string
  success: boolean
  data?: string
  error?: string
  structuredData?: unknown
}

export type ToolResultChunkType = 'progress' | 'result' | 'error' | 'cancelled' | 'approval_required' | 'approval_result'

/**
 * 后端 /api/tools/execute 返回的 SSE chunk（v1.2）。
 *
 * 注意：当前后端实现使用统一的 `data` 字段承载进度文本、结果文本和错误文本；
 * `resultData` / `resultSummary` / `progressMessage` 是前端期望的显式字段，
 * 消费端应优先读取显式字段，再回退到 `data`，以兼容两种契约。
 */
export interface ToolResultChunk {
  type: ToolResultChunkType
  toolUseId?: string
  toolName?: string
  executionId?: string
  /** 后端实际发送的进度/结果/错误文本（回退字段） */
  data?: string
  /** 后端实际发送的执行状态 */
  status?: ToolExecutionStatus
  /** 用户可读的影响陈述句（已渲染） */
  impactStatement?: string
  /** 触发审批时的原始工具参数 */
  rawParams?: Record<string, unknown>
  /** 审批过期时间（Unix 毫秒时间戳） */
  expiresAt?: number
  /** 风险等级 */
  riskLevel?: string
  progressMessage?: string
  progressPercent?: number
  resultData?: string
  resultSummary?: string
  structuredData?: unknown
  error?: string
  errorCategory?: ToolErrorCategory
  suggestedFix?: string
  isError?: boolean
  isTruncated?: boolean
  totalCount?: number
  done?: boolean
  startedAt?: string
  completedAt?: string
}

/**
 * 后端 /api/tools/executions/{id}/status 返回的执行状态（v1.2）。
 */
export interface ToolExecutionStatusResponse {
  executionId: string
  toolUseId?: string
  toolName?: string
  status: ToolExecutionStatus
  resultSummary?: string
  structuredData?: unknown
  error?: string
  errorCategory?: ToolErrorCategory
  isTruncated?: boolean
  startedAt?: string
  completedAt?: string
}

/** 工具发现请求（v1.4） */
export interface ToolSearchRequest {
  query: string
  systemCode?: string
  includeTiers?: ToolTier[]
  category?: string
  limit?: number
}

/** 工具发现结果项（v1.4） */
export interface ToolSearchResultItem {
  name: string
  description: string
  tier?: ToolTier
  category?: string
  loadStrategy?: ToolLoadStrategy
  /** 能力目录路径（v1.6），如 /mes/iris/_05Curing */
  path?: string
}

/** 工具发现响应（v1.4） */
export interface ToolSearchResponse {
  tools: ToolSearchResultItem[]
  query?: string
  /** 命中总数（v1.6，可能大于返回条数） */
  total?: number
}

// ==================== 文件系统式能力发现（v1.5） ====================

/** 能力目录树节点 */
export interface CapabilityNode {
  /** 节点短名称 */
  name: string
  /** 节点完整路径 */
  path: string
  /** 节点类型：folder / tool / code_runtime */
  kind: string
  /** 一句话描述 */
  description: string
  /** 工具层级（仅 tool 类型有效） */
  tier?: ToolTier
  /** 分类（仅 tool 类型有效） */
  category?: string
  /** 目录节点的子节点名称列表（仅 folder 类型有效） */
  children?: string[]
  /** 目录下直接挂载的工具数（v1.6，仅 folder 类型有效） */
  toolCount?: number
}

/** GET /api/capabilities/tree 响应 */
export interface CapabilityTreeResponse {
  /** 当前路径 */
  path: string
  /** 当前路径下的节点列表 */
  nodes: CapabilityNode[]
  /** 全库可见工具总数（v1.6） */
  totalTools?: number
  /** 可选提示 */
  note?: string
}

/** GET /api/capabilities/schema 响应 */
export interface CapabilitySchemaResponse {
  /** 工具路径 */
  path: string
  /** 实际工具名 */
  name: string
  /** 工具描述 */
  description: string
  /** 完整参数 schema */
  parameters?: unknown
  /** 风险等级 */
  riskLevel?: ToolRiskLevel
  /** 操作类型 */
  operationType?: ToolOperationType
  /** 是否需要审批 */
  requiresApproval?: boolean
  /** 审批模式 */
  approvalMode?: ApprovalMode
  /** 所需权限标识 */
  requiredPermissions?: string[]
  /** 数据作用域要求 */
  requiredDataScopes?: string[]
  /** 参数级拒绝规则 */
  denyPatterns?: string[]
  /** 是否幂等 */
  idempotent?: boolean
  /** 默认超时毫秒 */
  defaultTimeoutMs?: number
  /** 最大结果字符数 */
  maxResultSizeChars?: number
  /** 工具层级 */
  tier?: ToolTier
  /** 分类 */
  category?: string
}

// ==================== 工具审批 ====================
export interface SubmitToolApprovalRequest {
  executionId: string
  toolUseId: string
  approved: boolean
  reason?: string
}

/**
 * 后端统一工具执行请求。
 * 前端 Agentic 循环在 chat 上下文下，对没有本地 execute 实现的工具调用此接口。
 */
export interface ToolInvokeRequest {
  toolName: string
  /** JSON 字符串，与 OpenAI function.arguments 格式一致 */
  arguments: string
  conversationId?: number
  systemCode?: string
  /** 当前对话轮次的真实用户原话，供需要跨轮确认的后端工具校验。 */
  userMessage?: string
  /** 当前 tool_use / function call 的标识，后端默认用它做幂等键（v1.2） */
  toolUseId?: string
  /** 显式幂等键；缺省时后端使用 toolUseId（v1.2） */
  idempotencyKey?: string
  /** 父 Agent 标识，用于审计与链路追踪（v1.2） */
  parentAgentId?: string
  /** 链路/会话追踪标识（v1.2） */
  traceId?: string
  /** 用户审批决策回传（v1.4） */
  approvalDecisions?: { toolCallId: string; approved: boolean; reason?: string }[]
}

/**
 * 后端能力清单响应。
 * 取代旧 /api/tooltest/list，作为前端发现后端可提供哪些工具/服务的单一入口。
 */
export interface CapabilitiesResponse {
  /** 后端提供的工具目录（兼容字段，包含全部工具） */
  tools: ToolCatalogItem[]
  /** 领域操作工具（v1.3） */
  domainTools?: ToolCatalogItem[]
  /** 原语工具（v1.3） */
  primitiveTools?: ToolCatalogItem[]
  /** 管理员工具（v1.3） */
  adminTools?: ToolCatalogItem[]
  /** 工作流工具（v1.4） */
  workflowTools?: ToolCatalogItem[]
  /** 后端支持的功能标识（用于灰度开关，可选） */
  features?: string[]
  /** 后端版本号 */
  version?: string
  /** 当前系统码 */
  systemCode?: string
  /** 当前系统码下可见工具总数（v1.6） */
  totalToolCount?: number
  /** 业务域宏观洞察（v1.6）：按实际目录动态生成的自然语言概览，可注入系统提示 */
  domainInsight?: string
}

// ==================== 工作区文件系统 ====================

export type WorkspaceNodeKind = 'folder' | 'file'

export interface WorkspaceNode {
  name: string
  path: string
  kind: WorkspaceNodeKind
  sizeBytes?: number
  mimeType?: string
  source?: string
  /** 文件生命周期状态（后端 WorkspaceNodeStatus，JSON 字符串枚举） */
  status?: 'Ready' | 'Processing' | 'Quarantined' | 'Deleted'
  /** 同名文件版本号（上传冲突时递增） */
  version?: number
  /** SHA-256 校验和（上传时计算） */
  checksumSha256?: string
  /** 内容摘要（文件卡片，远期由后端提取） */
  extractedSummary?: string
  downloadUrl?: string
  createdAt?: string
  updatedAt?: string
}

export interface WorkspaceListResponse {
  path: string
  nodes: WorkspaceNode[]
}

export interface WorkspaceReadResponse {
  path: string
  content?: string
  isText: boolean
  sizeBytes: number
  mimeType?: string
  downloadUrl?: string
  updatedAt?: string
}

export interface WorkspaceWriteRequest {
  path: string
  content: string
  append?: boolean
  /** 内容编码；默认 'utf-8'，传 'base64' 时后端会解码为二进制字节写入 */
  encoding?: 'utf-8' | 'base64'
}

/**
 * 后端工具生成的工作区文件元数据。
 * 由 ToolResultChunk.StructuredData.workspaceFiles 携带，供前端工作区面板即时同步。
 */
export interface WorkspaceFileMetadata {
  path: string
  sizeBytes: number
  mimeType?: string
  sourceTool: string
  createdAt?: string
}

/** POST /api/workspace/upload 响应 */
export interface WorkspaceUploadResult {
  path: string
  name: string
  sizeBytes: number
  mimeType?: string
  status: string
  version: number
  checksumSha256?: string
  createdAt?: string
  updatedAt?: string
}

// ==================== 对话 ====================

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface Message {
  role: MessageRole
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  toolCallName?: string
  toolCallStatus?: 'calling' | 'done' | 'error' | 'cancelled'
  structuredData?: unknown
  thinkingProcess?: {
    executionLog: string
    status: 'planning' | 'coding' | 'running' | 'completed' | 'error'
    isExpanded: boolean
  }
  webBridgeState?: {
    stepIndex: number
    totalSteps: number
    url?: string
    title?: string
    screenshot?: string
    lastAction?: string
  }
  /** v1.0 瀑布流渲染节点（会话可视化 Phase 1）。
   *  可选字段，旧消息为 undefined 时前端用 legacyToRenderNodes() 合成。 */
  renderNodes?: import('./chat').RenderNode[]
}

export interface ToolCall {
  id: string
  type: 'function'
  function: FunctionCall
}

export interface FunctionCall {
  name: string
  arguments: string
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters?: unknown
    /** OpenAI/Anthropic structured-output strict mode */
    strict?: boolean
    /** Anthropic deferred-loading beta flag; OpenAI adapters must strip it */
    defer_loading?: boolean
  }
}

export interface ChatRequest {
  provider: string
  apiKey?: string
  baseUrl?: string
  model: string
  conversationId?: number
  messages: Message[]
  skillPrompts?: string[]
  /**
   * 前端代理模式下的自定义系统提示词。
   * 仅由 /api/chat/proxy 使用；后端传统路径会自行构建系统提示。
   */
  systemPrompt?: string
  /** 是否保存到历史记录；内部工作流生成/修复等调用应设为 false */
  saveToHistory?: boolean
  /** M2/M3 执行模式（bypass=全部自动，破坏性操作仍由前端保留确认） */
  executionMode?: 'auto' | 'confirm' | 'sandbox' | 'bypass'
  /** M3 用户审批决策回传 */
  approvalDecisions?: { toolCallId: string; approved: boolean; reason?: string }[]
  /** M2 Standalone 工具调用透传 */
  tools?: ToolDefinition[]
  /**
   * 单次请求最大输出 token 数。此前缺失导致前端 maxTokens 被代理层静默丢弃，
   * 后端 Anthropic 系 Provider 只能写死默认值，长输出被截断（2026-07-24 补）。
   */
  maxTokens?: number
}

export type StreamChunkType =
  | 'content'
  | 'reasoning'
  | 'tool_call'
  | 'tool_start'
  | 'tool_result'
  | 'tool_stdout'
  | 'approval_required'
  | 'approval_result'
  | 'usage'
  | 'error'
  | 'conversation'
  | 'done'

export interface StreamChunk {
  type: StreamChunkType
  content?: string
  /** 模型思考过程（v1.2，reasoning 类型时使用） */
  reasoning?: string
  toolCallId?: string
  toolCalls?: ToolCall[]
  conversationId?: number
  structuredData?: unknown
  /** 当前 turn 的执行模式，用于 M3 审批预埋 */
  executionMode?: 'auto' | 'confirm' | 'sandbox' | 'bypass'
  /** 审批请求/结果信息 */
  approval?: {
    toolCallId: string
    toolName: string
    executionId?: string
    riskLevel?: string
    reason?: string
    /** 已渲染的影响陈述句 */
    impactStatement?: string
    /** 原始工具参数 */
    rawParams?: unknown
    /** 审批过期时间（Unix 毫秒时间戳） */
    expiresAt?: number
    approved?: boolean
  }
  /** 模型真实用量（tokensIn / tokensOut / cacheReadTokens 等） */
  usage?: {
    tokensIn?: number
    tokensOut?: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
  }
  /** 模型停止原因（stop / max_tokens / tool_calls 等） */
  stopReason?: string
}

// ==================== 历史会话 ====================

export interface Conversation {
  id: number
  userId: number
  title: string
  systemCode: string
  createdAt: string
  updatedAt: string
}

export interface CreateConversationRequest {
  title?: string
}

export interface UpdateTitleRequest {
  title: string
}

// ==================== 收藏夹 ====================

export interface FavoriteItem {
  id: number
  userId: number
  title: string
  prompt: string
  systemCode: string
  createdAt: string
  updatedAt: string
}

export interface AddFavoriteRequest {
  title: string
  prompt: string
}

export interface UpdateFavoriteRequest {
  title: string
  prompt: string
}

// ==================== 工作流 ====================

export interface StartWorkflowRequest {
  workflowCode: string
}

export interface StartWorkflowResponse {
  sessionId: string
  workflowName: string
  step: WorkflowStepResponse
}

export interface WorkflowStepResponse {
  type: string
  success: boolean
  error?: string
  step?: WorkflowStep
  context?: WorkflowContext
  summary?: string
  result?: WorkflowResult
}

export interface WorkflowStep {
  id: string
  name: string
  type: string
  prompt?: string
  optional?: boolean
  options?: WorkflowOption[]
  fields?: WorkflowField[]
  searchTool?: string
  displayField?: string
  valueField?: string
  summaryTemplate?: string
}

export interface WorkflowOption {
  label: string
  value: string
}

export interface WorkflowField {
  id: string
  name: string
  type: WorkflowFieldType
  required: boolean
  description?: string
  defaultValue?: string
  source?: string
  sourceDb?: string
  searchTool?: string
  displayField?: string
  valueField?: string
  autoFillFrom?: string
  autoCalc?: string
  min?: number
  max?: number
  pattern?: string
  unit?: string
  options?: { value: string; label: string }[]
}

export type WorkflowFieldType =
  | 'Text'
  | 'Number'
  | 'Decimal'
  | 'Date'
  | 'DateTime'
  | 'Select'
  | 'SearchSelect'
  | 'Checkbox'
  | 'TextArea'

export interface WorkflowStartResponse {
  success: boolean
  error?: string
  sessionId?: string
  workflowName?: string
  step?: WorkflowStepResponse
}

export interface WorkflowContext {
  sessionId: string
  workflowCode: string
  currentStepId: string
  isCompleted: boolean
  collectedData: Record<string, unknown>
}

export interface WorkflowResult {
  success: boolean
  message: string
  documentNo?: string
  extraData?: unknown
}

export interface WorkflowSearchRequest {
  toolName: string
  keyword: string
  limit?: number
}

export interface WorkflowSearchResponse {
  success: boolean
  message?: string
  items: unknown[]
  raw?: unknown
}

// ==================== 配置 ====================

export interface ProviderConfig {
  provider: string
  model: string
  baseUrl: string
  isEnabled?: boolean
  /** 当主模型限流/不可用时尝试的 fallback 模型（同 provider） */
  fallbackModel?: string
}

export interface UserConfigDto {
  provider: string
  model?: string
  baseUrl?: string
  apiKey?: string
}

// ==================== 文件附件 ====================

export type FileAttachmentType = 'image' | 'document' | 'text' | 'unknown'

export interface FileAttachmentDto {
  id: string
  name: string
  type: FileAttachmentType
  mimeType: string
  size: number
  data: string
  previewUrl?: string
  conversationId?: number
  createdAt: string
  /** Workspace 上传模式：文件已持久化到 /workspace/uploads/... */
  workspacePath?: string
  workspaceStatus?: 'ready' | 'processing' | 'error'
  isWorkspaceUpload?: boolean
}

// ==================== 任务进度 ====================

export type TaskStatus = 'pending' | 'running' | 'completed' | 'error'

export interface TaskProgressItem {
  id: string
  title: string
  status: TaskStatus
  detail?: string
}

// ==================== 语音 ====================

export interface VoiceRecognizeResponse {
  text: string
}

// ==================== Cron 定时任务 ====================

export interface CronJobDto {
  id: string
  name: string
  description?: string
  cronExpression: string
  executionMode: string
  payload: Record<string, unknown>
  isEnabled: boolean
  status: string
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  nextRunAt?: string
  runCount: number
  staleAfterDays: number
  stalePolicy: string
}

export interface CronJobListDto {
  tasks: CronJobDto[]
}

export interface CronJobExecutionDto {
  taskId: string
  triggeredAt: string
  completedAt?: string
  status: string
  output?: string
  errorMessage?: string
  coalescedCount: number
  stale: boolean
  executionTimeMs?: number
}

// ==================== 账号（Online 模式） ====================

export interface AccountInfo {
  userId: string
  email?: string
  phone?: string
  displayName?: string
  tenantId?: string
  createdAt: string
}

// ==================== License / 产品激活 ====================

export type LicenseStatus = 'active' | 'inactive' | 'expired' | 'revoked' | 'trial'

export interface MachineFingerprint {
  hardwareId: string
  hostname?: string
  os?: string
  createdAt: string
}

export interface LicenseInfo {
  licenseKey: string
  productName: string
  status: LicenseStatus
  issuedAt: string
  expiresAt?: string
  maxMachines?: number
  activatedMachines?: number
  tenantId?: string
  planId?: string
  tier?: LicenseTier
  seats?: number
  features?: string[]
  metadata?: Record<string, unknown>
}

export type LicenseTier = 'free' | 'pro' | 'enterprise'

export interface LicenseActivationRequest {
  licenseKey: string
  fingerprint: MachineFingerprint
}

export interface LicenseActivationResponse {
  success: boolean
  error?: string
  license?: LicenseInfo
}

// ==================== Quota / Token Plan ====================

export interface TokenPlan {
  id: string
  name: string
  description?: string
  tier: LicenseTier
  monthlySeatPrice?: number
  tokenAmount: number
  price: number
  currency: string
  durationDays?: number
  maxSeats?: number
  features?: string[]
  isActive: boolean
}

export interface QuotaUsage {
  planId?: string
  planName?: string
  totalTokens: number
  usedTokens: number
  remainingTokens: number
  resetAt?: string
  expiresAt?: string
}

// ==================== Payment / 订单 ====================

export type OrderStatus = 'pending_payment' | 'pending_confirm' | 'completed' | 'cancelled' | 'refunded'

export interface Order {
  id: string
  planId: string
  planName: string
  amount: number
  currency: string
  status: OrderStatus
  createdAt: string
  paidAt?: string
  confirmedAt?: string
  proofImageUrl?: string
}

export interface PaymentQrCode {
  type: 'alipay' | 'wechat'
  amount: number
  currency: string
  qrImageUrl: string
  expiresAt?: string
}

export interface CreateOrderRequest {
  planId: string
  paymentMethod?: string
}

export interface SubmitPaymentProofRequest {
  orderId: string
  proofImageUrl: string
  note?: string
}

// ==================== API Key ====================

export type ApiKeyScope = 'chat' | 'workflow' | 'swarm' | 'all'
export type ApiKeyProvider = 'platform' | 'openai' | 'kimi' | 'claude' | 'deepseek' | 'custom'

export interface ApiKeyDto {
  id: string
  tenantId?: string
  userId?: string
  name: string
  provider: ApiKeyProvider
  baseUrl?: string
  /** 仅创建时返回一次，后续不可见 */
  key?: string
  keyHint?: string
  scope: ApiKeyScope
  isDefault?: boolean
  isPlatformManaged?: boolean
  createdAt: string
  lastUsedAt?: string
}

export interface CreateApiKeyRequest {
  name: string
  provider: ApiKeyProvider
  baseUrl?: string
  key: string
  scope?: ApiKeyScope
  isDefault?: boolean
}

// ==================== 用量记录 ====================

export interface UsageRecordDto {
  id?: string
  tenantId?: string
  userId?: string
  date: string
  tokensIn: number
  tokensOut: number
  workflowRuns: number
  webbridgeActions: number
  apiCalls: number
  createdAt?: string
}

export interface ReportUsageRequest {
  records: UsageRecordDto[]
}

// ==================== 本地模型 ====================

export type LocalModelProvider = 'ollama' | 'lmstudio' | 'webllm'

export interface LocalModelInfo {
  id: string
  name: string
  provider: LocalModelProvider
  baseUrl?: string
  size?: number
  parameters?: string
}

export interface LocalModelConfig {
  provider: LocalModelProvider
  baseUrl: string
  model?: string
  apiKey?: string
  temperature?: number
  maxTokens?: number
}
