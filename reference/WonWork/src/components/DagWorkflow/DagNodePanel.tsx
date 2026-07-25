import { DAG_NODE_TYPES, type DagNodeType } from '@/types/dagWorkflow'
import { getNodeTypeLabel, getNodeTypeIcon } from './nodeTypes'
import { cn } from '@/utils'

interface DagNodePanelProps {
  onAdd: (type: DagNodeType) => void
}

export function DagNodePanel({ onAdd }: DagNodePanelProps) {
  return (
    <div className="w-52 bg-white border-r border-surface-200 flex flex-col h-full">
      <div className="px-4 py-3 border-b border-surface-200">
        <h3 className="text-sm font-semibold text-surface-800">节点</h3>
        <p className="text-xs text-surface-500 mt-0.5">点击添加到画布</p>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {DAG_NODE_TYPES.filter((t) => t !== 'start' && t !== 'end').map((type) => (
          <button
            key={type}
            onClick={() => onAdd(type)}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-surface-700 hover:bg-surface-50 transition-colors'
            )}
          >
            <span className="text-surface-500">{getNodeTypeIcon(type)}</span>
            <span className="truncate">{getNodeTypeLabel(type)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
