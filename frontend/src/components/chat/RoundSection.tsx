import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ArtifactNode,
  AttentionAction,
  AttentionNode,
  RenderNode,
  RoundView,
} from '@/domain/chat/models'
import { AnswerBlock } from './AnswerBlock'
import { ArtifactZone } from './ArtifactZone'
import { FlowNode, isFlowNodeSettled } from './FlowNode'
import { ProcessSummary } from './ProcessSummary'
import { answerNodeForRound } from '@/domain/chat/selectors'
import { cn } from '@/lib/cn'
import { useViewStateStore } from '@/stores/viewStateStore'
import { USER_BUBBLE_WIDTH_CLASS } from '@/domain/chat/bubbleStyle'

/** 已播过摘要行淡入的 roundId 集合（会话级） */
const summaryFadedRoundIds = new Set<string>()

interface RoundSectionProps {
  round: RoundView
  nodesById: Record<string, RenderNode>
  answerNodeIdsByRoundId: ReadonlyMap<string, string>
  processExpanded: boolean
  expandedNodeIds: ReadonlySet<string>
  onToggleProcess: (nodeIds: string[]) => void
  onToggleNode: (nodeId: string) => void
  onRevealNewNodes: (nodeIds: string[]) => void
  onAttentionAction?: (
    node: AttentionNode,
    action: AttentionAction,
  ) => void
  onOpenChildRun?: (runId: string) => void
}

