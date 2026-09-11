import { useEffect, useRef, useMemo, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso } from 'react-virtuoso'
import { ArrowDown, ChevronRight, Loader2 } from 'lucide-react'
import type { ChatMessage } from '@/types/chat'
import { WaterfallTurn } from './WaterfallTurn'
import { TaskLiveRun } from './TaskLiveRun'
import { useChatStore, type CompactBoundary } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'

interface MessageListProps {
  messages: ChatMessage[]
}

/** 一个对话轮次：从用户消息开始，到下一个用户消息之前的所有助手/tool 消息。
 * userMessage 缺省 = 无用户消息的"回执段"（斜杠命令回执、/compact 边界标记等，v9） */
interface Turn {
  userMessage?: ChatMessage
  messages: ChatMessage[]
}

/**
 * 将消息列表按"轮次"分组。
 * 每一轮 = 一条 user 消息 + 后续所有 assistant / tool 消息（直到下一条 user）。
 *
 * N-06: isSupplement 的 user 消息不开启新 turn，并入上一个活跃 turn。
 * v9: 开头/中间的 assistant-only 段（命令回执、压缩边界）也成 turn，不再被静默丢弃。
 */
function groupMessagesIntoTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = []
  let currentTurn: ChatMessage[] = []

  const flush = () => {
    if (currentTurn.length === 0) return
    const first = currentTurn[0]
    turns.push({
      userMessage: first.role === 'user' ? first : undefined,
      messages: [...currentTurn],
    })
    currentTurn = []
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (msg.isSupplement && (turns.length > 0 || currentTurn.length > 0)) {
        // v9.3：补充不单独上屏（chip 动画即反馈）。运行中的 turn 尚未 flush，
        // 必须并入 currentTurn，否则补充会自成 turn 被渲染成普通气泡。
        if (currentTurn.length > 0) currentTurn.push(msg)
        else turns[turns.length - 1].messages.push(msg)
        continue
      }
      flush()
      currentTurn = [msg]
    } else {
      currentTurn.push(msg)
    }
  }
  flush()
  return turns
}

/** 底部判定容差（px）：流式增长/轻微回退不脱随；小于该值仍视为"在底部" */
const AT_BOTTOM_THRESHOLD = 80

/**
 * 轻量轮折叠行（2026-09-02 §16.6 分层加载）：老轮以截断预览载入（重字段未拉取），
 * 整轮渲染为一行占位——"这里有内容、是什么、点开看"。点击按轮补拉全量并原地替换。
 */
function LightTurnRow({ turn }: { turn: Turn }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const loadTurn = useChatStore((s) => s.loadTurn)
  const first = turn.messages[0]
  const turnIndex = first?.turnIndex ?? 0
  const previewSource = turn.userMessage ?? first
  const preview = (previewSource?.content ?? '').replace(/\s+/g, ' ').trim()
  return (
    <button
      type="button"
      className="wf-light-turn"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await loadTurn(turnIndex)
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy ? <Loader2 size={13} className="wf-light-turn-spin" /> : <ChevronRight size={13} />}
      <span className="wf-light-turn-label">
        {t('chat.messageList.lightTurnLabel', { index: turnIndex + 1, count: turn.messages.length })}
      </span>
      <span className="wf-light-turn-preview">{preview}</span>
    </button>
  )
}

