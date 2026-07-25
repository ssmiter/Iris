/**
 * Chat 相关类型定义
 * 从 chatStore.ts 提取出来，供多个 store 和组件共享
 */

import type { Message, FileAttachmentDto, ToolCall } from './mescli'
import type { ApprovalRequest } from '@/agent/types'

// ==================== ChatMessage ====================

export interface ThinkingProcessData {
  executionLog: string
  status: 'planning' | 'coding' | 'running' | 'completed' | 'error'
  isExpanded: boolean
}

// ==================== RenderNode（瀑布流渲染节点） ====================

/** 过程节点通用状态 */
export type ProcessNodeStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

/** 注意力节点状态 */
export type AttentionNodeStatus = 'waiting' | 'resolved' | 'skipped' | 'timeout' | 'cancelled'

/** 注意力子类型：决定 UI 卡片形态 */
export type AttentionSubtype = 'takeover' | 'approval' | 'clarify' | 'auth'

/** 产物节点类型 */
export type ArtifactType = 'table' | 'chart' | 'image' | 'file' | 'browser'

/** 渲染节点 ID：保证虚拟列表 key 稳定，格式 {turnId}:{type}:{seq} */
export type RenderNodeId = string

/** 所有渲染节点的共享字段 */
export interface RenderNodeBase {
  id: RenderNodeId
  /** 归属的组合容器 ID（ParallelGroup / RetryGroup） */
  groupId?: string
  /** 小模型写入的渲染元数据，不进对话上下文 */
  renderMeta?: Record<string, unknown>
}

export interface ThinkingNode extends RenderNodeBase {
  id: RenderNodeId
  type: 'thinking'
  status: 'running' | 'done'
  title: string
  content: string
  /** 思考角色：think=普通思考 / verify=回检验证 */
  role?: 'think' | 'verify'
  startedAt: number
  durationMs?: number
}

export interface ToolNode extends RenderNodeBase {
  id: RenderNodeId
  type: 'tool'
  status: ProcessNodeStatus
  toolName: string
  args?: string
  summary: string
  /** 重试次数（0 = 首次尝试） */
  attempt?: number
  startedAt: number
  durationMs?: number
  /** 工具结果的可选结构化数据（供产物提升时读取） */
  result?: unknown
  /** 执行日志（stdout/stderr） */
  executionLog?: string
}

export interface AttentionNode extends RenderNodeBase {
  id: RenderNodeId
  type: 'attention'
  status: AttentionNodeStatus
  /** 干预子类型，决定渲染哪种卡片 */
  subtype?: AttentionSubtype
  reason: string
  toolName?: string
  /** 审批时对应的 toolCallId（用于 approve/reject） */
  toolCallId?: string
  /** 给用户的说明文字 */
  prompt?: string
  /** 澄清选项列表（subtype='clarify' 时使用） */
  options?: string[]
  startedAt: number
  durationMs?: number
}

export interface ArtifactNode extends RenderNodeBase {
  id: RenderNodeId
  type: 'artifact'
  artifactType: ArtifactType
  title: string
  /** 跨轮次可引用的产物 ID */
  artifactId: string
  /** 同一产物被更新时 +1，旧版本可回看 */
  version?: number
  /** 溯源：生成此产物的工具节点 ID */
  sourceToolCallId?: string
  /** 渲染所需数据（表格行、图表数据、workspace 路径等）。
   *  注意：大数据只存 workspace path，不存完整 blob。 */
  payload: unknown
  startedAt: number
}

export interface AnswerNode extends RenderNodeBase {
  id: RenderNodeId
  type: 'answer'
  status: 'streaming' | 'done' | 'error' | 'stopped'
  content: string
  startedAt: number
}

export type RenderNode = ThinkingNode | ToolNode | AttentionNode | ArtifactNode | AnswerNode

/** 过程中用户补充记录（§7 SupplementGateway） */
export interface SupplementRecord {
  /** 补充消息的唯一 ID */
  msgId: string
  /** 用户补充文本 */
  text: string
  /** 时间戳 */
  ts: number
  /** 是否已注入模型上下文 */
  injected: boolean
  /** 在事件序列中的注入位置 seq */
  injectedAfterSeq?: number
  /** v9.2：注入时所处的轮次索引（渲染定位=该轮之后，即"阶段结论之后进入"） */
  roundIndex?: number
}

// ==================== ChatMessageStatus ====================

/** 消息状态机：从用户发送后到最终完成的完整生命周期 */
export type ChatMessageStatus =
  | 'thinking'      // 模型正在思考
  | 'streaming'     // 正在输出最终回复
  | 'calling_tools' // 正在调用工具
  | 'awaiting_approval' // 等待用户审批
  | 'done'          // 完成
  | 'error'         // 出错
  | 'cancelled'     // 已取消

