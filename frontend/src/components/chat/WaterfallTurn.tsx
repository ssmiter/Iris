import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertTriangle, Clock3, GitBranch, Pencil } from 'lucide-react'
import type {
  AttentionAction,
  AttentionNode,
  FailureView,
  RenderNode,
  RoundView,
  RunView,
  TurnView,
} from '@/domain/chat/models'
import { Button } from '@/components/ui'
import { RunSection } from './RunSection'
import { cn } from '@/lib/cn'
import { UserAttachmentList } from './UserAttachmentList'

interface WaterfallTurnProps {
  turn: TurnView
  runsById: Record<string, RunView>
  roundsById: Record<string, RoundView>
  nodesById: Record<string, RenderNode>
  expandedRoundIds: ReadonlySet<string>
  expandedNodeIds: ReadonlySet<string>
  onToggleRound: (roundId: string, nodeIds: string[]) => void
  onToggleNode: (nodeId: string) => void
  onRevealNewRoundNodes: (roundId: string, nodeIds: string[]) => void
  onAttentionAction?: (
    node: AttentionNode,
    action: AttentionAction,
  ) => void
  onReplaceRequest?: (turn: TurnView) => void
  onEditResend?: (turn: TurnView, text: string) => void
  onOpenChildRun?: (runId: string) => void
}

const phaseLabel: Record<TurnView['phase'], string> = {
  queued: '等待开始',
  active: '正在处理',
  settled: '本轮已结束',
  stopped: '已停止',
  failed: '失败',
}

/**
 * 已播过入场动画的 Turn（会话级，不持久化）。
 * 只有新到达的 Turn（queued/active）播淡入微升；历史水合的 Turn 全部 settled，
 * 不会入册也不会播；Virtuoso 回收重建靠此集合防重放。
 */
const bornTurnIds = new Set<string>()

