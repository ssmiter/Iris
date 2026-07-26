import { useCallback, useEffect, useMemo, useRef } from 'react'
import { ArrowDown } from 'lucide-react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import type {
  AttentionAction,
  AttentionNode,
  ConversationProjection,
  TurnView,
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
  onReplaceRequest?: (turn: TurnView) => void
}

export function ConversationTimeline({
  projection,
  onAttentionAction,
  onReplaceRequest,
}: ConversationTimelineProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const scrollerRef = useRef<HTMLElement | Window | null>(null)
  const previousTurnCount = useRef(projection.turns.length)
  const expandedRoundFlags = useViewStateStore(
    (state) => state.expandedRoundIds,
  )
  const expandedNodeFlags = useViewStateStore(
    (state) => state.expandedNodeIds,
  )
  const atBottom = useViewStateStore((state) => state.atBottom)
  const followMode = useViewStateStore((state) => state.followMode)
  const unseenTurnCount = useViewStateStore((state) => state.unseenTurnCount)
  const setScrollState = useViewStateStore((state) => state.setScrollState)
  const reviewHistory = useViewStateStore((state) => state.reviewHistory)
  const addUnseenTurns = useViewStateStore((state) => state.addUnseenTurns)
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

  useEffect(() => {
    const newTurnCount = projection.turns.length - previousTurnCount.current
    if (newTurnCount > 0) {
      addUnseenTurns(newTurnCount)
    }
    previousTurnCount.current = projection.turns.length
  }, [addUnseenTurns, projection.turns.length])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    let touchStartY: number | null = null
    const onWheel = (event: Event) => {
      if ((event as WheelEvent).deltaY < 0) reviewHistory()
    }
    const onKeyDown = (event: Event) => {
      const key = (event as KeyboardEvent).key
      if (['ArrowUp', 'PageUp', 'Home'].includes(key)) reviewHistory()
    }
    const onTouchStart = (event: Event) => {
      touchStartY = (event as TouchEvent).touches[0]?.clientY ?? null
    }
    const onTouchMove = (event: Event) => {
      const currentY = (event as TouchEvent).touches[0]?.clientY
      if (
        touchStartY !== null
        && currentY !== undefined
        && currentY > touchStartY + 4
      ) {
        reviewHistory()
      }
    }

    scroller.addEventListener('wheel', onWheel, { passive: true })
    scroller.addEventListener('keydown', onKeyDown)
    scroller.addEventListener('touchstart', onTouchStart, { passive: true })
    scroller.addEventListener('touchmove', onTouchMove, { passive: true })
    return () => {
      scroller.removeEventListener('wheel', onWheel)
      scroller.removeEventListener('keydown', onKeyDown)
      scroller.removeEventListener('touchstart', onTouchStart)
      scroller.removeEventListener('touchmove', onTouchMove)
    }
  }, [reviewHistory])

  return (
    <div className="relative min-h-0 flex-1">
      <Virtuoso
        ref={virtuosoRef}
        scrollerRef={(element) => {
          scrollerRef.current = element
        }}
        className="h-full subtle-scrollbar"
        data={projection.turns}
        computeItemKey={(_, turn) => turn.turnId}
        initialTopMostItemIndex={Math.max(0, projection.turns.length - 1)}
        increaseViewportBy={{ top: 320, bottom: 200 }}
        atBottomThreshold={72}
        atBottomStateChange={handleAtBottomChange}
        followOutput={() => followMode === 'following' ? 'auto' : false}
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
              onReplaceRequest={onReplaceRequest}
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
          {unseenTurnCount > 0
            ? `${unseenTurnCount} 个新轮次 · 回到最新`
            : '回到最新'}
        </Button>
      )}
    </div>
  )
}
