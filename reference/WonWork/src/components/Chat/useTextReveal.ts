/**
 * useReveal — 共享 rAF ticker 驱动的流式文字揭示引擎（视觉时钟）
 *
 * 核心设计：缓冲的是数据（renderScheduler 100ms 节拍），不是视觉。
 * 引擎坐在"数据到达"与"DOM 呈现"之间，把脉冲输入平滑成连续输出：
 *
 *   数据节拍（scheduler flush）→ RevealController.frontier（连续时间）→ React 发布（≤28ms 节流）
 *
 * 关键机制（对齐 Iris docs/24-silky-interaction.md §2）：
 * - 到达速率 EMA 平滑（0.72/0.28），抗脉冲抖动；
 * - 揭示速率 = 到达速率 × 1.25，钳 [40, 600] 字/秒——略快于到达，落后不超过小窗口；
 * - 积压快进：backlog > 360 字时直接跳到只留 220 字尾巴，防止大脉冲后长时间"欠账追赶"；
 * - 完成追尾（settleTarget）：完成只表示事实不再增长，视觉前沿追平后才算终态；
 * - useSyncExternalStore 按块订阅：重渲染范围锁在单个答案/思考块内，不拖累整个 Turn；
 * - prefers-reduced-motion：跳过引擎，即时全量呈现。
 *
 * 设计依据：Iris frontend/src/motion/revealEngine.ts（已验证机制移植）
 */

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'

// ── 设计 tokens ────────────────────────────────────────────

const revealMotion = {
  /** 首帧快进：挂载已推进中的流时，直接揭示到尾部前 N 字 */
  firstFrameTail: 24,
  /** 积压快进后保留的尾巴长度 */
  retainedBacklog: 220,
  /** 积压超过该值触发快进 */
  backlogFastForwardThreshold: 360,
  minCharactersPerSecond: 40,
  maxCharactersPerSecond: 600,
  /** 揭示速率 = 到达速率 × 1.25 */
  arrivalRateMultiplier: 1.25,
  /** 单帧 dt 封顶，切 tab 回来后不大跳 */
  maximumFrameDeltaMs: 100,
  /** React 发布节流（ms），约 35 次/秒 */
  minimumPublishIntervalMs: 28,
} as const

// ── 全局共享 ticker ─────────────────────────────────────

const activeControllers = new Set<RevealController>()
let animationFrame: number | null = null
let previousFrameAt = 0

function requestNextFrame() {
  if (animationFrame !== null || activeControllers.size === 0) return
  animationFrame = window.requestAnimationFrame(runFrame)
}

function runFrame(now: number) {
  animationFrame = null
  const elapsed = previousFrameAt === 0 ? 16 : Math.min(now - previousFrameAt, revealMotion.maximumFrameDeltaMs)
  previousFrameAt = now

  for (const controller of activeControllers) {
    if (!controller.advance(elapsed, now)) {
      activeControllers.delete(controller)
    }
  }

  if (activeControllers.size > 0) {
    requestNextFrame()
  } else {
    previousFrameAt = 0
  }
}

