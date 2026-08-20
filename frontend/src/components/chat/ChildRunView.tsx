import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, ChevronLeft, GitBranch } from 'lucide-react'
import type {
  AttentionAction,
  AttentionNode,
  RunPhase,
  RunView,
} from '@/domain/chat/models'
import { USER_BUBBLE_WIDTH_CLASS } from '@/domain/chat/bubbleStyle'
import { Badge, Button, notify } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useChatStore } from '@/stores/chatStore'
import { useViewStateStore } from '@/stores/viewStateStore'
import { sendRunMessage, stopRun } from '@/api/irisApi'
import { ComposerTextarea } from './composer/ComposerTextarea'
import { RunSection } from './RunSection'

/**
 * 子 agent Run 的左缘浮层面板（docs/34 M7d）。
 * 数据来自 runsById（SSE 全量投影），完整时间线复用 RunSection/RoundSection。
 * 主子通信走 POST /api/v1/runs/{runId}/messages，停止走 POST /api/v1/runs/{runId}/stop。
 */

const TERMINAL_PHASES: ReadonlySet<RunPhase> = new Set([
  'succeeded',
  'failed',
  'cancelled',
])

export function isTerminalRunPhase(phase: RunPhase) {
  return TERMINAL_PHASES.has(phase)
}

export const phaseMeta: Record<
  RunPhase,
  { label: string; tone: 'info' | 'success' | 'warning' | 'danger' | 'neutral'; breathing: boolean }
> = {
  accepted: { label: '已接受', tone: 'info', breathing: true },
  running: { label: '进行中', tone: 'info', breathing: true },
  suspended: { label: '等待审批', tone: 'warning', breathing: false },
  verifying: { label: '验证中', tone: 'info', breathing: true },
  outcome_unknown: { label: '结果待核实', tone: 'warning', breathing: false },
  succeeded: { label: '已完成', tone: 'success', breathing: false },
  failed: { label: '失败', tone: 'danger', breathing: false },
  cancelled: { label: '已取消', tone: 'neutral', breathing: false },
}

function formatRunElapsed(run: RunView) {
  const start = new Date(run.startedAt).getTime()
  const end = run.endedAt ? new Date(run.endedAt).getTime() : Date.now()
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function runStatsText(run: RunView) {
  const counts = run.closure?.counts
  const rounds = counts?.rounds ?? run.roundIds.length
  const tools = counts?.toolCalls
  return [
    `${rounds} 轮`,
    tools != null ? `${tools} 个工具` : null,
    formatRunElapsed(run),
  ]
    .filter(Boolean)
    .join(' · ')
}

/** 已发送补充的会话级留痕：关面板再开不丢，直到页面刷新。 */
const sentLog = new Map<
  string,
  Array<{ text: string; at: number; state: 'queued' | 'injected' }>
>()

function KillButton({ runId, active }: { runId: string; active: boolean }) {
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!confirming) return
    const timer = window.setTimeout(() => setConfirming(false), 3000)
    return () => window.clearTimeout(timer)
  }, [confirming])

  return (
    <Button
      variant={confirming ? 'danger' : 'secondary'}
      size="sm"
      className="h-7 px-2 text-caption"
      disabled={!active}
      onClick={() => {
        if (!confirming) {
          setConfirming(true)
          return
        }
        setConfirming(false)
        stopRun(runId, 'user_requested')
          .then(() => {
            notify.info('已请求停止子运行', {
              description: '最终状态将由运行事件确认。',
            })
          })
          .catch((error: Error) => {
            notify.error('停止请求没有下发', {
              description: error.message,
            })
          })
      }}
    >
      {confirming ? '再点一次确认停止' : '停止'}
    </Button>
  )
}

interface ChildRunPanelProps {
  runId: string | null
  onClose: () => void
  onAttentionAction?: (
    node: AttentionNode,
    action: AttentionAction,
  ) => void
}

