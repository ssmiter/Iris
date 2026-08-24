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
import { answerNodeForRound } from '@/domain/chat/selectors'

interface RunSectionProps {
  run: RunView
  roundsById: Record<string, RoundView>
  nodesById: Record<string, RenderNode>
  answerNodeIdsByRoundId: ReadonlyMap<string, string>
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
  answerNodeIdsByRoundId,
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
          answerNodeIdsByRoundId={answerNodeIdsByRoundId}
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
  if (previous.answerNodeIdsByRoundId !== next.answerNodeIdsByRoundId) {
    return false
  }
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

    const previousAnswer = answerNodeForRound(
      previousRound,
      previous.nodesById,
      previous.answerNodeIdsByRoundId,
    )
    const nextAnswer = answerNodeForRound(
      nextRound,
      next.nodesById,
      next.answerNodeIdsByRoundId,
    )
    // 与 WaterfallTurn 同款流式铁律：answer 内容经对象引用比较，
    // 否则流式 delta 被 memo 挡死，completed 时一次性崩出全文。
    if (previousAnswer !== nextAnswer) return false
  }
  return (
    previous.onToggleRound === next.onToggleRound
    && previous.onToggleNode === next.onToggleNode
    && previous.onRevealNewRoundNodes === next.onRevealNewRoundNodes
    && previous.onAttentionAction === next.onAttentionAction
    && previous.onOpenChildRun === next.onOpenChildRun
  )
})

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
