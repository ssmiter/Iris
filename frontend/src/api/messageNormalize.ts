/**
 * 消息载荷归一化（自 standaloneApi.ts 迁出，2026-09 standalone 死代码清理）。
 * structuredData / renderNodes 可能是 JSON 字符串（后端 History API 返回字符串；
 * IndexedDB 存对象但旧数据可能是字符串），在 API 边界统一解析成对象，
 * 调用方不再逐条 try/catch。
 */
import type { Message } from '@/types/mescli'

export function normalizeMessagePayload(m: Message): Message {
  let structuredData = (m as { structuredData?: unknown }).structuredData
  if (typeof structuredData === 'string' && structuredData) {
    try {
      structuredData = JSON.parse(structuredData)
    } catch {
      // 单条消息 structuredData 解析失败不应阻断整页加载
    }
  }
  let renderNodes = (m as { renderNodes?: unknown }).renderNodes
  if (typeof renderNodes === 'string' && renderNodes) {
    try {
      renderNodes = JSON.parse(renderNodes)
    } catch {
      renderNodes = undefined
    }
  }
  return { ...m, structuredData, renderNodes } as Message
}
