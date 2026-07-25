/**
 * Workflow Execution Agent Store
 * 管理 DAG 工作流在对话中的 Agent 执行状态、修复历史、进度同步
 */

import { create } from 'zustand'
import type {
  DagWorkflow,
  DagNode,
  DagExecutionContext,
  DagExecutionLog,
} from '@/types/dagWorkflow'
import type { DagExecutionResumeContext } from '@/stores/dagExecutionEngine'

export type AgentExecutionStatus =
  | 'idle'
  | 'running'
  | 'repairing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type AgentNodeStatus = 'pending' | 'running' | 'completed' | 'error'

export interface RepairRecord {
  nodeId: string
  action: 'retry' | 'mutate' | 'skip' | 'escalate'
  reason: string
  config?: Partial<Record<string, unknown>>
  appliedAt: number
}

export interface NodeErrorRecord {
  error: Error
  attempts: number
}

export interface AgentProgressSnapshot {
  status: AgentExecutionStatus
  currentNodeId: string | null
  nodeStatuses: Record<string, AgentNodeStatus>
  nodeErrors: Record<string, { message: string; attempts: number }>
  repairHistory: RepairRecord[]
  executionLog: string[]
}

interface WorkflowExecutionAgentState {
  status: AgentExecutionStatus
  currentWorkflow: DagWorkflow | null
  currentNodeId: string | null
  nodeStatuses: Map<string, AgentNodeStatus>
  nodeErrors: Map<string, NodeErrorRecord>
  repairHistory: RepairRecord[]
  executionLog: string[]
  resumeContext: DagExecutionResumeContext | null
  abortController: AbortController | null

  isPaused: boolean
  isCancelled: boolean

  startExecution: (workflow: DagWorkflow, inputs: Record<string, unknown>) => void
  pauseExecution: () => void
  resumeExecution: () => void
  cancelExecution: () => void

  setNodeStatus: (nodeId: string, status: AgentNodeStatus) => void
  setCurrentNodeId: (nodeId: string | null) => void
  recordNodeError: (nodeId: string, error: Error) => void
  appendLog: (message: string) => void
  appendDagLog: (log: DagExecutionLog) => void
  recordRepair: (record: RepairRecord) => void
  setResumeContext: (ctx: DagExecutionResumeContext | null) => void

  getProgressSnapshot: () => AgentProgressSnapshot
  getRepairMutations: () => RepairRecord[]
  reset: () => void
}

const MAX_LOG_LINES = 200

function truncateLog(logs: string[]): string[] {
  if (logs.length <= MAX_LOG_LINES) return logs
  return logs.slice(logs.length - MAX_LOG_LINES)
}

export const useWorkflowExecutionAgentStore = create<WorkflowExecutionAgentState>()(
  (set, get) => ({
    status: 'idle',
    currentWorkflow: null,
    currentNodeId: null,
    nodeStatuses: new Map(),
    nodeErrors: new Map(),
    repairHistory: [],
    executionLog: [],
    resumeContext: null,
    abortController: null,
    isPaused: false,
    isCancelled: false,

    startExecution: (workflow, inputs) => {
      const abortController = new AbortController()
      const initialStatuses = new Map<string, AgentNodeStatus>()
      workflow.nodes.forEach((n) => initialStatuses.set(n.id, 'pending'))

      set({
        status: 'running',
        currentWorkflow: workflow,
        currentNodeId: null,
        nodeStatuses: initialStatuses,
        nodeErrors: new Map(),
        repairHistory: [],
        executionLog: [
          `开始执行工作流「${workflow.name}」`,
          `输入参数：${JSON.stringify(inputs)}`,
        ],
        resumeContext: null,
        abortController,
        isPaused: false,
        isCancelled: false,
      })
    },

    pauseExecution: () => {
      set({ isPaused: true, status: 'running' })
    },

    resumeExecution: () => {
      set({ isPaused: false, status: 'running' })
    },

    cancelExecution: () => {
      const controller = get().abortController
      if (controller && !controller.signal.aborted) {
        controller.abort()
      }
      set((s) => ({
        isCancelled: true,
        status: s.status === 'running' || s.status === 'repairing' ? 'cancelled' : s.status,
        executionLog: truncateLog([...s.executionLog, '用户取消执行']),
      }))
    },

    setNodeStatus: (nodeId, status) => {
      set((s) => {
        const next = new Map(s.nodeStatuses)
        next.set(nodeId, status)
        return { nodeStatuses: next }
      })
    },

    setCurrentNodeId: (nodeId) => {
      set({ currentNodeId: nodeId })
    },

    recordNodeError: (nodeId, error) => {
      set((s) => {
        const next = new Map(s.nodeErrors)
        const existing = next.get(nodeId)
        next.set(nodeId, {
          error,
          attempts: (existing?.attempts || 0) + 1,
        })
        return { nodeErrors: next }
      })
    },

    appendLog: (message) => {
      set((s) => ({
        executionLog: truncateLog([...s.executionLog, message]),
      }))
    },

    appendDagLog: (log) => {
      const prefix = log.nodeId ? `[${log.nodeId}] ` : ''
      const message = `${prefix}[${log.level}] ${log.message}`
      get().appendLog(message)
    },

    recordRepair: (record) => {
      set((s) => ({
        repairHistory: [...s.repairHistory, record],
        status: 'repairing',
      }))
    },

    setResumeContext: (ctx) => {
      set({ resumeContext: ctx })
    },

    getProgressSnapshot: () => {
      const s = get()
      const nodeStatuses: Record<string, AgentNodeStatus> = {}
      s.nodeStatuses.forEach((status, id) => {
        nodeStatuses[id] = status
      })
      const nodeErrors: Record<string, { message: string; attempts: number }> = {}
      s.nodeErrors.forEach((record, id) => {
        nodeErrors[id] = { message: record.error.message, attempts: record.attempts }
      })
      return {
        status: s.status,
        currentNodeId: s.currentNodeId,
        nodeStatuses,
        nodeErrors,
        repairHistory: s.repairHistory,
        executionLog: s.executionLog,
      }
    },

    getRepairMutations: () => {
      return get().repairHistory.filter((r) => r.action === 'mutate')
    },

    reset: () => {
      const controller = get().abortController
      if (controller && !controller.signal.aborted) {
        controller.abort()
      }
      set({
        status: 'idle',
        currentWorkflow: null,
        currentNodeId: null,
        nodeStatuses: new Map(),
        nodeErrors: new Map(),
        repairHistory: [],
        executionLog: [],
        resumeContext: null,
        abortController: null,
        isPaused: false,
        isCancelled: false,
      })
    },
  })
)

export function getNodeLabel(node: DagNode): string {
  return node.data.label || node.id
}
