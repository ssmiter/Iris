/**
 * eventLog — 每 turn 一条追加式事件日志
 *
 * 职责：
 * 1. 维护 RenderEvent[] 有序列表
 * 2. 自动填充 seq / ts / turnId（调用方只需传递 RawRenderEvent）
 * 3. 提供只读访问（events getter）
 *
 * 当前为纯内存实现。IndexedDB 持久化（Phase 3）将通过 eventLogStore 扩展。
 *
 * 设计依据：wonwork-render-kernel-design-v2.0.md §3, §4
 */

import type { RenderEvent, RawRenderEvent } from './renderEvent'

export class EventLog {
  private _events: RenderEvent[] = []
  private _seq = 0
  readonly turnId: string

  constructor(turnId: string) {
    this.turnId = turnId
  }

  /**
   * 追加一条原始事件。自动填充 seq（单调递增）、ts（当前时间戳）、turnId。
   * 调用方只关心"发生了什么"，不关心序号与时间戳。
   */
  append(raw: RawRenderEvent): void {
    // BUG-23: 防御——拒绝含不匹配 turnId 的事件（非本 turn 事件不可写入）
    if ((raw as Record<string, unknown>).turnId != null && (raw as Record<string, unknown>).turnId !== this.turnId) {
      return
    }
    this._seq++
    const event: RenderEvent = {
      ...raw,
      seq: this._seq,
      ts: Date.now(),
      turnId: this.turnId,
    } as RenderEvent
    this._events.push(event)
  }

  /** 只读事件列表（BUG-23: 返回快照副本防止外部 push 篡改） */
  get events(): readonly RenderEvent[] {
    return [...this._events]
  }

  /** 事件总数 */
  get length(): number {
    return this._events.length
  }

  /** 清空日志（turn 重置或 abort 时使用） */
  clear(): void {
    this._events = []
    this._seq = 0
  }

  /** BUG-20: 回滚到指定 checkpoint，用于重试时清除失败尝试的残留事件 */
  rewindTo(length: number): void {
    if (length < 0) length = 0
    if (length >= this._events.length) return
    this._events.length = length
    this._seq = length
  }
}
