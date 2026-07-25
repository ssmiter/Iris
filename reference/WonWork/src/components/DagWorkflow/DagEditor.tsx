import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useDagWorkflowStore } from '@/stores/dagWorkflowStore'
import type { DagNode, DagEdge, DagNodeData, DagNodeType, DagWorkflow } from '@/types/dagWorkflow'
import { normalizeInputSchema } from '@/types/dagWorkflow'
import { nodeTypes } from './nodeTypes'
import { edgeTypes } from './edgeTypes'
import { DagNodePanel } from './DagNodePanel'
import { DagPropertyPanel } from './DagPropertyPanel'
import { DagExecutionMonitor } from './DagExecutionMonitor'
import { DagWorkflowInputDialog } from './DagWorkflowInputDialog'
import { setRecentValue } from '@/utils/workflowInputCache'
import { refineDagWithAi, validateGeneratedWorkflow } from '@/utils/naturalLanguageToDag'
import { useChatStore } from '@/stores/chatStore'
import { Play, Square, Save, LayoutTemplate, Trash2, GitBranch, Pause, RotateCcw, Sparkles, AlertCircle, Loader2, Upload } from 'lucide-react'
import { useWebBridgeStore } from '@/stores/webbridgeStore'

function toRfNodes(nodes: DagNode[]): Node[] {
  return nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position,
    data: n.data,
  }))
}

function toRfEdges(edges: DagEdge[]): Edge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    type: e.type === 'condition' || e.type === 'loopback' ? e.type : 'default',
    data: { dagType: e.type || 'default' },
  }))
}

function fromRfNodes(nodes: Node[]): DagNode[] {
  return nodes.map((n) => ({
    id: n.id,
    type: n.type as DagNode['type'],
    position: n.position,
    data: n.data as DagNodeData,
  }))
}

function fromRfEdges(edges: Edge[]): DagEdge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: typeof e.label === 'string' ? e.label : undefined,
    type: (e.data as { dagType?: DagEdge['type'] } | undefined)?.dagType || 'default',
  }))
}

interface DagEditorProps {
  workflowId: string
  onNavigate?: (view: string) => void
}