export function MessageList({ messages }: MessageListProps) {
  const { t } = useTranslation()

  // 分组
  const turns = useMemo(() => groupMessagesIntoTurns(messages), [messages])

  // 轮迹轨锚点（2026-08-12）：turn 下标 → 该轮用户消息在 messages 数组中的下标。
  // 供 TurnRail minimap 按 messages 下标定位刻度（data-turn-idx）；无用户消息的
  // 回执段不设锚点。只加数据属性，不动结构/样式/渲染逻辑。
  const msgIdxById = useMemo(() => new Map(messages.map((m, i) => [m.id, i])), [messages])
  const turnUserMsgIdx = useMemo(() => {
    const map = new Map<number, number>()
    turns.forEach((turn, ti) => {
      if (turn.userMessage) {
        const mi = msgIdxById.get(turn.userMessage.id)
        if (mi != null) map.set(ti, mi)
      }
    })
    return map
  }, [turns, msgIdxById])

  // 压缩边界分隔标记（v9.4 位置语义）：历史不动，在切点位置画正文风格的分隔线。
  // 适用 = 切点早于活路径最早分叉点的所有线（分叉在切点后 → 该线对此分支有效；
  // 分叉在切点前 → 此分支在该线之前，落回更原始的线，线本身仍作为历史标记显示，
  // 但 context 装配不会用它——见 chatStore.selectActiveBoundary）。
  const compactBoundaries = useChatStore((s) => s.compactBoundaries)
  const branches = useChatStore((s) => s.branches)
  const dividersByTurn = useMemo(() => {
    // 活路径最早分叉点：只看锚点消息仍在当前消息链上的锚点
    let divTs = Infinity
    for (const a of Object.values(branches)) {
      const anchorMsgId = a.variants[a.active]?.anchorMsgId ?? a.anchorId
      const msg = messages.find((m) => m.id === anchorMsgId)
      if (msg) divTs = Math.min(divTs, msg.timestamp || 0)
    }
    // 分叉在某线之前 → 该线之后的记录不属于此分支视角，线不显示
    const applicable = compactBoundaries.filter((b) => b.cutoffTs < divTs)
    if (applicable.length === 0) return new Map<number, CompactBoundary[]>()
    const map = new Map<number, CompactBoundary[]>()
    for (const b of applicable) {
      // 切点落在哪个 turn 之前：第一个首条消息时间戳 > cutoffTs 的 turn
      const idx = turns.findIndex((t2) => (t2.messages[0]?.timestamp ?? 0) > b.cutoffTs)
      const at = idx === -1 ? turns.length : idx
      const list = map.get(at) ?? []
      list.push(b)
      map.set(at, list)
    }
    return map
  }, [compactBoundaries, branches, turns, messages])

  // ── 钉底引擎（2026-09-02 重写，废弃 followOutput + 裸方向判定）──
  // pinnedRef = 唯一真相：用户意愿锚在最新。
  //   pin   → 滚动回到底部（scroll 事件距离判定 + atBottomStateChange 跳变）/ 点「回到最新」/ 初始
  //   unpin → 用户上翻：scrollTop 真实下降 ∧ 上行输入意图同时在场。
  //           scrollTop 有三个写者——用户、本引擎、virtuoso/浏览器的滚动锚定补偿
  //           （视口上方内容收缩，如工具调用/思考块完成折叠时，补偿会下调 scrollTop
  //           保持视觉稳定）。只认「下降即上翻」会把补偿误判成用户意图——流式中途
  //           偶发脱锚的根因。无意图的下降 = 补偿，pinned 语义下当场顶回底部。
  //   意图  → 滚轮/键盘/触摸上行事件武装 150ms 窗口；指针按住期间全程算用户操作
  //           （原生滚动条不派发 DOM 事件，按住判定是识别拖滚动条的唯一可靠途径）。
  //   执行  → pinned 期间每次内容变化（含逐 chunk）+ ResizeObserver（图片/图表晚加载
  //           撑高、视口尺寸变化）都直接钉到真底部，漂移不超过一帧。
  // 手动模式（设置 scrollFollow=manual）：引擎整体停用，「回到最新」胶囊是唯一跳转入口。
  const manualFollow = useSettingsStore((s) => s.scrollFollow === 'manual')
  const [pinned, setPinned] = useState(true)
  const pinnedRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const manualRef = useRef(manualFollow)
  manualRef.current = manualFollow
  const [newTurnsWhileAway, setNewTurnsWhileAway] = useState(0)
  const scrollerRef = useRef<HTMLElement | null>(null)

  const setPinnedBoth = useCallback((v: boolean) => {
    pinnedRef.current = v
    setPinned(v)
  }, [])

  const scrollToLatest = useCallback((behavior: 'auto' | 'smooth') => {
    const el = scrollerRef.current
    if (!el) return
    // 直写 DOM，不走 virtuoso scrollToIndex：后者对测高不全的列表走「估算跳转→测量校正」
    // 两步，校正的反向回落会被上翻侦测误判为脱锚（发送新轮后跟随静默死掉的根因），
    // 且逐 chunk 重复估算-校正即肉眼可见的抖动。scrollTop 写 scrollHeight 自动钳制到
    // 最大值，瞬时精确落在真底部（含 Footer 尾部净空），且只增不减、永不误触 unpin。
    if (behavior === 'auto') el.scrollTop = el.scrollHeight
    else el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  // 空态不挂 Virtuoso（下方 early return），scroller 在首条消息出现时才有 DOM，需按此重绑
  const hasMessages = messages.length > 0

  // 上翻脱锚 / 回底重锚。回底用距离判定而非只看 atBottomStateChange：后者只在布尔跳变时
  // 触发，阈值内小幅上翻再下来全程无跳变，纯靠它会出现「人在底部、跟随已死」的静默卡死。
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    let lastTop = el.scrollTop
    let upIntentUntil = 0
    let pointerHeld = false
    const armUpIntent = () => { upIntentUntil = performance.now() + 150 }
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) armUpIntent() }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'Home') armUpIntent()
    }
    let touchY: number | null = null
    const onTouchStart = (e: TouchEvent) => { touchY = e.touches[0]?.clientY ?? null }
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY
      if (touchY != null && y != null && y > touchY + 4) armUpIntent()
      if (y != null) touchY = y
    }
    const hold = () => { pointerHeld = true }
    const release = () => { pointerHeld = false }
    const onScroll = () => {
      const top = el.scrollTop
      if (!manualRef.current) {
        if (pinnedRef.current && top < lastTop - 1) {
          if (performance.now() < upIntentUntil || pointerHeld) {
            setPinnedBoth(false)
          } else {
            // 无输入意图的下降 = 滚动补偿/锚定调整：pinned 语义=钉住真底，当场顶回
            scrollToLatest('auto')
          }
        } else if (!pinnedRef.current && el.scrollHeight - top - el.clientHeight <= AT_BOTTOM_THRESHOLD) {
          setPinnedBoth(true)
        }
      }
      lastTop = top
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('keydown', onKeyDown)
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    window.addEventListener('pointerdown', hold, true)
    window.addEventListener('pointerup', release, true)
    window.addEventListener('pointercancel', release, true)
    window.addEventListener('blur', release)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('keydown', onKeyDown)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('pointerdown', hold, true)
      window.removeEventListener('pointerup', release, true)
      window.removeEventListener('pointercancel', release, true)
      window.removeEventListener('blur', release)
    }
  }, [hasMessages, setPinnedBoth, scrollToLatest])

  // 逐 chunk 钉底（rAF 合并进绘制帧）。刻意只随 messages 触发、不随 pinned 翻转立即拽动：
  // 回底重锚后等下一次内容增长自然钉回，避免在阈值边界缓慢滚动时的吸附抖动
  useEffect(() => {
    if (manualFollow || !pinnedRef.current) return
    const raf = requestAnimationFrame(() => scrollToLatest('auto'))
    return () => cancelAnimationFrame(raf)
  }, [messages, manualFollow, scrollToLatest])

  // 无 messages 变化的高度增长（图片/图表/晚加载撑开已渲染项）与视口尺寸变化：保持钉底
  useEffect(() => {
    const scroller = scrollerRef.current
    const list = scroller?.firstElementChild
    if (!scroller || !list) return
    let raf = 0
    const ro = new ResizeObserver(() => {
      if (manualRef.current || !pinnedRef.current) return
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        scrollToLatest('auto')
      })
    })
    ro.observe(list)
    ro.observe(scroller)
    return () => {
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [hasMessages, scrollToLatest])

  // atBottom 状态驱动胶囊显隐；回底跳变同时恢复跟随（距离判定之外的兜底路径）
  const handleAtBottomStateChange = useCallback((bottom: boolean) => {
    setAtBottom(bottom)
    if (bottom) {
      if (!manualRef.current) setPinnedBoth(true)
      setNewTurnsWhileAway(0)
    }
  }, [setPinnedBoth])

  // 切到手动模式 → 立即脱锚（切回自动不主动拽滚动条：回底或点胶囊时自然恢复）
  useEffect(() => {
    if (manualFollow) setPinnedBoth(false)
  }, [manualFollow, setPinnedBoth])

  // 翻阅期间统计"新增轮次"（按 turn 计数，不随字符流跳动；手动模式恒在翻阅态）
  const prevTurnsLenRef = useRef(turns.length)
  useEffect(() => {
    const prev = prevTurnsLenRef.current
    prevTurnsLenRef.current = turns.length
    if ((!pinned || manualFollow) && turns.length > prev) {
      setNewTurnsWhileAway((c) => c + (turns.length - prev))
    }
  }, [turns.length, pinned, manualFollow])

  // "回到最新"胶囊点击 → 平滑回到底部；自动模式恢复跟随，手动模式只跳不跟随
  const handleJumpToLatest = useCallback(() => {
    if (!manualRef.current) setPinnedBoth(true)
    setNewTurnsWhileAway(0)
    const behavior: 'auto' | 'smooth' = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth'
    scrollToLatest(behavior)
  }, [scrollToLatest, setPinnedBoth])

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          {/* 裸标居中（旧 primary-100 圆角砖在暗色下是一块白边，2026-08-13 用户反馈拆除） */}
          <img src="/iris-logo.png" alt="Iris" className="w-16 h-16 mx-auto object-contain" />
          <h3 className="text-lg font-semibold text-[var(--wf-sub)]">{t('chat.messageList.startChat')}</h3>
          <p className="text-sm text-[var(--wf-faint)] max-w-xs mx-auto">
            {t('chat.messageList.startChatDescription')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <>
      <Virtuoso
        scrollerRef={(el) => { scrollerRef.current = el as HTMLElement | null }}
        className="flex-1 wf-chat-scroll"
        data={turns}
        computeItemKey={(index, turn) => turn.userMessage?.id ?? turn.messages[0]?.id ?? index}
        initialTopMostItemIndex={turns.length - 1}
        atBottomThreshold={AT_BOTTOM_THRESHOLD}
        atBottomStateChange={handleAtBottomStateChange}
        increaseViewportBy={{ top: 0, bottom: 160 }}
        itemContent={(index, turn) => {
          // §16.6：轻量轮（整轮轻行）渲染为折叠占位行，点开按轮补拉
          const isLightTurn = turn.messages.every((m) => m.light)
          const isStreaming = turn.messages.some((m) => m.isStreaming)
          const assistantMsgs = turn.messages.filter(
            (m) => m.role === 'assistant'
          )
          const dividers = dividersByTurn.get(index)

          return (
            <div className="wf-turn-wrapper" data-turn-idx={turnUserMsgIdx.get(index)}>
              {dividers?.map((b) => (
                <div key={b.id} className="wf-compact-divider">
                  <span className="cd-line" />
                  <span className="cd-text">
                    {b.trigger === 'auto' ? t('chat.messageList.autoCompacted') : t('chat.messageList.compacted')}
                    {b.coveredCount > 0 ? ` · ${t('chat.messageList.summarizedWithCount', { count: b.coveredCount })}` : ` · ${t('chat.messageList.summarized')}`}
                  </span>
                  <span className="cd-line" />
                </div>
              ))}
              {isLightTurn ? (
                <LightTurnRow turn={turn} />
              ) : (
                <WaterfallTurn
                  userMessage={turn.userMessage}
                  assistantMessages={assistantMsgs}
                  allMessages={turn.messages}
                  isStreaming={isStreaming}
                />
              )}
            </div>
          )
        }}
        components={{
          Footer: () => {
            const trailing = dividersByTurn.get(turns.length)
            return (
              <>
                {trailing && (
                  <div className="wf-turn-wrapper">
                    {trailing.map((b) => (
                      <div key={b.id} className="wf-compact-divider">
                        <span className="cd-line" />
                        <span className="cd-text">
                          {b.trigger === 'auto' ? '上下文已自动压缩' : '上下文已压缩'}
                          {b.coveredCount > 0 ? ` · 此前 ${b.coveredCount} 条已摘要为背景` : ' · 此前内容已摘要为背景'}
                        </span>
                        <span className="cd-line" />
                      </div>
                    ))}
                  </div>
                )}
                {/* 任务会话进行中实况（as_task 运行内联渲染，非任务会话恒 null） */}
                <TaskLiveRun />
                {/* 末轮底部净空（防浮动输入框遮挡）：替代被 Virtuoso 恒真命中的
                    .wf-turn-wrapper:last-child 200px——那个写法把 200px 加给了每一轮 */}
                <div className="wf-chat-tail-space" />
              </>
            )
          },
        }}
      />

      {/* "回到最新"圆钮——离开底部后出现（手动模式=唯一跳转入口，不在底部即常驻）；
          absolute 挂 ChatView 相对容器，右侧与输入坞同水平带，不遮正文 */}
      {(!pinned || manualFollow) && !atBottom && (
        <button
          className="wf-jump-pill"
          onClick={handleJumpToLatest}
          aria-label={t('chat.messageList.backToLatestAria')}
          title={t('chat.messageList.backToLatest')}
        >
          <ArrowDown size={17} />
          {newTurnsWhileAway > 0 && (
            <span className="wf-jump-n">{newTurnsWhileAway}</span>
          )}
        </button>
      )}
    </>
  )
}
