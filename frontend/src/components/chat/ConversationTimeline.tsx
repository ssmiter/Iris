import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react'
import { ArrowDown } from 'lucide-react'
import { Virtuoso } from 'react-virtuoso'
import type {
  AttentionAction,
  AttentionNode,
  ConversationProjection,
  TurnView,
} from '@/domain/chat/models'
import { Button } from '@/components/ui'
import { useViewStateStore } from '@/stores/viewStateStore'
import { WaterfallTurn } from './WaterfallTurn'
import { useConversationFollow } from './useConversationFollow'

interface ConversationTimelineProps {
  projection: ConversationProjection
  hasEarlierTurns?: boolean
  earlierLoading?: boolean
  onLoadEarlier?: () => void
  onAttentionAction?: (
    node: AttentionNode,
    action: AttentionAction,
  ) => void
  onReplaceRequest?: (turn: TurnView) => void
  onEditResend?: (turn: TurnView, text: string) => void
  onOpenChildRun?: (runId: string) => void
}

export interface ConversationTimelineHandle {
  /** 平滑滚动到指定 Turn（按当前投影数组下标） */
  scrollToTurn: (turnIndex: number) => void
}

// firstItemIndex 的锚定基数：向上翻页时按预插数量递减，
// Virtuoso 借此保持视口中的内容一个像素都不动。
const FIRST_ITEM_INDEX_BASE = 1_000_000

export const ConversationTimeline = forwardRef<
  ConversationTimelineHandle,
  ConversationTimelineProps
>(function ConversationTimeline(
  {
    projection,
    hasEarlierTurns = false,
    earlierLoading = false,
    onLoadEarlier,
    onAttentionAction,
    onReplaceRequest,
    onEditResend,
    onOpenChildRun,
  },
  ref,
) {
  const firstItemIndexRef = useRef(FIRST_ITEM_INDEX_BASE)
  const firstTurnIdRef = useRef<string | undefined>(
    projection.turns[0]?.turnId,
  )

  // 渲染期检测预插：旧首项在新数组里的位置即预插数量；
  // 找不到（换对话/换分支）则回到锚定基数。
  const firstTurnId = projection.turns[0]?.turnId
  if (firstTurnIdRef.current !== firstTurnId) {
    const previousFirst = firstTurnIdRef.current
    const prepended = previousFirst
      ? projection.turns.findIndex((turn) => turn.turnId === previousFirst)
      : -1
    firstItemIndexRef.current =
      prepended > 0
        ? firstItemIndexRef.current - prepended
        : FIRST_ITEM_INDEX_BASE
    firstTurnIdRef.current = firstTurnId
  }
  const firstItemIndex = firstItemIndexRef.current
  const expandedRoundFlags = useViewStateStore(
    (state) => state.expandedRoundIds,
  )
  const expandedNodeFlags = useViewStateStore(
    (state) => state.expandedNodeIds,
  )
  const toggleRound = useViewStateStore((state) => state.toggleRound)
  const toggleNode = useViewStateStore((state) => state.toggleNode)
  const revealNewRoundNodes = useViewStateStore(
    (state) => state.revealNewRoundNodes,
  )
  const {
    virtuosoRef,
    setScroller,
    followMode,
    unseenTurnCount,
    handleAtBottomChange,
    handleListHeightChange,
    followOutput,
    jumpToLatest,
  } = useConversationFollow(projection.turns.length, firstItemIndex)
  const expandedRoundIds = useMemo(
    () => new Set(Object.keys(expandedRoundFlags)),
    [expandedRoundFlags],
  )
  const expandedNodeIds = useMemo(
    () => new Set(Object.keys(expandedNodeFlags)),
    [expandedNodeFlags],
  )

  useImperativeHandle(
    ref,
    () => ({
      scrollToTurn: (turnIndex) => {
        virtuosoRef.current?.scrollToIndex({
          index: firstItemIndexRef.current + turnIndex,
          align: 'start',
          behavior: 'smooth',
        })
      },
    }),
    [],
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

  return (
    <div className="relative min-h-0 flex-1">
      <Virtuoso
        ref={virtuosoRef}
        scrollerRef={setScroller}
        className="conversation-scroll h-full scrollbar-subtle"
        data={projection.turns}
        firstItemIndex={firstItemIndex}
        startReached={
          hasEarlierTurns && onLoadEarlier ? onLoadEarlier : undefined
        }
        computeItemKey={(_, turn) => turn.turnId}
        initialTopMostItemIndex={
          firstItemIndex + Math.max(0, projection.turns.length - 1)
        }
        increaseViewportBy={{ top: 420, bottom: 280 }}
        minOverscanItemCount={{ top: 1, bottom: 1 }}
        atBottomThreshold={48}
        atBottomStateChange={handleAtBottomChange}
        totalListHeightChanged={handleListHeightChange}
        followOutput={followOutput}
        itemContent={(index, turn) => (
          <div data-turn-idx={index - firstItemIndex}>
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
              onRevealNewRoundNodes={revealNewRoundNodes}
              onAttentionAction={onAttentionAction}
              onReplaceRequest={onReplaceRequest}
              onEditResend={onEditResend}
              onOpenChildRun={onOpenChildRun}
            />
          </div>
        )}
        components={{
          Footer: () => <div className="h-7" aria-hidden="true" />,
        }}
      />

      {earlierLoading && (
        // 悬浮在历史水位线上方的载入提示：不进列表布局，
        // 翻页时用户正在读的位置一个像素都不动。
        <div
          className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2"
          role="status"
        >
          <span className="rounded-full border border-border/70 bg-surface-raised/92 px-3 py-1 text-caption text-ink-muted shadow-floating backdrop-blur-md">
            正在载入更早的轮次…
          </span>
        </div>
      )}

      {followMode === 'reviewing' && (
        // 居中 transform 放外层、入场动画放内层：keyframes 会整体覆盖 transform，
        // 合写在同一元素上会导致动画期间横向居中失效并跳变。
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-10 -translate-x-1/2">
          <Button
            variant="secondary"
            size="sm"
            className="pointer-events-auto animate-node-enter rounded-full border-border/80 bg-surface-raised/96 shadow-floating backdrop-blur-md motion-reduce:animate-none"
            onClick={jumpToLatest}
          >
            <ArrowDown aria-hidden="true" className="h-4 w-4" />
            {unseenTurnCount > 0
              ? `${unseenTurnCount} 个新轮次 · 回到最新`
              : '回到最新'}
          </Button>
        </div>
      )}
    </div>
  )
})
