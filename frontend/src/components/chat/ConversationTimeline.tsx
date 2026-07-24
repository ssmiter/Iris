import { useCallback, useMemo, useRef } from 'react'
import { ArrowDown } from 'lucide-react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import type {
  AttentionAction,
  AttentionNode,
  ConversationProjection,
} from '@/domain/chat/models'
import { Button } from '@/components/ui'
import { useViewStateStore } from '@/stores/viewStateStore'
import { WaterfallTurn } from './WaterfallTurn'

interface ConversationTimelineProps {
  projection: ConversationProjection
  onAttentionAction?: (
    node: AttentionNode,
    action: AttentionAction,
  ) => void
}

export function ConversationTimeline({
  projection,
  onAttentionAction,
}: ConversationTimelineProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const expandedRoundFlags = useViewStateStore(
    (state) => state.expandedRoundIds,
  )
  const expandedNodeFlags = useViewStateStore(
    (state) => state.expandedNodeIds,
  )
  const atBottom = useViewStateStore((state) => state.atBottom)
  const followMode = useViewStateStore((state) => state.followMode)
  const setScrollState = useViewStateStore((state) => state.setScrollState)
  const followLatest = useViewStateStore((state) => state.followLatest)
  const toggleRound = useViewStateStore((state) => state.toggleRound)
  const toggleNode = useViewStateStore((state) => state.toggleNode)
  const expandedRoundIds = useMemo(
    () => new Set(Object.keys(expandedRoundFlags)),
    [expandedRoundFlags],
  )
  const expandedNodeIds = useMemo(
    () => new Set(Object.keys(expandedNodeFlags)),
    [expandedNodeFlags],
  )

  const boundariesByTurn = useMemo(() => {
    const map = new Map<
      string,
      ConversationProjection['compactBoundaries']
    >()
    for (const boundary of projection.compactBoundaries) {
      const existing = map.get(boundary.beforeTurnId) ?? []
      map.set(boundary.beforeTurnId, [...existing, boundary])
    }
    return map
  }, [projection.compactBoundaries])

  const handleAtBottomChange = useCallback((isAtBottom: boolean) => {
    setScrollState(isAtBottom)
  }, [setScrollState])

  const jumpToLatest = useCallback(() => {
    followLatest()
    virtuosoRef.current?.scrollToIndex({
      index: projection.turns.length - 1,
      align: 'end',
      behavior: 'smooth',
    })
  }, [followLatest, projection.turns.length])

  return (
    <div className="relative min-h-0 flex-1">
      <Virtuoso
        ref={virtuosoRef}
        className="h-full subtle-scrollbar"
        data={projection.turns}
        computeItemKey={(_, turn) => turn.turnId}
        initialTopMostItemIndex={Math.max(0, projection.turns.length - 1)}
        increaseViewportBy={{ top: 320, bottom: 200 }}
        atBottomThreshold={72}
        atBottomStateChange={handleAtBottomChange}
        followOutput={(isAtBottomNow) =>
          followMode === 'following' && isAtBottomNow ? 'auto' : false
        }
        itemContent={(_, turn) => (
          <div>
            {boundariesByTurn.get(turn.turnId)?.map((boundary) => (
              <div
                key={boundary.boundaryId}
                className="mx-auto flex max-w-conversation items-center gap-3 px-[var(--conversation-pad)] py-4 text-caption text-ink-muted"
              >
                <span className="h-px flex-1 bg-border" />
                <span className="text-center">
                  {boundary.trigger === 'auto'
                    ? '此前上下文已自动整理'
                    : '此前上下文已整理'}
                  {' · '}
                  {boundary.coveredCount} 个 Turn 仍保留在历史中
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
            ))}
            <WaterfallTurn
              turn={turn}
              runsById={projection.runsById}
              roundsById={projection.roundsById}
              nodesById={projection.renderNodesById}
              expandedRoundIds={expandedRoundIds}
              expandedNodeIds={expandedNodeIds}
              onToggleRound={toggleRound}
              onToggleNode={toggleNode}
              onAttentionAction={onAttentionAction}
            />
          </div>
        )}
      />

      {!atBottom && (
        <Button
          variant="secondary"
          size="sm"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-surface-raised shadow-floating"
          onClick={jumpToLatest}
        >
          <ArrowDown aria-hidden="true" className="h-4 w-4" />
          回到最新
        </Button>
      )}
    </div>
  )
}
