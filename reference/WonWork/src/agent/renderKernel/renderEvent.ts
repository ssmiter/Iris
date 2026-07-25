/**
 * renderEvent — 标准化 RenderEvent 信封
 *
 * 所有下游（EventLog / TurnProjector / BatchPlanner）只认此信封格式，
 * 与传输层（SSE chunk）解耦。seq 由 EventLog 单调分配，保证幂等重放。
 *
 * 设计依据：wonwork-render-kernel-design-v2.0.md §3
 */

import type { ArtifactType, AttentionSubtype } from '@/types/chat'

// ── 载荷类型 ──────────────────────────────────────────────

/** node.start 事件的节点描述 */
export interface NodeEnvelope {
  kind: 'thinking' | 'tool' | 'verify' | 'attention' | 'answer'
  /** 由 builder 生成的稳定 ID；projector 直接使用，避免双方 ID 生成逻辑不一致 */
  id?: string
  label?: string
  toolName?: string
  toolCallId?: string
  args?: string
  groupId?: string
}

/** node.done 事件的元数据 */
export interface NodeDoneMeta {
  durationMs?: number
  summary?: string
  result?: unknown
  success?: boolean
  /** BUG-21: 显式标记为用户取消，projector 映射为 'cancelled' 而非 'done' */
  cancelled?: boolean
}

/** node.error 事件的错误信息 */
export interface ErrorInfo {
  message: string
  retryable?: boolean
}

/** artifact.present 事件的产物载荷 */
export interface ArtifactPayload {
  artifactType: ArtifactType
  title: string
  payload: unknown
  sourceToolCallId?: string
}

/** attention.request 事件的注意力载荷 */
export interface AttentionPayload {
  /** 由 builder 生成的稳定 ID；projector 直接使用 */
  id?: string
  subtype?: AttentionSubtype
  reason: string
  toolName?: string
  prompt?: string
  options?: string[]
  toolCallId?: string
}

// ── 事件联合类型 ──────────────────────────────────────────

export type RenderEvent =
  | { seq: number; ts: number; turnId: string; type: 'round.start'; roundIndex: number }
  | { seq: number; ts: number; turnId: string; type: 'round.settle'; roundIndex: number }
  | { seq: number; ts: number; turnId: string; type: 'node.start'; node: NodeEnvelope }
  | { seq: number; ts: number; turnId: string; type: 'node.delta'; id: string; text?: string; log?: string; args?: string; groupId?: string; status?: import('@/types/chat').ProcessNodeStatus }
  | { seq: number; ts: number; turnId: string; type: 'node.done'; id: string; meta: NodeDoneMeta }
  | { seq: number; ts: number; turnId: string; type: 'node.error'; id: string; error: ErrorInfo }
  | { seq: number; ts: number; turnId: string; type: 'artifact.present'; artifact: ArtifactPayload; roundIndex: number }
  | { seq: number; ts: number; turnId: string; type: 'attention.request'; attention: AttentionPayload }
  | { seq: number; ts: number; turnId: string; type: 'attention.resolve'; id: string; result: 'resolved' | 'skipped' | 'timeout'; value?: string }
  | { seq: number; ts: number; turnId: string; type: 'answer.delta'; roundIndex: number; text: string }
  | { seq: number; ts: number; turnId: string; type: 'answer.done'; roundIndex: number }
  | { seq: number; ts: number; turnId: string; type: 'answer.error'; roundIndex: number; error: ErrorInfo }
  | { seq: number; ts: number; turnId: string; type: 'answer.abort'; roundIndex: number }
  | { seq: number; ts: number; turnId: string; type: 'turn.settle' }
  | { seq: number; ts: number; turnId: string; type: 'turn.abort'; reason: 'user' | 'error' | 'disconnect' }
  | { seq: number; ts: number; turnId: string; type: 'supplement'; text: string; msgId: string }

/** DistributiveOmit：对联合类型的每个成员分别 Omit，保留 discriminated union 结构 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** 未填充 seq/ts/turnId 的原始事件（由 EventLog 自动补全） */
export type RawRenderEvent = DistributiveOmit<RenderEvent, 'seq' | 'ts' | 'turnId'>

// ── 工厂函数 ──────────────────────────────────────────────

export const eventFactory = {
  // ── v4.0 round 生命周期 ──

  roundStart(roundIndex: number): RawRenderEvent {
    return { type: 'round.start', roundIndex }
  },

  roundSettle(roundIndex: number): RawRenderEvent {
    return { type: 'round.settle', roundIndex }
  },

  // ── 节点 ──

  nodeStart(node: NodeEnvelope): RawRenderEvent {
    return { type: 'node.start', node }
  },

  nodeDelta(id: string, payload: { text?: string; log?: string; args?: string; groupId?: string; status?: import('@/types/chat').ProcessNodeStatus }): RawRenderEvent {
    return { type: 'node.delta', id, ...payload }
  },

  nodeDone(id: string, meta: NodeDoneMeta): RawRenderEvent {
    return { type: 'node.done', id, meta }
  },

  nodeError(id: string, error: ErrorInfo): RawRenderEvent {
    return { type: 'node.error', id, error }
  },

  artifactPresent(artifact: ArtifactPayload, roundIndex: number): RawRenderEvent {
    return { type: 'artifact.present', artifact, roundIndex }
  },

  attentionRequest(attention: AttentionPayload): RawRenderEvent {
    return { type: 'attention.request', attention }
  },

  attentionResolve(id: string, result: 'resolved' | 'skipped' | 'timeout', value?: string): RawRenderEvent {
    return { type: 'attention.resolve', id, result, value }
  },

  // ── answer（v4.0: 携带 roundIndex 定位所属轮次） ──

  answerDelta(roundIndex: number, text: string): RawRenderEvent {
    return { type: 'answer.delta', roundIndex, text }
  },

  answerDone(roundIndex: number): RawRenderEvent {
    return { type: 'answer.done', roundIndex }
  },

  answerAbort(roundIndex: number): RawRenderEvent {
    return { type: 'answer.abort', roundIndex }
  },

  answerError(roundIndex: number, error: ErrorInfo): RawRenderEvent {
    return { type: 'answer.error', roundIndex, error }
  },

  // ── turn ──

  turnSettle(): RawRenderEvent {
    return { type: 'turn.settle' }
  },

  turnAbort(reason: 'user' | 'error' | 'disconnect'): RawRenderEvent {
    return { type: 'turn.abort', reason }
  },

  supplement(text: string, msgId: string): RawRenderEvent {
    return { type: 'supplement', text, msgId }
  },
}
