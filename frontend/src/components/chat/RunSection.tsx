import { GitBranch } from 'lucide-react'
import type {
  AttentionAction,
  AttentionNode,
  RenderNode,
  RoundView,
  RunView,
} from '@/domain/chat/models'
import { Badge } from '@/components/ui'
import { RoundSection } from './RoundSection'

interface RunSectionProps {
  run: RunView
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
  onOpenChildRun?: (runId: string) => void
}

export function RunSection({
  run,
  roundsById,
  nodesById,
  expandedRoundIds,
  expandedNodeIds,
  onToggleRound,
  onToggleNode,
  onRevealNewRoundNodes,
  onAttentionAction,
  onOpenChildRun,
}: RunSectionProps) {
  const rounds = run.roundIds
    .map((roundId) => roundsById[roundId])
    .filter((round): round is RoundView => Boolean(round))

  if (run.kind === 'pipeline' && rounds.length === 0) {
    return (
      <div className="my-3 flex items-start gap-3 rounded-md bg-surface-muted p-3">
        <GitBranch aria-hidden="true" className="mt-0.5 h-4 w-4 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-small font-semibold text-ink">{run.purpose}</p>
            <Badge tone="info">固定流程</Badge>
          </div>
          <p className="mt-1 text-small text-ink-subtle">
            {run.progressSummary ?? '流程状态已记录。'}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div>
      {rounds.map((round) => (
        <RoundSection
          key={round.roundId}
          round={round}
          nodesById={nodesById}
          processExpanded={expandedRoundIds.has(round.roundId)}
          expandedNodeIds={expandedNodeIds}
          onToggleProcess={(nodeIds) =>
            onToggleRound(round.roundId, nodeIds)
          }
          onToggleNode={onToggleNode}
          onRevealNewNodes={(nodeIds) =>
            onRevealNewRoundNodes(round.roundId, nodeIds)
          }
          onAttentionAction={onAttentionAction}
          onOpenChildRun={onOpenChildRun}
        />
      ))}
    </div>
  )
}
