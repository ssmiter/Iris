import { AlertTriangle, Clock3, GitBranch } from 'lucide-react'
import type {
  AttentionAction,
  AttentionNode,
  RenderNode,
  RoundView,
  RunView,
  TurnView,
} from '@/domain/chat/models'
import { Badge, Button } from '@/components/ui'
import { RunSection } from './RunSection'
import { cn } from '@/lib/cn'

interface WaterfallTurnProps {
  turn: TurnView
  runsById: Record<string, RunView>
  roundsById: Record<string, RoundView>
  nodesById: Record<string, RenderNode>
  expandedRoundIds: ReadonlySet<string>
  expandedNodeIds: ReadonlySet<string>
  onToggleRound: (roundId: string) => void
  onToggleNode: (nodeId: string) => void
  onAttentionAction?: (
    node: AttentionNode,
    action: AttentionAction,
  ) => void
  onReplaceRequest?: (turn: TurnView) => void
}

const phaseLabel: Record<TurnView['phase'], string> = {
  queued: '等待开始',
  active: '正在处理',
  settled: '已完成',
  stopped: '已停止',
  failed: '失败',
}

function formatElapsed(turn: TurnView) {
  const start = new Date(turn.stats.startedAt).getTime()
  const end = turn.stats.endedAt
    ? new Date(turn.stats.endedAt).getTime()
    : start
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function WaterfallTurn({
  turn,
  runsById,
  roundsById,
  nodesById,
  expandedRoundIds,
  expandedNodeIds,
  onToggleRound,
  onToggleNode,
  onAttentionAction,
  onReplaceRequest,
}: WaterfallTurnProps) {
  const rootRun = runsById[turn.rootRunId]
  const hasPendingAttention = turn.pendingAttentionIds.length > 0

  return (
    <article className="mx-auto w-full max-w-conversation px-[var(--conversation-pad)] py-7">
      <div className="flex justify-end">
        <div className="group max-w-[92%] sm:max-w-[min(86%,42rem)]">
          <div className="rounded-lg rounded-br-xs bg-primary px-4 py-3 text-body text-primary-foreground shadow-hairline">
            {turn.request.text}
          </div>
          {onReplaceRequest &&
            turn.phase !== 'queued' &&
            turn.phase !== 'active' && (
              <div className="mt-1 flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-caption opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => onReplaceRequest(turn)}
                >
                  <GitBranch aria-hidden="true" className="h-3.5 w-3.5" />
                  从这里改问
                </Button>
              </div>
            )}
        </div>
      </div>

      <div className="mt-5 min-w-0">
        {hasPendingAttention && (
          <div className="mb-2 flex items-center gap-2 px-2 text-small text-warning">
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
            onAttentionAction={onAttentionAction}
          />
        ) : (
          <div className="rounded-md border border-danger/30 bg-danger-soft p-3 text-small text-danger-foreground">
            当前 Turn 缺少 root Run 投影，无法安全重建过程。
          </div>
        )}

        {turn.failure && (
          <div
            className="mt-3 flex gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-small text-danger-foreground"
            role="alert"
          >
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <p>{turn.failure.userMessage}</p>
          </div>
        )}

        <footer
          className={cn(
            'mt-2 flex flex-wrap items-center gap-2 px-2 text-caption text-ink-muted',
            turn.phase === 'failed' && 'text-danger',
            turn.phase === 'stopped' && 'text-warning',
          )}
        >
          <Badge
            tone={
              turn.phase === 'failed'
                ? 'danger'
                : turn.phase === 'active'
                  ? 'info'
                  : 'neutral'
            }
            appearance="outline"
          >
            {turn.phase === 'active' && turn.stop
              ? turn.stop.state === 'draining'
                ? '正在核验后停止'
                : '正在停止'
              : phaseLabel[turn.phase]}
          </Badge>
          <span>{turn.stats.roundCount} 轮</span>
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