export interface ChatMessage extends Message {
  id: string
  isStreaming?: boolean
  timestamp?: number
  structuredData?: unknown
  toolCallStatus?: 'calling' | 'done' | 'error' | 'cancelled'
  toolCallName?: string
  attachments?: FileAttachmentDto[]
  thinkingProcess?: ThinkingProcessData
  webBridgeState?: {
    stepIndex: number
    totalSteps: number
    url?: string
    title?: string
    screenshot?: string
    lastAction?: string
  }
  /** 消息状态 */
  status?: ChatMessageStatus
  /** 模型 reasoning / thinking 内容（可折叠展示） */
  reasoningContent?: string
  /** 思考过程内容（可折叠展示） */
  thinkingContent?: string
  /** 思考持续时间（毫秒） */
  thinkingDuration?: number
  /** 错误信息，status 为 error 时显示 */
  errorMessage?: string
  /** 用户反馈：like 点赞 / dislike 点踩 / null 无 */
  feedback?: 'like' | 'dislike' | null
  /** 助手消息携带的 tool_use 请求 */
  toolCalls?: ToolCall[]
  /** 执行模式：auto 自动 / confirm 确认 / sandbox 沙箱 / bypass 全部自动 */
  executionMode?: 'auto' | 'confirm' | 'sandbox' | 'bypass'
  /** 审批状态 */
  approvalStatus?: 'pending' | 'approved' | 'rejected'
  /** v1.0 瀑布流渲染节点列表。由 renderNodeBuilder 在 agenticLoop 中填充，
   *  按时间顺序排列（thinking → tool... → attention → artifact → answer）。
   *  可选字段：旧消息为 undefined 时前端用 legacyToRenderNodes() 合成。 */
  renderNodes?: RenderNode[]
  /** 过程中补充标记：用户在模型工作期间发送的额外指令（§7 SupplementGateway） */
  isSupplement?: boolean
  /** 内核投影的 turn 相位（唯一事实源）；旧消息为 undefined 时前端按启发式兜底一次并写回 */
  turnPhase?: 'active' | 'settled' | 'stopped' | 'failed'
  /** 内核统计（唯一事实源），由 turnProjector.computeStats 填充 */
  turnStats?: TurnStats
  /** 工具执行停滞标记：超时看门狗发现工具无进展时置 true */
  stalled?: boolean
  /** v4.0 轮次快照（持久化 & 初始渲染；旧消息无此字段时按单 round 兜底） */
  rounds?: RoundSnapshot[]
  /** v4.0 各轮 answer 文本按序；msg.content = answers.join('\n\n') 保持兼容 */
  answers?: string[]
  /** v9.2 过程中补充的投影记录（含注入时轮次 roundIndex），渲染定位用 */
  supplements?: SupplementRecord[]
}

// ==================== RoundStats / RoundState（v4.0 轮次模型） ====================

/** 单轮统计（投影时由 computeRoundStats 一次性算出） */
export interface RoundStats {
  thinkingCount: number
  thinkingMs: number
  toolCount: number
  toolDoneCount: number
  errorCount: number
  cancelledCount: number
  attentionCount: number
  artifactCount: number
  totalMs: number
  firstStartedAt: number
}

/** Turn 投影产出——每轮独立状态 */
export interface RoundState {
  index: number
  nodeIds: RenderNodeId[]
  answerNodeId?: RenderNodeId
  phase: 'active' | 'settled' | 'stopped' | 'failed'
  stats: RoundStats
}

/** 持久化 round 快照（存入 ChatMessage，不存完整节点数据仅存引用） */
export interface RoundSnapshot {
  index: number
  nodeIds: RenderNodeId[]
  answerNodeId?: RenderNodeId
  phase: 'active' | 'settled' | 'stopped' | 'failed'
  stats: RoundStats
}

// ==================== TurnStats（内核投影统计） ====================

export interface TurnStats {
  toolCount: number
  toolDoneCount: number
  errorCount: number
  cancelledCount: number
  attentionCount: number
  artifactCount: number
  thinkingCount: number
  thinkingMs: number
  totalMs: number
  firstStartedAt: number
  /** v4.0: 回合数（project 时聚合） */
  roundCount?: number
}

// ==================== ChatState（chatStore 核心状态接口） ====================

export interface ChatCoreState {
  messages: ChatMessage[]
  isLoading: boolean
  isStreaming: boolean
  error: string | null

  // 提供商
  providers: import('./mescli').ProviderConfig[]
  activeProvider: import('./mescli').ProviderConfig | null
  /** 当前对话凭据来源（TokenHub 套餐 / BYOK / 自配 API / 后端配置），由 resolveProviderCredentials 写入 */
  activeKeySource: string | null

  // 上下文 token 追踪
  currentContextTokens: number
  contextWindowSize: number

  // WebBridge 对话状态
  lastAssistantWorkflowJson: unknown | null
  pendingSecurityPreset: string | null

  // PPT 模板选择
  pptTemplateSelection: {
    isPending: boolean
    content: string
    attachmentIds?: string[]
  } | null

  // M3 审批闸：待审批工具调用列表
  pendingApprovals: ApprovalRequest[]
}

// Re-export mescli types for convenience (these are chat-related)
export type { Conversation, FavoriteItem, StreamChunk, ProviderConfig } from './mescli'
