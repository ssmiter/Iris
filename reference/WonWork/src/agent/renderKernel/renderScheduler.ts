/**
 * renderScheduler — 自适应三车道渲染调度器
 *
 * 替换 agenticLoop 中固定的 200ms 节流，改为：
 *
 * 快车道（flushNow）：attention / tool_error / error / lifecycle / done
 *   立即冲刷——用户需要即时感知的错误、审批、生命周期事件。
 *
 * 短车道（tool_start）：首次立即（保 TTFT），后续 600ms
 *   工具启动需要快速反馈，但连续启动多个时缓冲以让并行工具出生在同一帧。
 *
 * 常规车道（content / reasoning / tool_done）：自适应节拍 + 答案量子触发
 *   content 与 tool_done 合批——让"工具完成 + 答案开始"发生在同一帧；
 *   工具在短车道窗口内 start+done → 自然实现终态前置（投影器同时看到 start+done 事件）。
 *
 * 节拍公式：flushInterval = clamp(1200, 1200 × sqrt(pendingEvents / 4), 2000) ms
 *
 * 触发条件（任一满足即立即冲刷）：
 *  ① 自适应节拍到达
 *  ② 答案量子：answer.delta 文本累计 ≥ 120 字
 *  ③ 页面从隐藏恢复可见
 *
 * 设计依据：wonwork-render-kernel-design-v2.0.md §4
 * + 离散→连续平滑化计划 proud-sniffing-whale.md §A
 */

// ── 设计 tokens ────────────────────────────────────────────

const BASE_INTERVAL = 1200   // ms，无积压时的基准间隔
const MAX_INTERVAL = 2000    // ms，积压再多也不超过
const ANSWER_QUANTUM = 120   // 字，答案文本累计阈值
const TOOL_START_INTERVAL = 600  // ms，短车道工具启动缓冲窗口

// ── types ──────────────────────────────────────────────────

/** 事件分类（决定进入哪条车道） */
export type SchedulerEventKind =
  | 'content'
  | 'reasoning'
  | 'tool_start'
  | 'tool_done'
  | 'tool_error'
  | 'attention'
  | 'lifecycle'
  | 'done'

export interface SchedulerCallbacks {
  /** 调度器决定冲刷时调用（执行 BatchPlanner + React setState） */
  onFlush: () => void
}

// ── RenderScheduler ────────────────────────────────────────

export class RenderScheduler {
  private _onFlush: () => void
  private _timer: ReturnType<typeof setTimeout> | null = null
  private _firstFlushed = false
  private _firstToolStart = false
  private _pendingCount = 0
  private _answerCharsSinceFlush = 0
  private _visibilityHandler: (() => void) | null = null
  private _destroyed = false

  constructor(callbacks: SchedulerCallbacks) {
    this._onFlush = callbacks.onFlush
    this._bindVisibility()
  }

  // ── public API ──────────────────────────────────────

  /**
   * 记录一个事件到达。调度器据此决定立即冲刷还是排入节拍。
   */
  noteEvent(
    kind: SchedulerEventKind,
    extra?: { answerChars?: number }
  ): void {
    if (this._destroyed) return

    // ── 快车道：立即冲刷 ──
    if (
      kind === 'attention' ||
      kind === 'tool_error' ||
      kind === 'lifecycle' ||
      kind === 'done'
    ) {
      this.flushNow()
      return
    }

    // ── 短车道：tool_start 首次立即（保 TTFT），后续缓冲 600ms ──
    if (kind === 'tool_start') {
      if (!this._firstToolStart) {
        this._firstToolStart = true
        // 若常规车道无积压 → 立即显式；否则排入当前批次一起 flush
        if (this._pendingCount === 0 && !this._timer) {
          this._onFlush()
          return
        }
        // 有积压：不单独 flush（让 tool_start 和已积累的 content/reasoning 同帧）
      }
      // 后续 tool_start 走短定时器（与常规车道共用调度，但用更短的间隔）
      this._pendingCount++
      this._schedule(TOOL_START_INTERVAL)
      return
    }

    // ── 常规车道：content / reasoning / tool_done ──

    // 首帧立即显示（保 TTFT 体感）
    if (!this._firstFlushed) {
      this._firstFlushed = true
      this._onFlush()
      return
    }

    // 累积 + 调度
    this._pendingCount++
    if (extra?.answerChars) this._answerCharsSinceFlush += extra.answerChars

    // 答案量子触发
    if (this._answerCharsSinceFlush >= ANSWER_QUANTUM) {
      this._flush()
    } else {
      this._schedule()
    }
  }

  /**
   * 快车道入口：立即冲刷，清空定时器与缓冲。
   * 调用方在 attention / error / lifecycle / done 场景直接调用。
   */
  flushNow(): void {
    if (this._destroyed) return
    this._clearTimer()
    this._flush()
  }

  /** 取消定时器、重置缓冲（abort / turn 结束时调用） */
  clear(): void {
    this._clearTimer()
    this._pendingCount = 0
    this._answerCharsSinceFlush = 0
    this._firstFlushed = false
    this._firstToolStart = false
  }

  /** 销毁调度器，移除全局监听。置 _destroyed 防后续 ghost flush */
  destroy(): void {
    this.clear()
    this._destroyed = true
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler)
      this._visibilityHandler = null
    }
  }

  // ── private ──────────────────────────────────────────

  private _schedule(forceInterval?: number): void {
    if (this._timer) return // 已排期，不重复
    const interval = forceInterval ?? this._calcInterval()
    this._timer = setTimeout(() => {
      this._timer = null
      this._flush()
    }, interval)
  }

  /** 页面从隐藏恢复 → 立即冲刷积压 */
  private _bindVisibility(): void {
    this._visibilityHandler = () => {
      if (document.visibilityState === 'visible' && this._pendingCount > 0) {
        this._flush()
      }
    }
    document.addEventListener('visibilitychange', this._visibilityHandler)
  }

  private _calcInterval(): number {
    if (this._pendingCount <= 1) return BASE_INTERVAL
    // flushInterval = clamp(1200, 1200 × sqrt(pending / 4), 2000)
    const raw = BASE_INTERVAL * Math.sqrt(this._pendingCount / 4)
    return Math.min(Math.max(raw, BASE_INTERVAL), MAX_INTERVAL)
  }

  private _flush(): void {
    this._pendingCount = 0
    this._answerCharsSinceFlush = 0
    this._onFlush()
  }

  private _clearTimer(): void {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
  }
}
