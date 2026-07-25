import { memo, useState, useCallback, useMemo } from 'react'
import type { RenderNode } from '@/types/chat'
import { FlowNode, type TurnPhase } from './FlowNode'

interface FlowGroupProps {
  groupId: string
  groupType: 'parallel' | 'retry'
  nodes: RenderNode[]
  /** Turn 阶段（透传给子节点） */
  turnPhase: TurnPhase
  /** 组第一个节点的来路段是否已"流过" */
  segFlowedFirst: boolean
  /** 该组是否为整个脊柱最后一个可视项 */
  isLastInFlow?: boolean
  isOverridden: (id: string) => boolean
  onToggle: (nodeId: string) => void
  onClarifyPick?: (nodeId: string, value: string) => void
  onTakeover?: (nodeId: string) => void
  onSkipAttention?: (nodeId: string) => void
  onApprove?: (toolCallId: string) => void
  onReject?: (toolCallId: string) => void
  promotedToolCallIds?: Set<string>
}

/**
 * 组合容器：将共享 groupId 的节点归入 ParallelGroup 或 RetryGroup。
 * 匹配 prototype-v3 的 .group 设计：
 * - 可折叠组头（图标 + 标题 + 状态）
 * - 组内首个节点继承组外 segFlowed，内部节点间自行计算
 * - 折叠/展开动画（grid 0fr/1fr）
 */
export const FlowGroup = memo(function FlowGroup({
  groupId: _groupId,
  groupType,
  nodes,
  turnPhase,
  segFlowedFirst,
  isLastInFlow,
  isOverridden,
  onToggle,
  onClarifyPick,
  onTakeover,
  onSkipAttention,
  onApprove,
  onReject,
  promotedToolCallIds,
}: FlowGroupProps) {
  const [folded, setFolded] = useState(false)

  const handleToggleFold = useCallback(() => {
    setFolded((v) => !v)
  }, [])

  const doneCount = nodes.filter(
    (n) => n.type === 'tool' && (n.status === 'done' || n.status === 'error' || n.status === 'cancelled')
  ).length
  const errorCount = nodes.filter((n) => n.type === 'tool' && n.status === 'error').length
  const totalCount = nodes.filter((n) => n.type === 'tool').length

  const icon = groupType === 'parallel' ? '⚡' : '🔁'
  const title = groupType === 'parallel'
    ? `并行调用 ${totalCount} 个工具`
    : `重试组 · ${nodes[0] && nodes[0].type === 'tool' ? (nodes[0] as import('@/types/chat').ToolNode).toolName : '工具'}`

  let statusText = ''
  if (doneCount === totalCount) {
    statusText = errorCount > 0
      ? `${totalCount} / ${totalCount} 完成 · ${errorCount} 处失败`
      : `${totalCount} / ${totalCount} 完成`
  } else {
    statusText = `${doneCount} / ${totalCount} 完成`
  }

  const statusCls = errorCount > 0 ? 'wf-g-status err' : doneCount === totalCount ? 'wf-g-status ok' : 'wf-g-status'

  // 组内节点各自的 segFlowed：首节点继承组外，后续节点看前一个是否完成
  const nodeStates = useMemo(() => {
    return nodes.map((node, i) => {
      if (i === 0) return { node, segFlowed: segFlowedFirst }
      const prev = nodes[i - 1]
      const prevDone = prev.type === 'tool'
        ? (prev.status === 'done' || prev.status === 'error' || prev.status === 'cancelled')
        : prev.type === 'thinking' ? prev.status === 'done' : true
      return { node, segFlowed: prevDone }
    })
  }, [nodes, segFlowedFirst])

  return (
    <div className={`wf-group ${folded ? 'folded' : ''}`}>
      <button
        className="wf-group-head"
        aria-expanded={!folded}
        onClick={handleToggleFold}
      >
        <span>{icon}</span>
        <span style={{ fontWeight: 600 }}>{title}</span>
        <span className={statusCls}>{statusText}</span>
      </button>
      <div className="wf-group-body">
        <div className="wf-group-body-inner">
          {nodeStates.map(({ node, segFlowed }, idx) => (
            <FlowNode
              key={node.id}
              node={node}
              turnPhase={turnPhase}
              segFlowed={segFlowed}
              isOverridden={isOverridden(node.id)}
              isLastInFlow={isLastInFlow && idx === nodeStates.length - 1}
              onToggle={onToggle}
              onClarifyPick={onClarifyPick}
              onTakeover={onTakeover}
              onSkipAttention={onSkipAttention}
              onApprove={onApprove}
              onReject={onReject}
              promotedToolCallIds={promotedToolCallIds}
            />
          ))}
        </div>
      </div>
    </div>
  )
})
