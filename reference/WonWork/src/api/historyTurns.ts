import type { Message } from '@/types/mescli'

/**
 * 历史消息轮次切分与轻量行化（2026-09-02 §16.6 长程会话历史分层加载）。
 * 与后端 MessageTurnSlicer 同规则的 JS 版：standalone / IndexedDB 存量车道没有后端切片，
 * 在内存里做同形状切片，保证两条车道喂给 chatStore 的数据形状一致。
 * 轮次规则 = role=user 且非补充消息开启新一轮（与 MessageList.groupMessagesIntoTurns 一致）。
 */

/** 轻量行 content 预览长度（与后端 MessageTurnSlicer.LightContentPreviewChars 一致） */
export const LIGHT_CONTENT_PREVIEW_CHARS = 200

export interface LayeredMessages {
  messages: Message[]
  totalTurns: number
}

/** 就地标注每行 index（数组序）与 turnIndex，返回同一数组 */
export function assignTurns(messages: Message[]): Message[] {
  let turn = -1
  messages.forEach((m, i) => {
    if (m.role === 'user' && !(m as { isSupplement?: boolean }).isSupplement) turn++
    m.index = i
    m.turnIndex = Math.max(turn, 0)
  })
  return messages
}

/**
 * 就地轻量行化：剥全部重字段与配对字段（toolCallId/Name/Status 一并剥——
 * 轻行不参与工具配对修复，保留反而会被当 orphan 剔除），content 截断为预览。
 * 必须在 assignTurns 之后调用（轻行化会毁掉 isSupplement 判定依据）。
 */
export function makeLight(m: Message): void {
  delete m.toolCalls
  delete m.toolCallId
  delete m.toolCallName
  delete m.toolCallStatus
  delete m.structuredData
  delete m.thinkingProcess
  delete m.webBridgeState
  delete m.renderNodes
  delete m.reasoningContent
  delete (m as { extras?: unknown }).extras
  if (m.content.length > LIGHT_CONTENT_PREVIEW_CHARS)
    m.content = m.content.slice(0, LIGHT_CONTENT_PREVIEW_CHARS) + '…'
  m.light = true
}

/** 尾部 tailTurns 轮全量 + 更早轮轻量行。会修改入参数组内对象（调用方保证非共享引用） */
export function sliceTail(messages: Message[], tailTurns: number): LayeredMessages {
  assignTurns(messages)
  const totalTurns = messages.length === 0 ? 0 : (messages[messages.length - 1].turnIndex ?? 0) + 1
  const cutoff = Math.max(0, totalTurns - Math.max(tailTurns, 1))
  for (const m of messages) if ((m.turnIndex ?? 0) < cutoff) makeLight(m)
  return { messages, totalTurns }
}

/** turns [fromTurn, toTurnExclusive) 的全量行（带 index/turnIndex）。会修改入参数组内对象 */
export function sliceTurnRange(messages: Message[], fromTurn: number, toTurnExclusive: number): Message[] {
  assignTurns(messages)
  return messages.filter((m) => (m.turnIndex ?? 0) >= fromTurn && (m.turnIndex ?? 0) < toTurnExclusive)
}
