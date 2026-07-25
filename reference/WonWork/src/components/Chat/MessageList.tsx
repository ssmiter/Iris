import { useEffect, useRef, useMemo, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { Check, X } from 'lucide-react'
import type { ChatMessage } from '@/types/chat'
import { MessageBubble } from './MessageBubble'
import { WaterfallTurn } from './WaterfallTurn'
import { Portal } from '@/components/common/Portal'
import { useChatStore, type CompactBoundary } from '@/stores/chatStore'

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

/**
 * 判断一个 turn 是否应该使用瀑布流渲染。
 * 条件：任意 assistant 消息包含 renderNodes。
 */
function turnHasRenderNodes(turn: Turn): boolean {
  return turn.messages.some(
    (m) => m.role === 'assistant' && m.renderNodes && m.renderNodes.length > 0
  )
}

/** 底部判定容差（px）：流式增长/轻微回退不脱随；小于该值仍视为"在底部" */
const AT_BOTTOM_THRESHOLD = 80

export function MessageList({ messages }: MessageListProps) {
  const { t } = useTranslation()
  const virtuosoRef = useRef<VirtuosoHandle>(null)

  // 浮动审批栏（v9.5）：store 里的 pending 列表 + 本地"已决定 ghost"层。
  // 决定（批准/拒绝）立即生效，但该条不瞬消——原地淡化 500ms 后才收拢高度，
  // 其余条目在此时平滑补位；淡化期间布局完全不动，视线不用追任何元素。
  const pendingApprovals = useChatStore((s) => s.pendingApprovals)
  const approveToolCall = useChatStore((s) => s.approveToolCall)
  const rejectToolCall = useChatStore((s) => s.rejectToolCall)
  const activeApprovals = pendingApprovals.filter((a) => a.status === 'pending')
  const [approvalBusy, setApprovalBusy] = useState<Set<string>>(new Set())
  interface ApprovalGhost {
    approval: (typeof activeApprovals)[number]
    decision: 'approved' | 'rejected'
    collapsing: boolean
  }
  const [approvalGhosts, setApprovalGhosts] = useState<Map<string, ApprovalGhost>>(new Map())

  const decideApproval = useCallback(
    (approval: (typeof activeApprovals)[number], decision: 'approved' | 'rejected') => {
      const id = approval.toolCallId
      if (approvalBusy.has(id)) return
      setApprovalBusy((prev) => new Set(prev).add(id))
      setApprovalGhosts((prev) => {
        const next = new Map(prev)
        next.set(id, { approval, decision, collapsing: false })
        return next
      })
      if (decision === 'approved') approveToolCall(id)
      else rejectToolCall(id)
      // 淡化结束后再收拢（两阶段，避免"先动后消失"的视觉追逐）
      setTimeout(() => {
        setApprovalGhosts((prev) => {
          const g = prev.get(id)
          if (!g) return prev
          const next = new Map(prev)
          next.set(id, { ...g, collapsing: true })
          return next
        })
      }, 500)
      setTimeout(() => {
        setApprovalGhosts((prev) => {
          if (!prev.has(id)) return prev
          const next = new Map(prev)
          next.delete(id)
          return next
        })
        setApprovalBusy((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }, 850)
    },
    [approvalBusy, approveToolCall, rejectToolCall]
  )

  const handleApprove = useCallback(
    (toolCallId: string) => {
      const a = activeApprovals.find((x) => x.toolCallId === toolCallId)
      if (a) decideApproval(a, 'approved')
    },
    [activeApprovals, decideApproval]
  )

  // v9.1：审批挂起期间 Tab = 快速批准第一项（模态语义，claude-code 式快捷键）。
  // window capture 阶段拦截，避免与输入框/斜杠菜单的 Tab 语义冲突。
  useEffect(() => {
    if (activeApprovals.length === 0) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.shiftKey || e.isComposing) return
      const first = activeApprovals[0]
      if (!first) return
      e.preventDefault()
      e.stopPropagation()
      handleApprove(first.toolCallId)
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [activeApprovals, handleApprove])

  // 显示顺序稳定：live + ghost 按首次出现位置排列，新审批追加在底部（最靠近对话框）。
  // ghost 保持原槽位，淡化→收拢全过程其余条目不被推挤。
  const approvalOrderRef = useRef<string[]>([])
  const liveIds = activeApprovals.map((a) => a.toolCallId)
  const displayOrder = useMemo(() => {
    const ghostIds = new Set(approvalGhosts.keys())
    const alive = new Set([...liveIds, ...ghostIds])
    const kept = approvalOrderRef.current.filter((id) => alive.has(id))
    const appended = [...liveIds, ...ghostIds].filter((id) => !kept.includes(id))
    const order = [...kept, ...appended]
    approvalOrderRef.current = order
    return order
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIds.join(','), approvalGhosts])

  // 分组
  const turns = useMemo(() => groupMessagesIntoTurns(messages), [messages])

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

  // ── 滚动跟随状态机（经典 chat scroll-follow）──
  // shouldFollow=true  → 跟随模式：新内容把历史向上推，最新始终可见
  // shouldFollow=false → 翻阅模式：用户上翻读历史，流式输出不打扰
  // 恢复路径：用户滚回底部（atBottomStateChange）或点击"回到最新"
  const [shouldFollow, setShouldFollow] = useState(true)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  const [newTurnsWhileAway, setNewTurnsWhileAway] = useState(0)
  const scrollerRef = useRef<HTMLElement | null>(null)
  const touchStartYRef = useRef<number | null>(null)

  // 用户主动离开 → 暂停跟随；用户回到底部 → 恢复跟随
  const handleAtBottomStateChange = useCallback((bottom: boolean) => {
    atBottomRef.current = bottom
    setAtBottom(bottom)
    if (bottom) {
      setShouldFollow(true)
      setNewTurnsWhileAway(0)
    }
  }, [])

  // 原生输入事件识别"用户上翻"意图（程序化滚动不触发这些事件）
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        setShouldFollow(false)
      } else if (e.deltaY > 0 && atBottomRef.current) {
        // 阈值内轻微上翻后向下滚回——恢复跟随
        setShouldFollow(true)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'Home') {
        setShouldFollow(false)
      }
    }
    const onTouchStart = (e: TouchEvent) => {
      touchStartYRef.current = e.touches[0]?.clientY ?? null
    }
    const onTouchMove = (e: TouchEvent) => {
      const startY = touchStartYRef.current
      if (startY == null) return
      const y = e.touches[0]?.clientY
      if (y != null && y - startY > 8) setShouldFollow(false) // 下拉=看向历史
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('keydown', onKeyDown)
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('keydown', onKeyDown)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
    }
  }, [messages.length === 0])

  // 翻阅期间统计"新增轮次"（按 turn 计数，不随字符流跳动）
  const prevTurnsLenRef = useRef(turns.length)
  useEffect(() => {
    const prev = prevTurnsLenRef.current
    prevTurnsLenRef.current = turns.length
    if (!shouldFollow && turns.length > prev) {
      setNewTurnsWhileAway((c) => c + (turns.length - prev))
    }
  }, [turns.length, shouldFollow])

  // "回到最新"胶囊点击 → 平滑回到底部，恢复跟随
  const handleJumpToLatest = useCallback(() => {
    setShouldFollow(true)
    setNewTurnsWhileAway(0)
    virtuosoRef.current?.scrollToIndex({
      index: turns.length - 1,
      behavior: 'smooth',
      align: 'end',
    })
  }, [turns.length])

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-16 h-16 mx-auto rounded-2xl bg-primary-100 flex items-center justify-center overflow-hidden">
            <img src="./iris-logo.svg" alt="Iris" className="w-12 h-12 object-contain" />
          </div>
          <h3 className="text-lg font-semibold text-surface-700">{t('chat.messageList.startChat')}</h3>
          <p className="text-sm text-surface-400 max-w-xs mx-auto">
            {t('chat.messageList.startChatDescription')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <>
      <Virtuoso
        ref={virtuosoRef}
        scrollerRef={(el) => { scrollerRef.current = el as HTMLElement | null }}
        className="flex-1 wf-chat-scroll"
        data={turns}
        computeItemKey={(index, turn) => turn.userMessage?.id ?? turn.messages[0]?.id ?? index}
        initialTopMostItemIndex={turns.length - 1}
        atBottomThreshold={AT_BOTTOM_THRESHOLD}
        atBottomStateChange={handleAtBottomStateChange}
        followOutput={(isAtBottom) => (shouldFollow && isAtBottom ? 'auto' : false)}
        increaseViewportBy={{ top: 0, bottom: 160 }}
        itemContent={(index, turn) => {
          const isStreaming = turn.messages.some((m) => m.isStreaming)
          const assistantMsgs = turn.messages.filter(
            (m) => m.role === 'assistant'
          )
          const dividers = dividersByTurn.get(index)

          return (
            <div className="wf-turn-wrapper">
              {dividers?.map((b) => (
                <div key={b.id} className="wf-compact-divider">
                  <span className="cd-line" />
                  <span className="cd-text">
                    {b.trigger === 'auto' ? '上下文已自动压缩' : '上下文已压缩'}
                    {b.coveredCount > 0 ? ` · 此前 ${b.coveredCount} 条已摘要为背景` : ' · 此前内容已摘要为背景'}
                  </span>
                  <span className="cd-line" />
                </div>
              ))}
              <WaterfallTurn
                userMessage={turn.userMessage}
                assistantMessages={assistantMsgs}
                allMessages={turn.messages}
                isStreaming={isStreaming}
              />
            </div>
          )
        }}
        components={{
          Footer: () => {
            const trailing = dividersByTurn.get(turns.length)
            if (!trailing) return null
            return (
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
            )
          },
        }}
      />

      {/* "回到最新"胶囊——用户离开底部后出现，点击恢复跟随 */}
      {!shouldFollow && !atBottom && (
        <button
          className="wf-jump-pill"
          onClick={handleJumpToLatest}
          aria-label="回到最新内容"
        >
          ↓ 回到最新
          {newTurnsWhileAway > 0 && (
            <span className="wf-jump-n"> · {newTurnsWhileAway} 轮新内容</span>
          )}
        </button>
      )}

      {/* 浮动审批栏（v9.5）——待审批工具以整条 bar 垂直堆叠在 composer 正上方，
          与 composer 同宽同中线。整条点击 = 批准（与 Tab 同语义），✗ = 拒绝；
          决定后原地淡化 500ms 再收拢，其余条目平滑补位，不主动打破专注。
          经 Portal 挂到 body：避免祖先 overflow/transform 让 fixed 失效或被裁剪 */}
      {displayOrder.length > 0 && (
        <Portal>
          <div className="wf-approval-bar">
            {displayOrder.map((id) => {
              const live = activeApprovals.find((a) => a.toolCallId === id)
              if (live) {
                const busy = approvalBusy.has(id)
                const isFirst = live.toolCallId === activeApprovals[0]?.toolCallId
                const risk = live.riskLevel
                return (
                  <div
                    key={id}
                    className="wf-approval-item"
                    role="button"
                    tabIndex={-1}
                    title="点击任意处批准"
                    onClick={() => decideApproval(live, 'approved')}
                  >
                    <span className={`ap-dot${risk === 'destructive' ? ' danger' : risk === 'elevated' ? ' warn' : ''}`} />
                    <span className="ap-name">{live.toolName}</span>
                    <span className="ap-reason" title={live.impactStatement}>{live.impactStatement}</span>
                    {isFirst && <kbd className="ap-tab">Tab 批准</kbd>}
                    <span className="ap-acts">
                      <button
                        type="button"
                        className="ap-btn ok"
                        disabled={busy}
                        title="批准"
                        onClick={(e) => { e.stopPropagation(); decideApproval(live, 'approved') }}
                      >
                        <Check size={14} />
                      </button>
                      <button
                        type="button"
                        className="ap-btn no"
                        disabled={busy}
                        title="拒绝"
                        onClick={(e) => { e.stopPropagation(); decideApproval(live, 'rejected') }}
                      >
                        <X size={14} />
                      </button>
                    </span>
                  </div>
                )
              }
              const ghost = approvalGhosts.get(id)
              if (!ghost) return null
              return (
                <div key={id} className={`wf-approval-item ghost ${ghost.decision}${ghost.collapsing ? ' collapse' : ''}`}>
                  <span className="ap-dot" />
                  <span className="ap-name">{ghost.approval.toolName}</span>
                  <span className="ap-reason">{ghost.decision === 'approved' ? '已批准' : '已拒绝'}</span>
                  <span className="ap-acts">
                    {ghost.decision === 'approved' ? <Check size={14} /> : <X size={14} />}
                  </span>
                </div>
              )
            })}
          </div>
        </Portal>
      )}
    </>
  )
}
