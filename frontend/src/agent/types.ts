/**
 * 对话内核类型（docs/06）。渲染的唯一真相是 renderNodes——
 * UI 组件只读节点，绝不解析消息文本推断状态。
 */

export type Role = 'user' | 'assistant' | 'tool' | 'system'

export interface ChatMessage {
  id: string
  role: Role
  content: string
  timestamp?: number
  /** 补充注入标记：运行中输入的中途指令（不占气泡层级） */
  isSupplement?: boolean
  /** 渲染节点：过程流（thinking/tool/answer/attention/artifact） */
  renderNodes?: RenderNode[]
  /** 轮次快照：每轮节点归属与统计 */
  rounds?: RoundSnapshot[]
}

export type RenderNode =
  | ThinkingNode
  | ToolNode
  | AnswerNode
  | AttentionNode
  | ArtifactNode

interface NodeBase {
  id: string
  /** 节点分组（并行调用/重试序列归为一组展示） */
  groupId?: string
}

export interface ThinkingNode extends NodeBase {
  type: 'thinking'
  content: string
  status: 'streaming' | 'done'
  durationMs?: number
}

export interface ToolNode extends NodeBase {
  type: 'tool'
  toolName: string
  summary: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  result?: unknown
  durationMs?: number
}

export interface AnswerNode extends NodeBase {
  type: 'answer'
  content: string
  status: 'streaming' | 'done' | 'stopped' | 'error'
}

export interface AttentionNode extends NodeBase {
  type: 'attention'
  subtype: 'approval' | 'clarify' | 'takeover' | 'auth'
  reason: string
  prompt?: string
  options?: string[]
  toolCallId?: string
  status: 'waiting' | 'resolved' | 'skipped' | 'timeout' | 'cancelled'
}

export interface ArtifactNode extends NodeBase {
  type: 'artifact'
  artifactId: string
  path: string
  kind: 'document' | 'image' | 'table' | 'other'
  previewRef?: string
  downloadRef?: string
  byteCount?: number
  sourceToolCallId?: string
}

export interface RoundSnapshot {
  index: number
  nodeIds: string[]
  answerNodeId?: string
  stats: RoundStats
  phase: 'active' | 'settled' | 'stopped' | 'failed'
}

export interface RoundStats {
  thinkingMs: number
  toolCount: number
  toolDoneCount: number
  totalMs: number
}

/** 分支变体：同一锚点用户消息的一次"重新发问"及其完整后续快照 */
export interface BranchVariant {
  id: string
  text: string
  /** 该变体的锚点消息 id（活路径定位） */
  anchorMsgId?: string
  /** 完整尾部快照（含 renderNodes/工具结构——不裁剪，切换无损） */
  tail: ChatMessage[]
}

/**
 * 分支锚点。key 恒为首个变体的锚点消息 id；
 * 从非首变体上编辑时按变体 anchorMsgId 找回真锚点。
 */
export interface BranchAnchor {
  anchorId: string
  anchorText: string
  snapshotMsgId?: string
  variants: BranchVariant[]
  active: number
}

/**
 * 压缩线：历史不动，只标记"context 从哪算起"。
 * 位置语义：分叉点在线后用本轮摘要，在线前落回更早的线（第 0 条线=无压缩）。
 */
export interface CompactBoundary {
  id: string
  cutoffTs: number
  summary: string
  coveredCount: number
  trigger: 'manual' | 'auto'
}