function activate(controller: RevealController) {
  activeControllers.add(controller)
  requestNextFrame()
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

// ── RevealController ────────────────────────────────────

type RevealListener = () => void

/**
 * 单个文本块的揭示控制器。
 * 不是第二份状态：target 永远是权威全文（由数据层 setTarget 更新），
 * 控制器只持有 frontier 与速率两个标量，输出"当前应显示的前缀"。
 */
class RevealController {
  private target = ''
  private visible = ''
  private frontier = 0
  private animated = false
  private arrivalRate = 0
  private lastArrivalAt = 0
  private lastArrivalLength = 0
  private lastPublishedAt = 0
  private readonly listeners = new Set<RevealListener>()

  constructor(target: string, animated: boolean) {
    this.setTarget(target, animated, true)
  }

  subscribe = (listener: RevealListener) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = () => this.visible

  /** 数据层更新权威目标。animated=false 时立即全量（水合/历史/非流式场景）。 */
  setTarget(target: string, animated: boolean, initial = false) {
    const now = performance.now()
    const previousLength = this.target.length
    const targetChanged = target !== this.target

    this.target = target
    this.animated = animated

    if (!animated) {
      this.frontier = target.length
      this.visible = target
      this.publish()
      activeControllers.delete(this)
      return
    }

    if (targetChanged && target.length >= previousLength) {
      this.observeArrival(target.length, now)
    }

    if (initial) {
      // 首帧快进：重新挂载已推进中的流，只给最后一小段留动画
      this.frontier = Math.max(0, target.length - revealMotion.firstFrameTail)
      this.visible = target.slice(0, Math.floor(this.frontier))
      this.lastArrivalLength = target.length
      this.lastArrivalAt = now
    } else if (target.length < previousLength) {
      // 文本变短（重置/失效）→ frontier 钳到新长度
      this.frontier = Math.min(this.frontier, target.length)
      this.visible = target.slice(0, Math.floor(this.frontier))
      this.publish()
    }

    // 积压快进：大脉冲后不欠债追赶
    const backlog = target.length - this.frontier
    if (backlog > revealMotion.backlogFastForwardThreshold) {
      this.frontier = Math.max(this.frontier, target.length - revealMotion.retainedBacklog)
      this.visible = target.slice(0, Math.floor(this.frontier))
      this.publish()
    }

    if (this.frontier < target.length) {
      activate(this)
    }
  }

  /**
   * 完成追尾：事实不再增长，但视觉前沿继续按当前速率追平，
   * 追平后才发布最终全文——完成事件不截断尚未展示的视觉尾巴。
   */
  settleTarget(target: string) {
    const targetChanged = target !== this.target
    this.target = target
    this.animated = true

    if (targetChanged && this.frontier > target.length) {
      this.frontier = target.length
      this.visible = target
      this.publish()
    }

    if (this.frontier < target.length) {
      activate(this)
    } else {
      this.visible = target
      this.publish()
      activeControllers.delete(this)
    }
  }

  /** 返回 false 表示已追平，从 ticker 摘除 */
  advance(elapsedMs: number, now: number) {
    if (!this.animated || this.frontier >= this.target.length) {
      return false
    }

    const measuredRate = this.arrivalRate > 0
      ? this.arrivalRate * revealMotion.arrivalRateMultiplier
      : 72
    const charactersPerSecond = clamp(
      measuredRate,
      revealMotion.minCharactersPerSecond,
      revealMotion.maxCharactersPerSecond,
    )

    this.frontier = Math.min(
      this.target.length,
      this.frontier + (charactersPerSecond * elapsedMs) / 1_000,
    )

    const nextLength = Math.floor(this.frontier)
    const completed = nextLength >= this.target.length
    if (
      nextLength !== this.visible.length
      && (completed || now - this.lastPublishedAt >= revealMotion.minimumPublishIntervalMs)
    ) {
      this.visible = this.target.slice(0, nextLength)
      this.lastPublishedAt = now
      this.publish()
    }

    return !completed
  }

  dispose() {
    activeControllers.delete(this)
    this.listeners.clear()
  }

  private observeArrival(length: number, now: number) {
    if (this.lastArrivalAt > 0 && length > this.lastArrivalLength) {
      const elapsedSeconds = Math.max((now - this.lastArrivalAt) / 1_000, 0.001)
      const instantaneousRate = (length - this.lastArrivalLength) / elapsedSeconds
      this.arrivalRate = this.arrivalRate === 0
        ? instantaneousRate
        : this.arrivalRate * 0.72 + instantaneousRate * 0.28
    }

    this.lastArrivalLength = length
    this.lastArrivalAt = now
  }

  private publish() {
    for (const listener of this.listeners) {
      listener()
    }
  }
}

// ── useReveal ───────────────────────────────────────────

function useReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return reduced
}

/**
 * @param target    权威目标文本（数据层每次 flush 更新）
 * @param streaming 是否仍在流式增长；false → 完成追尾后全量（历史水合直接全量，不重放）
 * @returns 当前应显示的前缀
 */
export function useReveal(target: string, streaming: boolean): string {
  const reducedMotion = useReducedMotion()
  const controllerRef = useRef<RevealController | null>(null)
  const wasStreamingRef = useRef(streaming)

  if (controllerRef.current === null) {
    controllerRef.current = new RevealController(target, streaming && !reducedMotion)
  }

  const controller = controllerRef.current
  const visible = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )

  useLayoutEffect(() => {
    if (streaming && !reducedMotion) {
      controller.setTarget(target, true)
    } else if (wasStreamingRef.current && !reducedMotion) {
      // 流式 → 完成的迁移：冻结 target，视觉尾巴追平后再终态
      controller.settleTarget(target)
    } else {
      controller.setTarget(target, false)
    }
    wasStreamingRef.current = streaming
  }, [controller, reducedMotion, streaming, target])

  useEffect(() => () => controller.dispose(), [controller])

  return visible
}
