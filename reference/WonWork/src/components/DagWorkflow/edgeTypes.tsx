import { memo } from 'react'
import type { EdgeProps } from '@xyflow/react'
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from '@xyflow/react'

function buildSmoothPath(edgeParams: Omit<EdgeProps, 'id' | 'label' | 'data' | 'style' | 'markerEnd' | 'markerStart' | 'selected' | 'interactionWidth' | 'source' | 'target'>) {
  return getSmoothStepPath({
    sourceX: edgeParams.sourceX,
    sourceY: edgeParams.sourceY,
    sourcePosition: edgeParams.sourcePosition,
    targetX: edgeParams.targetX,
    targetY: edgeParams.targetY,
    targetPosition: edgeParams.targetPosition,
    borderRadius: 12,
  })
}

export const ConditionEdge = memo((props: EdgeProps) => {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, style } = props
  const [edgePath, labelX, labelY] = buildSmoothPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: '#f59e0b',
          strokeWidth: 2,
          ...style,
        }}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            }}
            className="absolute px-1.5 py-0.5 text-[10px] font-medium bg-white border border-amber-200 rounded text-amber-700 shadow-sm pointer-events-none"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
})

export const LoopbackEdge = memo((props: EdgeProps) => {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, style } = props
  const [edgePath, labelX, labelY] = buildSmoothPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: '#8b5cf6',
          strokeWidth: 2,
          strokeDasharray: '5,5',
          ...style,
        }}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            }}
            className="absolute px-1.5 py-0.5 text-[10px] font-medium bg-white border border-violet-200 rounded text-violet-700 shadow-sm pointer-events-none"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
})

export const edgeTypes = {
  condition: ConditionEdge,
  loopback: LoopbackEdge,
}