export const RoundSection = memo(function RoundSection({
  round,
  nodesById,
  answerNodeIdsByRoundId,
  processExpanded,
  expandedNodeIds,
  onToggleProcess,
  onToggleNode,
  onRevealNewNodes,
  onAttentionAction,
  onOpenChildRun,
}: RoundSectionProps) {
  const processNodes = useMemo(
    () => round.processNodeIds
      .map((nodeId) => nodesById[nodeId])
      .filter(
        (node): node is RenderNode =>
          Boolean(node) && node?.type !== 'supplement',
      ),
    [nodesById, round.processNodeIds],
  )
  // artifact 节点是"过程的结果"而非过程步骤：滤出链条，提升为始终可见的产物区
  // （WonWork wf-artifact-zone 的等价物），链内不再重复渲染。
  const chainNodes = useMemo(
    () => processNodes.filter((node) => node.type !== 'artifact'),
    [processNodes],
  )
  const artifactNodes = useMemo(
    () =>
      processNodes.filter(
        (node): node is ArtifactNode => node.type === 'artifact',
      ),
    [processNodes],
  )
  const processNodeIds = useMemo(
    () => chainNodes.map((node) => node.nodeId),
    [chainNodes],
  )
  const processNodeKey = processNodeIds.join('\u001f')
  const supplementNodes = round.processNodeIds
    .map((nodeId) => nodesById[nodeId])
    .filter(
      (node): node is Extract<RenderNode, { type: 'supplement' }> =>
        node?.type === 'supplement',
    )
  const answerNode = answerNodeForRound(
    round,
    nodesById,
    answerNodeIdsByRoundId,
  )
  const pendingCount = chainNodes.filter(
    (node) => node.type === 'attention' && node.status === 'waiting',
  ).length
  const processId = `round-process-${round.roundId}`
  const roundActive = round.phase === 'active'
  // 活跃轮次：过程链始终展开，实时过程对流式阅读可见；
  // 结算瞬间播种一次完整展开（完成时全链条打开），此后折叠与否由用户主导。
  const processVisible = roundActive || processExpanded

  const seedExpandedRound = useViewStateStore(
    (state) => state.seedExpandedRound,
  )

  // 摘要行入场动画：只在 active→非 active 的跃迁瞬间触发一次，
  // 水合历史时初值即 settled，不会误闪；会话级集合防重放。
  const prevPhaseRef = useRef(round.phase)
  const [summaryFade, setSummaryFade] = useState(false)
  useEffect(() => {
    const prev = prevPhaseRef.current
    prevPhaseRef.current = round.phase
    if (prev !== 'active' || round.phase === 'active') return
    if (!summaryFadedRoundIds.has(round.roundId)) {
      summaryFadedRoundIds.add(round.roundId)
      setSummaryFade(true)
    }
  }, [round.phase, round.roundId])

  // 结算瞬间：一次性把整条过程链播种为展开。
  // 用户随后手动折叠优先（seed 只在 initializedNodeIds 未含 round 标记时生效一次）。
  useEffect(() => {
    if (roundActive) return
    if (chainNodes.length === 0) return
    seedExpandedRound(round.roundId, processNodeIds)
  }, [roundActive, chainNodes.length, round.roundId, processNodeIds, seedExpandedRound])

  useLayoutEffect(() => {
    if (processVisible) onRevealNewNodes(processNodeIds)
  }, [onRevealNewNodes, processVisible, processNodeKey])

  return (
    <section
      className={cn(
        'py-2',
        round.index > 0 && 'mt-1 pt-3',
      )}
      aria-label={`第 ${round.index + 1} 轮`}
    >
      {supplementNodes.map((node) => (
        <div key={node.nodeId} className="mb-3 flex justify-end">
          <div
            className={cn(
              'whitespace-pre-wrap break-words rounded-lg rounded-br-xs bg-surface-muted px-4 py-3 text-body text-ink',
              USER_BUBBLE_WIDTH_CLASS,
            )}
          >
            {node.text}
          </div>
        </div>
      ))}

      {chainNodes.length > 0 && (
        <>
          <div
            id={processId}
            className={cn(
              'grid transition-[grid-template-rows,opacity] duration-fold ease-flow',
              'hover:!opacity-100',
              processVisible
                ? 'grid-rows-[1fr] opacity-100'
                : 'grid-rows-[0fr] opacity-0',
              'motion-reduce:transition-none',
            )}
          >
            <div className="overflow-hidden">
              <div className="pb-1">
                {chainNodes.map((node, index) => (
                  <FlowNode
                    key={node.nodeId}
                    node={node}
                    expanded={expandedNodeIds.has(node.nodeId)}
                    onToggle={() => onToggleNode(node.nodeId)}
                    isFirst={index === 0}
                    isLast={index === chainNodes.length - 1}
                    segFlowed={index > 0 && isFlowNodeSettled(chainNodes[index - 1])}
                    chainLive={roundActive && processVisible}
                    onAttentionAction={onAttentionAction}
                    onOpenChildRun={onOpenChildRun}
                  />
                ))}
              </div>
            </div>
          </div>

          <ProcessSummary
            round={round}
            expanded={processVisible}
            pendingCount={pendingCount}
            fadeIn={summaryFade}
            onToggle={() => onToggleProcess(processNodeIds)}
          />
        </>
      )}

      {answerNode?.type === 'answer' && <AnswerBlock node={answerNode} />}

      <ArtifactZone
        nodes={artifactNodes}
        live={round.phase === 'active'}
      />
    </section>
  )
}, (previous, next) => {
  if (previous.round !== next.round) return false
  if (previous.processExpanded !== next.processExpanded) return false
  if (previous.answerNodeIdsByRoundId !== next.answerNodeIdsByRoundId) {
    return false
  }
  if (!sameExpandedNodeIds(previous.expandedNodeIds, next.expandedNodeIds)) {
    return false
  }
  for (const nodeId of next.round.processNodeIds) {
    if (previous.nodesById[nodeId] !== next.nodesById[nodeId]) return false
  }
  // answer 节点不在 processNodeIds（后端按 node_type <> 'answer' 投影），
  // 必须单独比较：流式期间每次 delta 都是新节点对象，引用不同即放行渲染，
  // 否则 AnswerBlock 拿不到增量，completed 时一次性崩出全文。
  const previousAnswer = answerNodeForRound(
    previous.round,
    previous.nodesById,
    previous.answerNodeIdsByRoundId,
  )
  const nextAnswer = answerNodeForRound(
    next.round,
    next.nodesById,
    next.answerNodeIdsByRoundId,
  )
  if (previousAnswer !== nextAnswer) return false
  return (
    previous.onToggleProcess === next.onToggleProcess
    && previous.onToggleNode === next.onToggleNode
    && previous.onRevealNewNodes === next.onRevealNewNodes
    && previous.onAttentionAction === next.onAttentionAction
    && previous.onOpenChildRun === next.onOpenChildRun
  )
})

function sameExpandedNodeIds(
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
