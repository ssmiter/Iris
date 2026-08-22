import { memo } from 'react'
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

export const RunSection = memo(function RunSection({
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
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-small font-medium text-ink">{run.purpose}</p>
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
}, (previous, next) => {
  if (previous.run !== next.run) return false
  if (!sameExpandedIds(previous.expandedRoundIds, next.expandedRoundIds)) {
    return false
  }
  if (!sameExpandedIds(previous.expandedNodeIds, next.expandedNodeIds)) {
    return false
  }
  for (const roundId of next.run.roundIds) {
    const previousRound = previous.roundsById[roundId]
    const nextRound = next.roundsById[roundId]
    if (previousRound !== nextRound) return false
    if (!previousRound || !nextRound) continue

    for (const nodeId of nextRound.processNodeIds) {
      if (previous.nodesById[nodeId] !== next.nodesById[nodeId]) return false
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
  return (
    previous.onToggleRound === next.onToggleRound
    && previous.onToggleNode === next.onToggleNode
    && previous.onRevealNewRoundNodes === next.onRevealNewRoundNodes
    && previous.onAttentionAction === next.onAttentionAction
    && previous.onOpenChildRun === next.onOpenChildRun
  )
})

function answerNodeForRound(
  round: RoundView,
  nodesById: Record<string, RenderNode>,
) {
  if (round.answerNodeId) return nodesById[round.answerNodeId]
  return Object.values(nodesById).find(
    (node) => node.type === 'answer' && node.roundId === round.roundId,
  )
}

function sameExpandedIds(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
) {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const id of a) {
    if (!b.has(id)) return false
  }
  return true
}
