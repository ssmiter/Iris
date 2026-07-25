/**
 * useTextReveal — 共享 rAF ticker 驱动的流式文字揭示引擎
 *
 * 核心设计：缓冲的是数据（scheduler 1.2s 节拍），不是视觉。
 * reveal 引擎坐在"数据到达"与"DOM 呈现"之间，把批次输入平滑成连续输出。
 *
 * 设计依据：wonwork-终态转移总体设计-v3.0.md 系统七 §7.2
 */

import { useState, useEffect, useRef, useCallback } from 'react'

// ── 全局共享 ticker ─────────────────────────────────────

/** 所有活跃 reveal 句柄 */
const activeReveals = new Set<RevealHandle>()
let tickerRunning = false
let lastTickerTime = 0

function startTicker() {
  if (tickerRunning) return
  tickerRunning = true
  lastTickerTime = performance.now()
  tick()
}

function tick() {
  if (activeReveals.size === 0) {
    tickerRunning = false
    return
  }
  const now = performance.now()
  const dt = Math.min(now - lastTickerTime, 100) // cap 100ms 防止切 tab 后大跳
  lastTickerTime = now

  for (const h of activeReveals) {
    h._advance(dt)
  }

  requestAnimationFrame(tick)
}

// ── RevealHandle ────────────────────────────────────────

interface RevealHandle {
  _advance(dt: number): void
  setTarget(text: string): void
  done: boolean
}

// ── useTextReveal ───────────────────────────────────────

export interface TextRevealResult {
  /** 当前应显示的文本 */
  revealed: string
  /** 尾部窗口 span（chars 模式；blocks 模式返回空数组） */
  tailWindow?: string[]
  /** 块级待显示数量（blocks 模式） */
  pendingBlocks?: number
}

/**
 * @param target  权威目标文本（数据层 setTarget 即更新）
 * @param opts    模式与参数
 */
export function useTextReveal(
  target: string,
  opts?: { mode?: 'chars' | 'blocks'; enabled?: boolean }
): TextRevealResult {
  const mode = opts?.mode ?? 'chars'
  const enabled = opts?.enabled ?? true

  // 速度估算 EMA（最近 5 次 setTarget）
  const arrivalsRef = useRef<Array<{ t: number; len: number }>>([])
  // frontier（已揭示字符数 / 块数）
  const frontierRef = useRef(0)
  // 当前目标长度
  const targetRef = useRef(target)
  // 累积时间（毫秒），前进量 = rate * (dt/1000)
  const accRef = useRef(0)

  const [revealed, setRevealed] = useState(enabled ? '' : target)

  // 推进速率（chars/s 或 blocks/s）
  const rateRef = useRef(mode === 'chars' ? 80 : 4)

  // 更新到达速率估计
  const updateArrivalRate = useCallback((newLen: number) => {
    const now = performance.now()
    const arrivals = arrivalsRef.current
    arrivals.push({ t: now, len: newLen })
    // 保留最近 5 次
    if (arrivals.length > 5) arrivals.shift()
    // 计算 EMA 到达速率
    if (arrivals.length >= 2) {
      const first = arrivals[0]
      const last = arrivals[arrivals.length - 1]
      const dtSec = (last.t - first.t) / 1000
      if (dtSec > 0.1) {
        const arrivalRate = (last.len - first.len) / dtSec
        // reveal 略快于到达 (×1.25)，保证落后不超过一个小窗口
        rateRef.current = Math.min(Math.max(arrivalRate * 1.25, mode === 'chars' ? 40 : 2), mode === 'chars' ? 600 : 20)
      }
    }
  }, [mode])

  const handleRef = useRef<RevealHandle>({
    _advance(dt: number) {
      if (reducedMotionRef.current) return
      const tgt = targetRef.current
      const frontier = frontierRef.current
      if (frontier >= tgt.length && mode === 'chars') return
      if (frontier >= (tgt ? 1 : 0) && mode === 'blocks') return

      // 累计时间，按速率前进
      accRef.current += dt
      const stepSize = rateRef.current * (accRef.current / 1000)
      if (stepSize < (mode === 'chars' ? 1 : 0.5)) return // 不够一单位，等下一帧

      accRef.current = 0

      if (mode === 'chars') {
        const newFrontier = Math.min(frontier + Math.floor(stepSize), tgt.length)
        frontierRef.current = newFrontier
        setRevealed(tgt.slice(0, newFrontier))
      } else {
        // blocks 模式：每次推进 1 块
        frontierRef.current = Math.min(frontier + 1, tgt ? 1 : 0)
        setRevealed(tgt) // blocks 模式显示完整文本，由组件控制哪些块可见
      }
    },

    setTarget(text: string) {
      const prevLen = targetRef.current.length
      targetRef.current = text

      // 文本变短（如重置）→ frontier 归零
      if (text.length < prevLen) {
        frontierRef.current = 0
        setRevealed('')
        return
      }

      updateArrivalRate(text.length)

      // 首次或 frontier 远落后时快进到接近尾部
      if (frontierRef.current === 0 && text.length > 0) {
        const jump = Math.max(0, text.length - 24) // 留最后 24 字给动画
        frontierRef.current = jump
        setRevealed(text.slice(0, jump))
      }
    },

    get done() {
      if (mode === 'chars') return frontierRef.current >= targetRef.current.length
      return frontierRef.current >= 1
    },
  })

  // 注册/注销 ticker
  useEffect(() => {
    if (!enabled) {
      setRevealed(target)
      return
    }
    const h = handleRef.current
    h.setTarget(target)
    activeReveals.add(h)
    startTicker()
    return () => {
      activeReveals.delete(h)
    }
  }, [enabled])

  // target 变化 → 通知 reveal
  useEffect(() => {
    if (!enabled) {
      setRevealed(target)
      return
    }
    handleRef.current.setTarget(target)
  }, [target, enabled])

  // reduced-motion → 跳过动画，直接全量显示
  const reducedMotionRef = useRef(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = () => {
      reducedMotionRef.current = mq.matches
      if (mq.matches) {
        frontierRef.current = target.length
        setRevealed(target)
      }
    }
    apply()
    const listener = () => apply()
    mq.addEventListener?.('change', listener)
    return () => mq.removeEventListener?.('change', listener)
  }, [target])

  // chars 模式：构建尾部窗口（用于 CSS 逐字淡入）
  const full = enabled ? revealed : target
  let tailWindow: string[] | undefined
  if (mode === 'chars' && full.length < target.length) {
    const remaining = target.slice(full.length)
    // 按字符切分尾部（[...] 正确处理 surrogate pairs）
    const chars = [...remaining]
    tailWindow = chars.slice(0, 200) // 最多 200 字（保证流式动画连续性）
  }

  return {
    revealed: full,
    tailWindow,
    pendingBlocks: mode === 'blocks' && full.length < target.length ? 1 : 0,
  }
}
