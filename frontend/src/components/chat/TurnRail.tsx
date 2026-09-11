import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/utils'
import { useChatStore } from '@/stores/chatStore'
import type { ChatMessage } from '@/types/chat'

/**
 * 轮迹目录（2026-08-12 v3：零常驻元素，顶栏图标唤出矩形目录）
 *
 * 前两版失败教训（用户反馈）：
 * - v1 右缘悬停胶囊：右缘已叠滚动条/跳最新/右缘热区/进展芽四层，同时展开
 *   很乱；悬停才现身经常点不到；圆点+胶囊+散点标签不整齐。
 * - v2 左缘常驻刻度槽：类名 .wf-rail 撞了瀑布流节点脊柱（FlowNode 每个节点
 *   自带 wf-rail），把全站节点吸到左缘；且常驻刻度本身让页面"变脏"不够整洁。
 *
 * v3 拍板：页面上零新增常驻元素——入口是顶栏 wf-sicon 图标（ChatView 按
 * ≥8 轮门槛渲染，与本组件 MIN_TURNS 保持一致），点开 wf-panel 风矩形目录卡
 * （行列式列表可滚动、无轮数上限，散点标签与碰撞算法不复活）；点行跳转后
 * 目录保持开（2026-08-13 用户反馈：只点一次就要重开，浏览找不到目标），
 * 当前行高亮随滚动跟随；Esc/点外/再点图标可关。「回到最新」胶囊保留
 * （与 .wf-jump-pill 互斥）。
 *
 * 只读不改：不碰 chatStore / 消息流 / MessageList 渲染逻辑；MessageList 只负责
 * 在每轮容器上打 data-turn-idx（=该轮用户消息在 messages 数组中的下标）。
 * 位置缓存纪律：只在 messages.length 变化 / resize / 滚动停止 debounce 三处
 * 重算，流式 chunk 级不动（见 refresh 唯一入口）。
 */
interface TurnItem {
  /** 该用户消息在 messages 数组中的下标（= data-turn-idx 锚点值） */
  idx: number
  /** 首句（去 markdown 记号，CJK 安全截断） */
  text: string
}

interface TurnRailProps {
  /** 目录卡开合（顶栏按钮控制；ChatView 已按 ≥8 轮门槛决定按钮可见性） */
  open: boolean
  onClose: () => void
}

/** 门槛：轮次数 < 8 且滚动高度 ≤ 3 屏时整体不渲染（安静：短对话零噪音） */
const MIN_TURNS = 8
/** 滚动停止后重算位置缓存（ms） */
const STOP_DEBOUNCE = 400
/** 目录行文本最长可见字符数（CJK 安全，Array.from） */
const LABEL_CHARS = 20