export function DagEditor({ workflowId, onNavigate }: DagEditorProps) {
  const { t } = useTranslation()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null)

  const {
    getWorkflowById,
    updateWorkflow,
    runWorkflow,
    stopWorkflow,
    pauseWorkflow,
    resumeWorkflow,
    retryWorkflow,
    isExecuting,
    executionContext,
    autoLayout,
    exportToWebBridge,
  } = useDagWorkflowStore()

  const runDagWorkflowAsAgent = useChatStore((s) => s.runDagWorkflowAsAgent)

  const workflow = getWorkflowById(workflowId)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [isRefining, setIsRefining] = useState(false)
  const [refineError, setRefineError] = useState<string | null>(null)
  const [showInputDialog, setShowInputDialog] = useState(false)

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  useEffect(() => {
    if (!workflow) return
    setNodes(toRfNodes(workflow.nodes))
    setEdges(toRfEdges(workflow.edges))
  }, [workflow?.id])

  const save = useCallback(() => {
    if (!workflow) return
    updateWorkflow(workflow.id, {
      nodes: fromRfNodes(nodes),
      edges: fromRfEdges(edges),
    })
  }, [workflow, nodes, edges, updateWorkflow])

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      if (connection.source === connection.target) return
      const id = `e-${connection.source}-${connection.target}`

      setEdges((eds) => {
        if (eds.some((e) => e.source === connection.source && e.target === connection.target)) return eds

        const sourceNode = nodes.find((n) => n.id === connection.source)
        let edgeType: 'default' | 'condition' | 'loopback' = 'default'
        let label: string | undefined

        if (sourceNode?.type === 'condition') {
          edgeType = 'condition'
          const existingConditionEdges = eds.filter(
            (e) => e.source === connection.source && e.data?.dagType === 'condition'
          )
          label = existingConditionEdges.length === 0 ? 'true' : 'false'
        } else if (sourceNode?.type === 'loop') {
          const alreadyConnected = eds.some((e) => e.source === connection.source)
          edgeType = alreadyConnected ? 'loopback' : 'default'
        }

        return [
          ...eds,
          {
            id,
            source: connection.source,
            target: connection.target,
            type: edgeType,
            label,
            data: { dagType: edgeType },
          },
        ]
      })
    },
    [setEdges, nodes]
  )

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null

  const handleNodeDataChange = useCallback(
    (data: DagNodeData) => {
      if (!selectedNodeId) return
      setNodes((nds) =>
        nds.map((n) =>
          n.id === selectedNodeId ? { ...n, data } : n
        )
      )
    },
    [selectedNodeId, setNodes]
  )

  const handleAddNode = useCallback(
    (type: DagNodeType) => {
      const center = { x: 300, y: 200 }
      if (wrapperRef.current && rfInstance) {
        const rect = wrapperRef.current.getBoundingClientRect()
        const pos = rfInstance.screenToFlowPosition({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        })
        center.x = pos.x
        center.y = pos.y
      }

      const id = `${type}-${Date.now().toString(36)}`
      let data: DagNodeData
      switch (type) {
        case 'llm':
          data = { label: 'LLM', llm: { prompt: '' } }
          break
        case 'webbridge':
          data = { label: 'WebBridge', webbridge: { actions: [] } }
          break
        case 'javascript':
          data = { label: 'JS', javascript: { code: '' } }
          break
        case 'condition':
          data = { label: 'Condition', condition: { conditionExpression: '' } }
          break
        case 'loop':
          data = { label: 'Loop', loop: { loopVariable: 'item', loopOver: '', maxIterations: 100 } }
          break
        case 'delay':
          data = { label: 'Delay', delay: { delayMs: 1000 } }
          break
        case 'variable':
          data = { label: 'Variable', variable: { variableName: '', variableValue: '' } }
          break
        case 'merge':
          data = { label: 'Merge' }
          break
        case 'agent_swarm':
          data = { label: 'Agent Swarm', agentSwarm: { taskDescription: '' } }
          break
        case 'http_request':
          data = { label: 'HTTP Request', httpRequest: { url: '', method: 'GET', headers: '{}', body: '', timeout: 30000 } }
          break
        case 'database_query':
          data = { label: 'DB Query', databaseQuery: { connection: '', query: '', parameters: '{}' } }
          break
        case 'file_operation':
          data = { label: 'File Operation', fileOperation: { action: 'read', path: '', content: '' } }
          break
        case 'send_message':
          data = { label: 'Send Message', sendMessage: { channel: 'log', title: '', content: '' } }
          break
        case 'tool':
          data = { label: 'Tool', tool: { toolName: '', args: '{}' } }
          break
        default:
          data = { label: type }
      }

      setNodes((nds) => [
        ...nds,
        {
          id,
          type,
          position: { x: center.x, y: center.y },
          data,
        },
      ])
      setSelectedNodeId(id)
    },
    [rfInstance, setNodes]
  )

  const handleDeleteNode = useCallback(() => {
    if (!selectedNodeId) return
    setNodes((nds) => nds.filter((n) => n.id !== selectedNodeId))
    setEdges((eds) => eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId))
    setSelectedNodeId(null)
  }, [selectedNodeId, setNodes, setEdges])

  const handleAutoLayout = useCallback(async () => {
    if (!workflow) return
    const updated = await autoLayout(workflow.id)
    if (updated) {
      setNodes(toRfNodes(updated.nodes))
      setEdges(toRfEdges(updated.edges))
    }
  }, [workflow, autoLayout, setNodes, setEdges])

  const handleRefine = useCallback(async () => {
    if (!workflow || isRefining) return
    setIsRefining(true)
    setRefineError(null)
    try {
      const partialWorkflow: Partial<DagWorkflow> = {
        ...workflow,
        nodes: fromRfNodes(nodes),
        edges: fromRfEdges(edges),
      }
      const { issues } = validateGeneratedWorkflow(
        partialWorkflow as Omit<DagWorkflow, 'id' | 'createdAt' | 'updatedAt'>
      )
      const refined = await refineDagWithAi(partialWorkflow, {
        issues,
        originalDescription: workflow.description,
      })
      const updated = await updateWorkflow(workflow.id, {
        name: refined.name,
        description: refined.description,
        nodes: refined.nodes,
        edges: refined.edges,
        inputSchema: refined.inputSchema,
        outputMapping: refined.outputMapping,
      })
      if (updated) {
        const laidOut = await autoLayout(workflow.id)
        if (laidOut) {
          setNodes(toRfNodes(laidOut.nodes))
          setEdges(toRfEdges(laidOut.edges))
        } else {
          setNodes(toRfNodes(updated.nodes))
          setEdges(toRfEdges(updated.edges))
        }
      }
    } catch (err) {
      setRefineError(err instanceof Error ? err.message : 'AI 完善失败')
    } finally {
      setIsRefining(false)
    }
  }, [workflow, nodes, edges, isRefining, updateWorkflow, autoLayout, setNodes, setEdges])

  const handleRun = useCallback(async (inputs?: Record<string, unknown>) => {
    if (!workflow) return
    save()
    onNavigate?.('chat')
    await runDagWorkflowAsAgent(workflow, inputs ?? {})
  }, [workflow, save, runDagWorkflowAsAgent, onNavigate])

  const handleRunClick = useCallback(() => {
    if (!workflow) return
    const schema = normalizeInputSchema(workflow.inputSchema)
    if (schema.length > 0) {
      setShowInputDialog(true)
    } else {
      handleRun()
    }
  }, [workflow, handleRun])

  const handleExportToWebBridge = useCallback(() => {
    if (!workflow) return
    save()
    const exported = exportToWebBridge(workflow.id)
    if (!exported) {
      alert('当前 DAG 无法导出为 WebBridge 工作流（仅支持线性链或简单条件分支）')
      return
    }
    const { createWorkflow, getWorkflowByName } = useWebBridgeStore.getState()
    const existing = getWorkflowByName(exported.name)
    if (existing) {
      const confirmed = confirm(`已存在同名 WebBridge 工作流「${exported.name}」，是否创建副本？`)
      if (!confirmed) return
    }
    createWorkflow(exported)
    alert(`已导出 WebBridge 工作流「${exported.name}」`)
  }, [workflow, save, exportToWebBridge])

  if (!workflow) {
    return (
      <div className="flex-1 flex items-center justify-center text-surface-500">
        工作流不存在
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 bg-white border-b border-surface-200">
        <div className="flex items-center gap-2">
          <GitBranch size={18} className="text-primary-500" />
          <span className="text-sm font-semibold text-surface-800 truncate max-w-[16rem]">{workflow.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={save}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-surface-100 hover:bg-surface-200 text-surface-700 rounded-lg transition-colors"
          >
            <Save size={14} />
            {t('visualWorkflow.editor.save')}
          </button>
          <button
            onClick={handleAutoLayout}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-surface-100 hover:bg-surface-200 text-surface-700 rounded-lg transition-colors"
          >
            <LayoutTemplate size={14} />
            {t('visualWorkflow.editor.autoLayout')}
          </button>
          <button
            onClick={handleRefine}
            disabled={isRefining}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-purple-50 hover:bg-purple-100 text-purple-700 rounded-lg transition-colors disabled:opacity-50"
          >
            {isRefining ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Sparkles size={14} />
            )}
            AI 完善
          </button>
          <button
            onClick={handleExportToWebBridge}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-surface-100 hover:bg-surface-200 text-surface-700 rounded-lg transition-colors"
          >
            <Upload size={14} />
            导出 WebBridge
          </button>
          {selectedNodeId && (
            <button
              onClick={handleDeleteNode}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-50 hover:bg-red-100 text-red-600 rounded-lg transition-colors"
            >
              <Trash2 size={14} />
              {t('visualWorkflow.editor.deleteNode')}
            </button>
          )}
          {isExecuting ? (
            <button
              onClick={pauseWorkflow}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-amber-500 hover:bg-amber-600 text-white rounded-lg transition-colors"
            >
              <Pause size={14} />
              {t('visualWorkflow.editor.pause')}
            </button>
          ) : executionContext?.status === 'paused' ? (
            <button
              onClick={resumeWorkflow}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary-500 hover:bg-primary-600 text-white rounded-lg transition-colors"
            >
              <Play size={14} />
              {t('visualWorkflow.editor.resume')}
            </button>
          ) : (
            <button
              onClick={handleRunClick}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary-500 hover:bg-primary-600 text-white rounded-lg transition-colors"
            >
              <Play size={14} />
              {t('visualWorkflow.editor.run')}
            </button>
          )}
          {executionContext?.status === 'paused' && (
            <button
              onClick={stopWorkflow}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors"
            >
              <Square size={14} />
              {t('visualWorkflow.editor.stop')}
            </button>
          )}
          {executionContext?.status === 'failed' && (
            <button
              onClick={() => retryWorkflow()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-orange-500 hover:bg-orange-600 text-white rounded-lg transition-colors"
            >
              <RotateCcw size={14} />
              {t('visualWorkflow.editor.retry')}
            </button>
          )}
        </div>
      </div>

      {refineError && (
        <div className="flex-none px-4 py-2 bg-red-50 border-b border-red-200 flex items-center gap-2 text-xs text-red-700">
          <AlertCircle size={14} />
          <span className="flex-1 truncate">{refineError}</span>
          <button
            onClick={() => setRefineError(null)}
            className="text-red-600 hover:text-red-800 font-medium"
          >
            知道了
          </button>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        <DagNodePanel onAdd={handleAddNode} />

        <div ref={wrapperRef} className="flex-1 relative">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            onInit={setRfInstance}
            fitView
            snapToGrid
            snapGrid={[10, 10]}
            connectionLineStyle={{ stroke: '#6366f1', strokeWidth: 2 }}
            defaultEdgeOptions={{ type: 'smoothstep', style: { stroke: '#64748b', strokeWidth: 2 } }}
            deleteKeyCode="Delete"
          >
            <Background color="#cbd5e1" gap={20} />
            <Controls />
          </ReactFlow>
        </div>

        <DagPropertyPanel
          node={selectedNode ? fromRfNodes([selectedNode])[0] : null}
          workflow={workflow}
          onChange={handleNodeDataChange}
        />
      </div>

      <div className="h-48 border-t border-surface-200">
        <DagExecutionMonitor />
      </div>

      {showInputDialog && workflow && (
        <DagWorkflowInputDialog
          workflow={workflow}
          onConfirm={(inputs) => {
            setShowInputDialog(false)
            for (const [key, value] of Object.entries(inputs)) {
              setRecentValue(workflow.id, key, value)
            }
            handleRun(inputs)
          }}
          onCancel={() => setShowInputDialog(false)}
        />
      )}
    </div>
  )
}