const ChildRunPanelView = memo(function ChildRunPanelView({
  runId,
  onClose,
  onAttentionAction,
}: ChildRunPanelProps) {
  const run = useChatStore((state) =>
    runId ? state.runsById[runId] : undefined,
  )
  const roundsById = useChatStore((state) => state.roundsById)
  const nodesById = useChatStore((state) => state.renderNodesById)
  const [expandedRoundIds, setExpandedRoundIds] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const [expandedNodeIds, setExpandedNodeIds] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const [draft, setDraft] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const [, setSentVersion] = useState(0)

  useEffect(() => {
    if (!runId) return
    setExpandedRoundIds(new Set())
    setExpandedNodeIds(
      new Set(Object.keys(useViewStateStore.getState().expandedNodeIds)),
    )
  }, [runId])

  useEffect(() => {
    if (!runId) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [runId, onClose])

  const active = run ? !isTerminalRunPhase(run.phase) : false
  const sent = runId ? sentLog.get(runId) ?? [] : []

  const handleSend = useCallback(async () => {
    const text = draft.trim()
    if (!text || !runId || !active) return
    try {
      const result = await sendRunMessage(runId, text)
      const list = sentLog.get(runId) ?? []
      list.push({ text, at: Date.now(), state: result.phase })
      sentLog.set(runId, list)
      setDraft('')
      setSentVersion((v) => v + 1)
      setHint(
        result.phase === 'queued'
          ? '已排队，将在下一 Round 边界注入'
          : '已注入子运行上下文',
      )
      window.setTimeout(() => setHint(null), 2500)
    } catch (error) {
      notify.error('补充消息没有发送', {
        description: error instanceof Error ? error.message : '请稍后重试。',
      })
    }
  }, [draft, runId, active])

  // 面板内滚动跟随（docs/36 M15 P1-10）：贴底时新内容自动跟随；
  // 离底时露出「回到最新」。useConversationFollow 的面板内简化版——
  // 内容量小、无虚拟列表，scrollTop 直写即可，无轮询。
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const jumpingRef = useRef(false)
  const [atBottom, setAtBottom] = useState(true)

  const handleScrollFollow = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 48
    if (jumpingRef.current) {
      // 平滑回底途中不改贴底态，避免按钮闪烁；抵达后解除
      if (nearBottom) jumpingRef.current = false
      return
    }
    atBottomRef.current = nearBottom
    setAtBottom(nearBottom)
  }, [])

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    jumpingRef.current = true
    atBottomRef.current = true
    setAtBottom(true)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  // 打开面板即定位到最新活动
  useEffect(() => {
    if (!runId) return
    atBottomRef.current = true
    jumpingRef.current = false
    setAtBottom(true)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [runId])

  // 贴底态下新内容（SSE 投影 / 已发补充）自动跟随；离底则不打扰阅读
  const sentCount = sent.length
  useEffect(() => {
    if (!atBottomRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [run, sentCount])

  if (!runId) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={cn(
          'flex h-dvh w-[min(28rem,85vw)] flex-col rounded-r-lg border-r border-border/70',
          'bg-surface-raised/95 shadow-floating backdrop-blur-md',
          'animate-node-enter motion-reduce:animate-none',
        )}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-2.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="返回对话"
            onClick={onClose}
          >
            <ChevronLeft aria-hidden="true" className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-small font-semibold text-ink">
              {run?.purpose ?? '子运行'}
            </p>
            {run?.progressSummary && (
              <p className="mt-0.5 truncate text-caption text-ink-muted">
                {run.progressSummary}
              </p>
            )}
          </div>
          {run && (
            <span className="flex shrink-0 items-center gap-2">
              <Badge
                tone={phaseMeta[run.phase].tone}
                showDot={phaseMeta[run.phase].breathing}
              >
                {phaseMeta[run.phase].label}
              </Badge>
              <KillButton runId={run.runId} active={active} />
            </span>
          )}
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            onScroll={handleScrollFollow}
            className="scrollbar-subtle flex-1 overflow-y-auto px-4 py-3"
          >
          {run ? (
            <>
              {/* 任务书：主 Agent 派发，中性灰底，区别于用户气泡 */}
              <div className="mb-3 rounded-md bg-surface-muted px-3.5 py-2.5">
                <p className="text-caption font-medium text-ink-subtle">
                  任务书
                </p>
                <p className="mt-0.5 text-body text-ink">{run.purpose}</p>
              </div>

              {/* 你的补充（会话内留痕） */}
              {sent.map((item, index) => (
                <div
                  key={`${item.at}-${index}`}
                  className="mb-3 flex justify-end"
                >
                  <div
                    className={cn(
                      USER_BUBBLE_WIDTH_CLASS,
                      'rounded-lg rounded-br-xs bg-primary-soft px-3.5 py-2.5',
                    )}
                  >
                    <p className="text-caption font-medium text-primary-foreground/80">
                      {item.state === 'queued' ? '已排队补充' : '已注入补充'}
                    </p>
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-body text-primary-foreground">
                      {item.text}
                    </p>
                  </div>
                </div>
              ))}

              <RunSection
                run={run}
                roundsById={roundsById}
                nodesById={nodesById}
                expandedRoundIds={expandedRoundIds}
                expandedNodeIds={expandedNodeIds}
                onToggleRound={(roundId, nodeIds) => {
                  setExpandedRoundIds((current) => {
                    const next = new Set(current)
                    if (next.has(roundId)) {
                      next.delete(roundId)
                      return next
                    }
                    next.add(roundId)
                    setExpandedNodeIds((nodes) => {
                      const merged = new Set(nodes)
                      for (const nodeId of nodeIds) merged.add(nodeId)
                      return merged
                    })
                    return next
                  })
                }}
                onToggleNode={(nodeId) => {
                  setExpandedNodeIds((current) => {
                    const next = new Set(current)
                    if (next.has(nodeId)) {
                      next.delete(nodeId)
                    } else {
                      next.add(nodeId)
                    }
                    return next
                  })
                }}
                onRevealNewRoundNodes={(roundId, nodeIds) => {
                  if (!expandedRoundIds.has(roundId)) return
                  setExpandedNodeIds((current) => {
                    const next = new Set(current)
                    for (const nodeId of nodeIds) next.add(nodeId)
                    return next
                  })
                }}
                onAttentionAction={onAttentionAction}
              />

              {/* 页脚统计 */}
              <div className="mt-3 flex flex-wrap items-center gap-2 text-caption text-ink-muted">
                <span>{runStatsText(run)}</span>
                {run.closure?.executionStatus === 'interrupted' && (
                  <Badge tone="warning">已中断</Badge>
                )}
              </div>

              {run.failure && (
                <div className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-small text-danger-foreground">
                  {run.failure.userMessage}
                </div>
              )}
            </>
          ) : (
            <p className="text-small text-ink-muted">
              该子运行的投影不在当前视野中，可能属于其他对话。
            </p>
          )}
          </div>

          {!atBottom && (
            <button
              type="button"
              className={cn(
                'absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full',
                'border border-border/70 bg-surface-raised/95 px-3 py-1 shadow-floating backdrop-blur-md',
                'text-caption text-ink-subtle hover:bg-surface-muted',
                'animate-overlay-in motion-reduce:animate-none',
                'focus-visible:outline-none focus-visible:shadow-focus',
              )}
              onClick={jumpToLatest}
            >
              回到最新
            </button>
          )}
        </div>

        {/* 底部补充输入框 */}
        <div className="shrink-0 border-t border-border/70 bg-surface-raised/95 px-3 py-2.5">
          <div className="flex items-end gap-2">
            <ComposerTextarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onSubmit={() => void handleSend()}
              disabled={!active}
              aria-label="向子运行补充"
              placeholder={
                active
                  ? '向子运行补充事实或约束…'
                  : '子运行已结束，不能再补充'
              }
              className={cn(
                'min-h-9 rounded-sm border border-border bg-surface px-3 py-2',
                'shadow-hairline placeholder:text-ink-muted',
                'transition-[border-color,box-shadow] duration-fast ease-standard',
                'focus:border-focus focus:shadow-focus',
                'disabled:bg-surface-muted disabled:text-ink-muted',
                'motion-reduce:transition-none',
              )}
            />
            <Button
              variant="primary"
              size="icon"
              className="h-9 w-9 shrink-0"
              disabled={!active || !draft.trim()}
              aria-label="发送补充"
              onClick={handleSend}
            >
              <ArrowUp aria-hidden="true" className="h-4 w-4" />
            </Button>
          </div>
          {hint && (
            <p className="mt-1.5 text-caption text-ink-muted">{hint}</p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
})

export function ChildRunPanel(props: ChildRunPanelProps) {
  if (!props.runId) return null
  return <ChildRunPanelView {...props} />
}

interface ChildRunCardProps {
  childRunId: string
  fallbackSummary: string
  onAttentionAction?: (
    node: AttentionNode,
    action: AttentionAction,
  ) => void
  onOpen?: (runId: string) => void
}

/**
 * 主时间线中 delegate_task 节点展开后的子运行摘要卡。
 */
export function ChildRunCard({
  childRunId,
  fallbackSummary,
  onAttentionAction,
  onOpen,
}: ChildRunCardProps) {
  const run = useChatStore((state) => state.runsById[childRunId])

  if (!run) {
    return (
      <div className="space-y-1">
        <p>{fallbackSummary}</p>
        <p className="font-mono text-caption text-ink-muted">
          child run · {childRunId}
        </p>
      </div>
    )
  }

  const meta = phaseMeta[run.phase]
  const summary = run.progressSummary || fallbackSummary

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={meta.tone} showDot={meta.breathing}>
          {meta.label}
        </Badge>
        <span className="text-caption text-ink-muted">
          {runStatsText(run)}
        </span>
      </div>
      {summary && <p>{summary}</p>}
      {run.failure && (
        <p className="text-small text-danger">{run.failure.userMessage}</p>
      )}
      {onOpen && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-caption"
            onClick={() => onOpen(childRunId)}
          >
            查看完整运行
          </Button>
        </div>
      )}
    </div>
  )
}

interface ChildRunCapsulesProps {
  viewerRunId: string | null
  onOpen: (runId: string) => void
  onClose: () => void
  onAttentionAction?: (
    node: AttentionNode,
    action: AttentionAction,
  ) => void
}

/**
 * ComposerDock 上方的运行中胶囊条：只列出当前会话仍未终态的子 Run。
 */
export function ChildRunCapsules({
  onOpen,
}: ChildRunCapsulesProps) {
  const runsById = useChatStore((state) => state.runsById)

  const liveChildren = useMemo(
    () =>
      Object.values(runsById)
        .filter(
          (run) => run.parentRunId !== null && !isTerminalRunPhase(run.phase),
        )
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    [runsById],
  )

  if (liveChildren.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1 pb-2">
      <GitBranch
        aria-hidden="true"
        className="h-3.5 w-3.5 text-ink-muted"
      />
      {liveChildren.map((run) => {
        const meta = phaseMeta[run.phase]
        return (
          <button
            key={run.runId}
            type="button"
            className={cn(
              'inline-flex max-w-64 items-center gap-1.5 rounded-full border border-border/70 bg-surface-raised/92 px-2.5 py-1',
              'text-caption text-ink-subtle shadow-hairline backdrop-blur-md',
              'transition-[color,background-color,transform] duration-fast ease-standard',
              'hover:bg-surface-muted active:scale-[0.98]',
              'focus-visible:outline-none focus-visible:shadow-focus motion-reduce:transition-none',
            )}
            onClick={() => onOpen(run.runId)}
          >
            <span
              aria-hidden="true"
              className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                meta.tone === 'info' && 'bg-primary',
                meta.tone === 'warning' && 'bg-warning',
              )}
            />
            <span className="truncate">{run.purpose}</span>
            <span className="shrink-0 text-ink-muted">{meta.label}</span>
          </button>
        )
      })}
    </div>
  )
}