function visiblePhaseLabel(turn: TurnView, run?: RunView) {
  if (turn.phase === 'active' && turn.stop) {
    return turn.stop.state === 'draining' ? '正在核验后停止' : '正在停止'
  }
  if (run?.closure?.executionStatus === 'uncertain') {
    return '结果待核对'
  }
  if (turn.phase === 'settled') {
    if (run?.closure?.taskOutcome === 'fulfilled') {
      return '任务已完成'
    }
    if (run?.closure?.taskOutcome === 'blocked') {
      return '任务有阻塞'
    }
  }
  return phaseLabel[turn.phase]
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatElapsed(turn: TurnView) {
  const start = new Date(turn.stats.startedAt).getTime()
  const end = turn.stats.endedAt
    ? new Date(turn.stats.endedAt).getTime()
    : start
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** FailureView.recoveryAction → 用户可读的恢复建议（后端已投影，此前只显示 userMessage） */
const recoveryLabel: Record<FailureView['recoveryAction'], string | null> = {
  retry_same: '可以直接重试',
  reprepare: '将重新准备后重试',
  rediscover: '将重新发现可行路径',
  reconcile: '需要核对已发生的影响',
  user_input: '需要你的补充信息',
  none: null,
}

const sideEffectLabel: Partial<Record<FailureView['sideEffectOutcome'], string>> = {
  may_have_applied: '部分操作可能已生效，请核验',
  confirmed_applied: '部分操作已生效',
}

function WaterfallTurnView({
  turn,
  runsById,
  roundsById,
  nodesById,
  expandedRoundIds,
  expandedNodeIds,
  onToggleRound,
  onToggleNode,
  onRevealNewRoundNodes,
  onAttentionAction,
  onReplaceRequest,
  onEditResend,
  onOpenChildRun,
}: WaterfallTurnProps) {
  const rootRun = runsById[turn.rootRunId]
  const hasPendingAttention = turn.pendingAttentionIds.length > 0
  const closureNeedsAttention =
    rootRun?.closure?.executionStatus === 'uncertain' ||
    rootRun?.closure?.taskOutcome === 'blocked'
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(turn.request.text)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const composingRef = useRef(false)
  const canEdit =
    Boolean(onReplaceRequest) &&
    turn.phase !== 'queued' &&
    turn.phase !== 'active'
  // 入场动画只在挂载瞬间判定一次：新 Turn（queued/active）才播。
  const [born] = useState(() => {
    const fresh = turn.phase === 'queued' || turn.phase === 'active'
    if (!fresh || bornTurnIds.has(turn.turnId)) return false
    bornTurnIds.add(turn.turnId)
    if (bornTurnIds.size > 2048) {
      const oldest = bornTurnIds.values().next().value
      if (oldest) bornTurnIds.delete(oldest)
    }
    return true
  })

  const resize = useCallback(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    const lineHeight = Number.parseFloat(
      window.getComputedStyle(element).lineHeight,
    )
    const maxHeight = lineHeight * 8
    element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`
    element.style.overflowY =
      element.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [])

  useLayoutEffect(() => {
    if (!editing) return
    resize()
  }, [editing, draft, resize])

  useEffect(() => {
    if (!editing) return
    textareaRef.current?.focus()
  }, [editing])

  const handleCommit = useCallback(() => {
    const text = draft.trim()
    setEditing(false)
    if (!text || text === turn.request.text) return
    if (onEditResend) {
      onEditResend(turn, text)
    } else {
      // 回退：通过「从这里改问」的 replacement 路径把编辑后的文本塞进 composer，
      // 用户仍需在 composer 里按一次发送。完整的一键重发需要高层提供 onEditResend。
      onReplaceRequest?.({ ...turn, request: { ...turn.request, text } })
    }
  }, [draft, onEditResend, onReplaceRequest, turn])

  const handleCancel = useCallback(() => {
    setEditing(false)
    setDraft(turn.request.text)
  }, [turn.request.text])

  const handleEnterEdit = useCallback(() => {
    setDraft(turn.request.text)
    setEditing(true)
  }, [turn.request.text])

  return (
    <article
      className={cn(
        'mx-auto w-full max-w-conversation px-[var(--conversation-pad)] py-6',
        born && 'animate-node-enter motion-reduce:animate-none',
      )}
    >
      <div className="flex justify-end">
        <div className="group max-w-[88%] sm:max-w-[min(82%,40rem)]">
          <UserAttachmentList
            references={turn.request.attachmentRefs}
          />
          {editing ? (
            <div className="animate-node-enter motion-reduce:animate-none">
              <textarea
                ref={textareaRef}
                value={draft}
                rows={Math.min(8, Math.max(2, draft.split('\n').length))}
                className={cn(
                  'w-full resize-none rounded-lg rounded-br-xs border border-primary/30',
                  'bg-surface-raised px-4 py-3 text-body text-ink outline-none',
                  'transition-[border-color,box-shadow] duration-fast ease-standard',
                  'focus:border-primary/60 focus:shadow-focus motion-reduce:transition-none',
                )}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    handleCancel()
                    return
                  }
                  if (
                    e.key === 'Enter' &&
                    (e.ctrlKey || e.metaKey) &&
                    !composingRef.current &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault()
                    handleCommit()
                  }
                }}
                onCompositionStart={() => {
                  composingRef.current = true
                }}
                onCompositionEnd={() => {
                  composingRef.current = false
                }}
              />
              <div className="mt-1.5 flex items-center justify-end gap-2">
                <span className="text-caption text-ink-muted">
                  Esc 取消 · Ctrl+Enter 重发
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-caption"
                  onClick={handleCancel}
                >
                  取消
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  className="h-7 px-2 text-caption"
                  disabled={!draft.trim()}
                  onClick={handleCommit}
                >
                  重发
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="rounded-lg rounded-br-xs bg-surface-muted px-4 py-3 text-body text-ink">
                {turn.request.text}
              </div>
              {canEdit && (
                <div className="mt-1 flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-caption opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={handleEnterEdit}
                  >
                    <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                    编辑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-caption opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => onReplaceRequest!(turn)}
                  >
                    <GitBranch aria-hidden="true" className="h-3.5 w-3.5" />
                    从这里改问
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="mt-4 min-w-0">
        {hasPendingAttention && (
          <div className="mb-2 flex items-center gap-2 text-small text-warning">
            <AlertTriangle aria-hidden="true" className="h-4 w-4" />
            <span>{turn.pendingAttentionIds.length} 项操作需要你的决定</span>
          </div>
        )}

        {rootRun ? (
          <RunSection
            run={rootRun}
            roundsById={roundsById}
            nodesById={nodesById}
            expandedRoundIds={expandedRoundIds}
            expandedNodeIds={expandedNodeIds}
            onToggleRound={onToggleRound}
            onToggleNode={onToggleNode}
            onRevealNewRoundNodes={onRevealNewRoundNodes}
            onAttentionAction={onAttentionAction}
            onOpenChildRun={onOpenChildRun}
          />
        ) : (
          <div className="rounded-md bg-danger-soft p-3 text-small text-danger-foreground">
            当前 Turn 缺少 root Run 投影，无法安全重建过程。
          </div>
        )}

        {turn.failure && (
          <div
            className="mt-3 flex gap-2 rounded-md bg-danger-soft px-3 py-2.5 text-small text-danger-foreground"
            role="alert"
          >
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <div className="min-w-0">
              <p>{turn.failure.userMessage}</p>
              <p className="mt-1 text-caption opacity-80">
                {[
                  sideEffectLabel[turn.failure.sideEffectOutcome],
                  recoveryLabel[turn.failure.recoveryAction],
                  `traceId ${turn.failure.traceId.slice(0, 8)}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
          </div>
        )}

        <footer
          className={cn(
            'mt-2 flex flex-wrap items-center gap-2 text-caption text-ink-muted',
            turn.phase === 'failed' &&
              !closureNeedsAttention &&
              'text-danger',
            (turn.phase === 'stopped' || closureNeedsAttention) &&
              'text-warning',
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'h-1.5 w-1.5 rounded-full bg-border-strong',
              turn.phase === 'active' && 'bg-primary',
              turn.phase === 'failed' &&
                !closureNeedsAttention &&
                'bg-danger',
              (turn.phase === 'stopped' || closureNeedsAttention) &&
                'bg-warning',
            )}
          />
          <span
            className={cn(
              turn.phase === 'active' && 'text-primary',
              turn.phase === 'failed' &&
                !closureNeedsAttention &&
                'text-danger',
              (turn.phase === 'stopped' || closureNeedsAttention) &&
                'text-warning',
            )}
          >
            {visiblePhaseLabel(turn, rootRun)}
          </span>
          {' · '}
          <span className="font-mono tabular-nums">
            {formatTime(turn.stats.startedAt)}
          </span>
          <span>· {turn.stats.roundCount} 轮</span>
          <span>· {turn.stats.toolCallCount} 个工具</span>
          {turn.stats.childRunCount > 0 && (
            <span>· {turn.stats.childRunCount} 个子运行</span>
          )}
          <span className="inline-flex items-center gap-1">
            <Clock3 aria-hidden="true" className="h-3 w-3" />
            {formatElapsed(turn)}
          </span>
        </footer>
      </div>
    </article>
  )
}