function firstLine(raw: string): string {
  const line = (raw || '').split('\n')[0].trim()
  const cleaned = line
    .replace(/^#{1,6}\s+/, '') // heading
    .replace(/^>\s?/, '') // blockquote
    .replace(/^[-*+]\s+/, '') // unordered list
    .replace(/^\d+[.)]\s+/, '') // ordered list
    .replace(/`/g, '') // inline code
    .replace(/[*_~]/g, '') // emphasis
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // link → text
    .trim()
  const chars = Array.from(cleaned)
  const cut = chars.slice(0, LABEL_CHARS)
  return chars.length > LABEL_CHARS ? cut.join('') + '…' : cut.join('')
}

function buildTurnList(messages: ChatMessage[]): TurnItem[] {
  const out: TurnItem[] = []
  messages.forEach((m, i) => {
    // 补充（isSupplement）不单独上屏、不自成一轮，无独立锚点 → 不占行；
    // 系统事件（isSystemEvent）是轮次边界，保留。回执段（assistant 开头）不在此列。
    if (m.role === 'user' && !m.isSupplement) {
      out.push({ idx: i, text: firstLine(m.content || '') })
    }
  })
  return out
}

/**
 * 位置解析：已测轮次用真实比例，未测轮次在相邻已测锚点间按序号插值。
 * 背景：MessageList 用 react-virtuoso 虚拟化，只有视口内轮次有 DOM——
 * 严格按需现算只能拿到已渲染轮次；插值让远跳永远可发起（估算位落地后
 * 两拍精校），且随滚动/停止重算逐步收敛到实测值。
 */
function resolveRatios(turnList: TurnItem[], measured: Map<number, number>): number[] {
  const count = turnList.length
  const out: number[] = new Array(count)
  const knownK: number[] = []
  for (let k = 0; k < count; k++) {
    if (measured.get(turnList[k].idx) != null) knownK.push(k)
  }
  if (knownK.length === 0) {
    for (let k = 0; k < count; k++) out[k] = count === 1 ? 0.5 : (k + 0.5) / count
    return out
  }
  for (let k = 0; k < count; k++) {
    const r = measured.get(turnList[k].idx)
    if (r != null) {
      out[k] = r
      continue
    }
    let lo = -1
    let hi = -1
    for (const kk of knownK) {
      if (kk < k) lo = kk
      else break
    }
    for (let j = knownK.length - 1; j >= 0; j--) {
      if (knownK[j] > k) {
        hi = knownK[j]
        break
      }
    }
    if (lo === -1) {
      // 首个已测锚点之上：从顶部 0 向该锚点线性
      out[k] = measured.get(turnList[hi].idx)! * ((k + 1) / (hi + 1))
    } else if (hi === -1) {
      // 最后一个已测锚点之下：从该锚点向底部 1 线性
      const rLo = measured.get(turnList[lo].idx)!
      out[k] = rLo + (1 - rLo) * ((k - lo) / (count - lo))
    } else {
      const rLo = measured.get(turnList[lo].idx)!
      const rHi = measured.get(turnList[hi].idx)!
      out[k] = rLo + (rHi - rLo) * ((k - lo) / (hi - lo))
    }
  }
  return out
}

export function TurnRail({ open, onClose }: TurnRailProps) {
  const { t } = useTranslation()
  const messages = useChatStore((s) => s.messages)
  const scrollerRef = useRef<HTMLElement | null>(null)
  const positionsRef = useRef<Map<number, number>>(new Map())
  const convKeyRef = useRef<string>('')
  /** 远跳校正定时器组（目标轮次未渲染时跳的是插值估算位，落到附近渲染后再精校） */
  const correctTimersRef = useRef<number[]>([])
  const activeRowRef = useRef<HTMLButtonElement | null>(null)

  const [metrics, setMetrics] = useState<{ scrollH: number; clientH: number } | null>(null)
  const [active, setActive] = useState(-1)
  const [showLatest, setShowLatest] = useState(false)

  const turnList = useMemo(() => buildTurnList(messages), [messages])
  const turnCount = turnList.length
  const convKey = messages[0]?.id ?? ''

  const getScroller = useCallback((): HTMLElement | null => {
    if (scrollerRef.current && document.body.contains(scrollerRef.current)) return scrollerRef.current
    const el = document.querySelector<HTMLElement>('.wf-chat-scroll')
    scrollerRef.current = el
    return el
  }, [])

  const computePositions = useCallback(() => {
    const scroller = getScroller()
    if (!scroller || !scroller.scrollHeight) return
    const total = scroller.scrollHeight
    const scTop = scroller.getBoundingClientRect().top
    const map = new Map(positionsRef.current)
    scroller.querySelectorAll<HTMLElement>('[data-turn-idx]').forEach((node) => {
      const i = Number(node.getAttribute('data-turn-idx'))
      if (!Number.isInteger(i)) return
      map.set(i, (node.getBoundingClientRect().top - scTop + scroller.scrollTop) / total)
    })
    positionsRef.current = map
  }, [getScroller])

  const updateActive = useCallback(() => {
    const scroller = getScroller()
    if (!scroller) return
    // 当前轮 = 视口顶 25% 线内最后一个轮（虚拟化下视口内轮次必有 DOM）
    const line = scroller.clientHeight * 0.25
    const scTop = scroller.getBoundingClientRect().top
    let act = -1
    let best = -Infinity
    scroller.querySelectorAll<HTMLElement>('[data-turn-idx]').forEach((node) => {
      const p = node.getBoundingClientRect().top - scTop
      if (p <= line && p >= best) {
        best = p
        act = Number(node.getAttribute('data-turn-idx'))
      }
    })
    setActive(act)
  }, [getScroller])

  const computeLatest = useCallback((scroller: HTMLElement) => {
    const away = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    // 防重叠：MessageList 内置的 .wf-jump-pill（滚离底部即现）在场时不重复出胶囊。
    const legacyPill = document.querySelector('.wf-jump-pill') != null
    setShowLatest(away > 2 * scroller.clientHeight && !legacyPill)
  }, [])

  /**
   * 指标/位置缓存唯一重算入口。
   * 触发时机刻意只留三个：messages.length 变化 / window resize / 滚动停止 debounce。
   * 流式期间（chunk 只改内容不改 length）不实时算——远跳仍按缓存比例走。
   */
  const refresh = useCallback(() => {
    const scroller = getScroller()
    if (!scroller) return
    setMetrics({ scrollH: scroller.scrollHeight, clientH: scroller.clientHeight })
    computeLatest(scroller)
    computePositions()
    updateActive()
  }, [getScroller, computeLatest, computePositions, updateActive])

  // 消息结构变化：跨会话/重载清空位置缓存后重算一次
  useEffect(() => {
    const scroller = getScroller()
    if (!scroller) {
      setMetrics(null)
      return
    }
    if (convKeyRef.current !== convKey) {
      convKeyRef.current = convKey
      positionsRef.current = new Map()
    }
    refresh()
  }, [messages.length, convKey, refresh, getScroller])

  // 滚动：active 跟随 + 回到最新阈值 + 停止后重算（rAF 节流）
  useEffect(() => {
    const scroller = getScroller()
    if (!scroller) return
    let raf = 0
    let stopTimer = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        updateActive()
        computeLatest(scroller)
        window.clearTimeout(stopTimer)
        stopTimer = window.setTimeout(() => refresh(), STOP_DEBOUNCE)
      })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      window.clearTimeout(stopTimer)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [messages.length, updateActive, computeLatest, refresh, getScroller])

  // 窗口 resize：rAF 节流重算
  useEffect(() => {
    let raf = 0
    const onResize = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        refresh()
      })
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [refresh])

  // 卸载清理远跳校正定时器（scroll/resize 监听各 effect 自带清理）
  useEffect(
    () => () => {
      correctTimersRef.current.forEach((t) => window.clearTimeout(t))
    },
    []
  )

  // Esc 收目录
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // 点外收目录（顶栏入口按钮 .wf-turnnav-btn 除外——它自己的 onClick 负责切换）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null
      if (el && el.closest('.wf-turncat, .wf-turnnav-btn')) return
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, onClose])

  // 目录打开时把当前轮滚到可视区中央（瞬移，不动画）
  useEffect(() => {
    if (!open) return
    refresh() // 打开那一帧重算位置缓存，目录行点击跳到最新实测
    activeRowRef.current?.scrollIntoView({ block: 'center', behavior: 'auto' })
    // 仅开合时刻触发；refresh 引用变化（流式中每帧新闭包）不应反复滚
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const reducedMotion = useCallback(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    []
  )

  const jumpToTurn = useCallback(
    (i: number) => {
      const scroller = getScroller()
      if (!scroller) return
      const el = scroller.querySelector<HTMLElement>(`[data-turn-idx="${i}"]`)
      const scTop = scroller.getBoundingClientRect().top
      // 未渲染轮次：优先实测缓存比例，没有再走插值估算（近轮已渲染时不需要比例）
      let ratio: number | undefined
      if (!el) {
        const measured = positionsRef.current
        ratio = measured.get(i)
        if (ratio == null) {
          const k = turnList.findIndex((tm) => tm.idx === i)
          if (k >= 0) ratio = resolveRatios(turnList, measured)[k]
        }
      }
      const target = el
        ? el.getBoundingClientRect().top - scTop + scroller.scrollTop - 16
        : (ratio ?? 0) * scroller.scrollHeight - 16
      scroller.scrollTo({ top: Math.max(0, target), behavior: reducedMotion() ? 'auto' : 'smooth' })
      // 远跳精校：目标轮次未渲染（虚拟化）时上面跳的是插值估算位，可能差出一屏；
      // 滚动落地+virtuoso 补渲后（350ms/900ms 两拍）若该轮已有 DOM 且偏差 >40px，
      // 瞬移吸附到轮顶。近跳（已有 DOM）无需校正。
      if (!el) {
        const attempt = () => {
          const s = getScroller()
          if (!s) return
          const el2 = s.querySelector<HTMLElement>(`[data-turn-idx="${i}"]`)
          if (!el2) return
          const top = el2.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - 16
          if (Math.abs(s.scrollTop - top) > 40) s.scrollTo({ top: Math.max(0, top), behavior: 'auto' })
        }
        correctTimersRef.current.push(window.setTimeout(attempt, 350), window.setTimeout(attempt, 900))
      }
    },
    [getScroller, reducedMotion, turnList]
  )

  const jumpToLatest = useCallback(() => {
    const scroller = getScroller()
    if (!scroller) return
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' })
  }, [getScroller, reducedMotion])

  // ── 门槛（安静）：短对话零渲染（含「回到最新」胶囊） ──
  const hide = turnCount < MIN_TURNS && (!metrics || metrics.scrollH <= 3 * metrics.clientH)

  if (hide) return null

  return (
    <>
      {open && (
        <div className="wf-turncat" role="navigation" aria-label={t('chat.turnRail.railLabel')}>
          <div className="wf-turncat-t">{t('chat.turnRail.railLabel')}</div>
          <div className="wf-turncat-list scrollbar-thin">
            {turnList.map((tm, k) => (
              <button
                key={tm.idx}
                ref={tm.idx === active ? activeRowRef : undefined}
                type="button"
                className={cn('wf-turncat-row', tm.idx === active && 'active')}
                onClick={() => jumpToTurn(tm.idx)}
                title={tm.text}
              >
                <span className="wf-turncat-n">{k + 1}</span>
                <span className="wf-turncat-tx">{tm.text || '…'}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {showLatest && (
        <button
          type="button"
          className="wf-latest-pill wf-press"
          onClick={jumpToLatest}
          aria-label={t('chat.turnRail.backToLatest')}
        >
          <span className="wf-latest-pill-ic" aria-hidden="true">
            ↓
          </span>
          {t('chat.turnRail.backToLatest')}
        </button>
      )}
    </>
  )
}
