import { memo } from 'react'
import type { NodeProps } from '@xyflow/react'
import {
  Bot,
  Globe,
  Code,
  GitBranch,
  Hourglass,
  Variable,
  Merge,
  Users,
  Play,
  Square,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Webhook,
  Database,
  FileText,
  Send,
  Puzzle,
  Layers,
} from 'lucide-react'
import { Handle, Position } from '@xyflow/react'
import { useDagWorkflowStore } from '@/stores/dagWorkflowStore'
import type { DagNodeData, DagNodeType } from '@/types/dagWorkflow'
import { cn } from '@/utils'

const NODE_META: Record<
  DagNodeType,
  { label: string; icon: React.ReactNode; color: string; border: string }
> = {
  start: { label: 'Start', icon: <Play size={14} />, color: 'bg-green-50 text-green-600', border: 'border-green-200' },
  end: { label: 'End', icon: <Square size={14} />, color: 'bg-surface-100 text-surface-600', border: 'border-surface-200' },
  llm: { label: 'LLM', icon: <Bot size={14} />, color: 'bg-blue-50 text-blue-600', border: 'border-blue-200' },
  webbridge: { label: 'WebBridge', icon: <Globe size={14} />, color: 'bg-purple-50 text-purple-600', border: 'border-purple-200' },
  javascript: { label: 'JS', icon: <Code size={14} />, color: 'bg-amber-50 text-amber-600', border: 'border-amber-200' },
  condition: { label: 'Condition', icon: <GitBranch size={14} />, color: 'bg-pink-50 text-pink-600', border: 'border-pink-200' },
  loop: { label: 'Loop', icon: <GitBranch size={14} />, color: 'bg-indigo-50 text-indigo-600', border: 'border-indigo-200' },
  delay: { label: 'Delay', icon: <Hourglass size={14} />, color: 'bg-cyan-50 text-cyan-600', border: 'border-cyan-200' },
  variable: { label: 'Variable', icon: <Variable size={14} />, color: 'bg-teal-50 text-teal-600', border: 'border-teal-200' },
  merge: { label: 'Merge', icon: <Merge size={14} />, color: 'bg-surface-50 text-surface-600', border: 'border-surface-200' },
  agent_swarm: { label: 'Agent Swarm', icon: <Users size={14} />, color: 'bg-orange-50 text-orange-600', border: 'border-orange-200' },
  http_request: { label: 'HTTP', icon: <Webhook size={14} />, color: 'bg-indigo-50 text-indigo-600', border: 'border-indigo-200' },
  database_query: { label: 'DB Query', icon: <Database size={14} />, color: 'bg-sky-50 text-sky-600', border: 'border-sky-200' },
  file_operation: { label: 'File', icon: <FileText size={14} />, color: 'bg-lime-50 text-lime-600', border: 'border-lime-200' },
  send_message: { label: 'Message', icon: <Send size={14} />, color: 'bg-rose-50 text-rose-600', border: 'border-rose-200' },
  tool: { label: 'Tool', icon: <Puzzle size={14} />, color: 'bg-violet-50 text-violet-600', border: 'border-violet-200' },
  sub_workflow: { label: 'Sub Workflow', icon: <Layers size={14} />, color: 'bg-emerald-50 text-emerald-600', border: 'border-emerald-200' },
}

function useNodeStatus(nodeId: string): { running: boolean; completed: boolean; failed: boolean } {
  const ctx = useDagWorkflowStore((s) => s.executionContext)
  const status = ctx?.status
  const running = ctx?.currentNodeIds?.includes(nodeId) ?? false
  const completed = ctx?.nodeOutputs?.has(nodeId) ?? false
  const failed = status === 'failed' && !completed && !running
  return { running, completed, failed }
}

const DagNodeBase = memo((props: NodeProps & { type: DagNodeType }) => {
  const { id, data: rawData, selected, type } = props
  const data = rawData as DagNodeData
  const meta = NODE_META[type]
  const { running, completed, failed } = useNodeStatus(id)

  return (
    <div
      className={cn(
        'w-44 rounded-xl border bg-white shadow-sm transition-all',
        meta.border,
        selected && 'ring-2 ring-primary-500 border-primary-500',
        running && 'ring-2 ring-blue-400 border-blue-400',
        completed && 'ring-2 ring-green-400 border-green-400',
        failed && 'ring-2 ring-red-400 border-red-400'
      )}
    >
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-surface-400" />
      <div className={cn('flex items-center gap-2 px-3 py-2 rounded-t-xl', meta.color)}>
        <span className="p-1 bg-white/70 rounded">{meta.icon}</span>
        <span className="text-xs font-semibold truncate flex-1">{meta.label}</span>
        {running && <Loader2 size={12} className="animate-spin" />}
        {completed && <CheckCircle2 size={12} />}
        {failed && <AlertCircle size={12} />}
      </div>
      <div className="px-3 py-2">
        <p className="text-xs font-medium text-surface-800 truncate">{data.label}</p>
        {data.description && <p className="text-[10px] text-surface-500 truncate">{data.description}</p>}
      </div>
      <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-surface-400" />
    </div>
  )
})

export const nodeTypes = {
  start: (props: NodeProps) => <DagNodeBase {...props} type="start" />,
  end: (props: NodeProps) => <DagNodeBase {...props} type="end" />,
  llm: (props: NodeProps) => <DagNodeBase {...props} type="llm" />,
  webbridge: (props: NodeProps) => <DagNodeBase {...props} type="webbridge" />,
  javascript: (props: NodeProps) => <DagNodeBase {...props} type="javascript" />,
  condition: (props: NodeProps) => <DagNodeBase {...props} type="condition" />,
  loop: (props: NodeProps) => <DagNodeBase {...props} type="loop" />,
  delay: (props: NodeProps) => <DagNodeBase {...props} type="delay" />,
  variable: (props: NodeProps) => <DagNodeBase {...props} type="variable" />,
  merge: (props: NodeProps) => <DagNodeBase {...props} type="merge" />,
  agent_swarm: (props: NodeProps) => <DagNodeBase {...props} type="agent_swarm" />,
  http_request: (props: NodeProps) => <DagNodeBase {...props} type="http_request" />,
  database_query: (props: NodeProps) => <DagNodeBase {...props} type="database_query" />,
  file_operation: (props: NodeProps) => <DagNodeBase {...props} type="file_operation" />,
  send_message: (props: NodeProps) => <DagNodeBase {...props} type="send_message" />,
  tool: (props: NodeProps) => <DagNodeBase {...props} type="tool" />,
}

export function getNodeTypeLabel(type: DagNodeType): string {
  return NODE_META[type]?.label || type
}

export function getNodeTypeIcon(type: DagNodeType): React.ReactNode {
  return NODE_META[type]?.icon
}