function answerNodeForRound(
  round: RoundView,
  nodesById: Record<string, RenderNode>,
) {
  if (round.answerNodeId) return nodesById[round.answerNodeId]
  return Object.values(nodesById).find(
    (node) =>
      node.type === 'answer'
      && node.roundId === round.roundId,
  )
}

function sameTurnProjection(
  previous: WaterfallTurnProps,
  next: WaterfallTurnProps,
) {
  if (
    previous.turn !== next.turn
    || previous.onToggleRound !== next.onToggleRound
    || previous.onToggleNode !== next.onToggleNode
    || previous.onRevealNewRoundNodes !== next.onRevealNewRoundNodes
    || previous.onAttentionAction !== next.onAttentionAction
    || previous.onReplaceRequest !== next.onReplaceRequest
    || previous.onEditResend !== next.onEditResend
    || previous.onOpenChildRun !== next.onOpenChildRun
  ) {
    return false
  }

  const previousRun = previous.runsById[previous.turn.rootRunId]
  const nextRun = next.runsById[next.turn.rootRunId]
  if (previousRun !== nextRun) return false
  if (!previousRun || !nextRun) return true

  for (const roundId of nextRun.roundIds) {
    const previousRound = previous.roundsById[roundId]
    const nextRound = next.roundsById[roundId]
    if (
      previousRound !== nextRound
      || previous.expandedRoundIds.has(roundId)
        !== next.expandedRoundIds.has(roundId)
    ) {
      return false
    }
    if (!previousRound || !nextRound) continue

    for (const nodeId of nextRound.processNodeIds) {
      if (
        previous.nodesById[nodeId] !== next.nodesById[nodeId]
        || previous.expandedNodeIds.has(nodeId)
          !== next.expandedNodeIds.has(nodeId)
      ) {
        return false
      }
    }

    const previousAnswer = answerNodeForRound(previousRound, previous.nodesById)
    const nextAnswer = answerNodeForRound(nextRound, next.nodesById)
    if (
      previousAnswer?.nodeId !== nextAnswer?.nodeId
      || previousAnswer?.status !== nextAnswer?.status
    ) {
      return false
    }
  }

  return true
}

export const WaterfallTurn = memo(
  WaterfallTurnView,
  sameTurnProjection,
)
