import type {
  AttentionAction,
  AttentionNode,
  RenderNode,
  RoundView,
} from '@/domain/chat/models'
import { AnswerBlock } from './AnswerBlock'
import { FlowNode } from './FlowNode'
import { ProcessSummary } from './ProcessSummary'
import { cn } from '@/lib/cn'

interface RoundSectionProps {
  round: RoundView
  nodesById: Record<string, RenderNode>
  processExpanded: boolean
  expandedNodeIds: ReadonlySet<string>
  onToggleProcess: () => void
  onToggleNode: (nodeId: string) => void
  onAttentionAction?: (
    node: AttentionNode,
    action: AttentionAction,
  ) => void
}

export function RoundSection({
  round,
  nodesById,
  processExpanded,
  expandedNodeIds,
  onToggleProcess,
  onToggleNode,
  onAttentionAction,
}: RoundSectionProps) {
  const processNodes = round.processNodeIds
    .map((nodeId) => nodesById[nodeId])
    .filter(
      (node): node is RenderNode =>
        Boolean(node) && node?.type !== 'supplement',
    )
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
  const pendingCount = processNodes.filter(
    (node) => node.type === 'attention' && node.status === 'waiting',
  ).length
  const processId = `round-process-${round.roundId}`

  return (
    <section
      className={cn(
        'py-3',
        round.index > 0 && 'mt-2 pt-4',
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

      {processNodes.length > 0 && (
        <>
          <div
            id={processId}
            className={cn(
              'grid transition-[grid-template-rows,opacity] duration-deliberate ease-standard',
              processExpanded
                ? 'grid-rows-[1fr] opacity-100'
                : 'grid-rows-[0fr] opacity-0',
              'motion-reduce:transition-none',
            )}
          >
            <div className="overflow-hidden">
              <div className="pb-1 pl-1">
                {processNodes.map((node) => (
                  <FlowNode
                    key={node.nodeId}
                    node={node}
                    expanded={expandedNodeIds.has(node.nodeId)}
                    onToggle={() => onToggleNode(node.nodeId)}
                    onAttentionAction={onAttentionAction}
                  />
                ))}
              </div>
            </div>
          </div>

          <ProcessSummary
            round={round}
            expanded={processExpanded}
            pendingCount={pendingCount}
            onToggle={onToggleProcess}
          />
        </>
      )}

      {answerNode?.type === 'answer' && <AnswerBlock node={answerNode} />}
    </section>
  )
}
