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
import { FlowNode } from './FlowNode'
import { ProcessSummary } from './ProcessSummary'
import { cn } from '@/lib/cn'

/** 已播过摘要行淡入的 roundId 集合（会话级） */
const summaryFadedRoundIds = new Set<string>()

interface RoundSectionProps {
  round: RoundView
  nodesById: Record<string, RenderNode>
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
  const linkedAnswerNode = round.answerNodeId
    ? nodesById[round.answerNodeId]
    : undefined
  const projectedAnswerNode = linkedAnswerNode
    ? undefined
    : Object.values(nodesById).find(
        (node) =>
          node.type === 'answer'
          && node.roundId === round.roundId,
      )
  const answerNode = linkedAnswerNode ?? projectedAnswerNode
  const pendingCount = chainNodes.filter(
    (node) => node.type === 'attention' && node.status === 'waiting',
  ).length
  const processId = `round-process-${round.roundId}`

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

  useLayoutEffect(() => {
    if (processExpanded) onRevealNewNodes(processNodeIds)
  }, [onRevealNewNodes, processExpanded, processNodeKey])

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
          <div className="max-w-[92%] rounded-lg rounded-br-xs bg-surface-muted px-4 py-3 text-body text-ink sm:max-w-[min(86%,42rem)]">
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
              processExpanded
                ? 'grid-rows-[1fr] opacity-100'
                : 'grid-rows-[0fr] opacity-0',
              'motion-reduce:transition-none',
            )}
          >
            <div className="overflow-hidden">
              <div className="pb-1 pl-1">
                {chainNodes.map((node, index) => (
                  <FlowNode
                    key={node.nodeId}
                    node={node}
                    expanded={expandedNodeIds.has(node.nodeId)}
                    onToggle={() => onToggleNode(node.nodeId)}
                    isFirst={index === 0}
                    isLast={index === chainNodes.length - 1}
                    chainLive={round.phase === 'active' && processExpanded}
                    onAttentionAction={onAttentionAction}
                    onOpenChildRun={onOpenChildRun}
                  />
                ))}
              </div>
            </div>
          </div>

          <ProcessSummary
            round={round}
            expanded={processExpanded}
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
  if (!sameExpandedNodeIds(previous.expandedNodeIds, next.expandedNodeIds)) {
    return false
  }
  for (const nodeId of next.round.processNodeIds) {
    if (previous.nodesById[nodeId] !== next.nodesById[nodeId]) return false
  }
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
