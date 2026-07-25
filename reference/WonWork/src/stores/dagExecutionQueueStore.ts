import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { DagExecutionContext, DagExecutionStatus } from '@/types/dagWorkflow'

export interface DagExecutionRun {
  id: string
  workflowId: string
  workflowName: string
  status: DagExecutionStatus
  inputs: Record<string, unknown>
  variables: Record<string, unknown>
  nodeOutputs: Record<string, unknown>
  logs: DagExecutionContext['logs']
  completedNodeIds: string[]
  pendingNodeIds: string[]
  failedNodeId?: string
  error?: string
  startTime: number
  endTime?: number
  updatedAt: number
}

interface DagExecutionQueueState {
  runs: DagExecutionRun[]
  activeRunId: string | null
  isPaused: boolean

  enqueue: (workflowId: string, workflowName: string, inputs: Record<string, unknown>) => DagExecutionRun
  updateRun: (id: string, updates: Partial<DagExecutionRun>) => void
  setActiveRun: (id: string | null) => void
  pause: () => void
  resume: () => void
  cancel: (id: string) => void
  retry: (id: string, fromNodeId?: string) => void
  getRun: (id: string) => DagExecutionRun | undefined
  getRunsByWorkflow: (workflowId: string) => DagExecutionRun[]
  clearCompleted: () => void
}

function contextToRun(
  ctx: DagExecutionContext,
  workflowName: string,
  completedNodeIds: string[],
  pendingNodeIds: string[]
): DagExecutionRun {
  return {
    id: ctx.runId,
    workflowId: ctx.workflowId,
    workflowName,
    status: ctx.status,
    inputs: ctx.inputs,
    variables: ctx.variables,
    nodeOutputs: Object.fromEntries(ctx.nodeOutputs.entries()),
    logs: ctx.logs,
    completedNodeIds,
    pendingNodeIds,
    failedNodeId: ctx.status === 'failed' ? pendingNodeIds[0] : undefined,
    error: ctx.error,
    startTime: ctx.startTime,
    endTime: ctx.endTime,
    updatedAt: Date.now(),
  }
}

export function runToContext(run: DagExecutionRun): DagExecutionContext {
  return {
    workflowId: run.workflowId,
    runId: run.id,
    inputs: run.inputs,
    variables: run.variables,
    nodeOutputs: new Map(Object.entries(run.nodeOutputs)),
    logs: run.logs,
    status: run.status,
    currentNodeIds: run.pendingNodeIds,
    startTime: run.startTime,
    endTime: run.endTime,
    error: run.error,
  }
}

export const useDagExecutionQueueStore = create<DagExecutionQueueState>()(
  persist(
    (set, get) => ({
      runs: [],
      activeRunId: null,
      isPaused: false,

      enqueue: (workflowId, workflowName, inputs) => {
        const run: DagExecutionRun = {
          id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          workflowId,
          workflowName,
          status: 'pending',
          inputs,
          variables: {},
          nodeOutputs: {},
          logs: [],
          completedNodeIds: [],
          pendingNodeIds: [],
          startTime: Date.now(),
          updatedAt: Date.now(),
        }
        set((state) => ({
          runs: [run, ...state.runs],
          activeRunId: state.activeRunId || run.id,
        }))
        return run
      },

      updateRun: (id, updates) => {
        set((state) => ({
          runs: state.runs.map((r) =>
            r.id === id ? { ...r, ...updates, updatedAt: Date.now() } : r
          ),
        }))
      },

      setActiveRun: (id) => set({ activeRunId: id }),

      pause: () => set({ isPaused: true }),

      resume: () => set({ isPaused: false }),

      cancel: (id) => {
        set((state) => ({
          runs: state.runs.map((r) =>
            r.id === id ? { ...r, status: 'cancelled' as DagExecutionStatus, endTime: Date.now(), updatedAt: Date.now() } : r
          ),
        }))
      },

      retry: (id, fromNodeId) => {
        set((state) => ({
          runs: state.runs.map((r) =>
            r.id === id
              ? {
                  ...r,
                  status: 'pending' as DagExecutionStatus,
                  failedNodeId: fromNodeId || r.failedNodeId,
                  error: undefined,
                  endTime: undefined,
                  updatedAt: Date.now(),
                }
              : r
          ),
        }))
      },

      getRun: (id) => get().runs.find((r) => r.id === id),

      getRunsByWorkflow: (workflowId) =>
        get().runs.filter((r) => r.workflowId === workflowId).sort((a, b) => b.updatedAt - a.updatedAt),

      clearCompleted: () => {
        set((state) => ({
          runs: state.runs.filter((r) =>
            r.status === 'running' || r.status === 'pending' || r.status === 'paused'
          ),
        }))
      },
    }),
    {
      name: 'wonclaw-dag-execution-queue',
      partialize: (state) => ({
        runs: state.runs,
        activeRunId: state.activeRunId,
      }),
    }
  )
)

export function snapshotContextToRun(
  ctx: DagExecutionContext,
  workflowName: string,
  completedNodeIds: string[],
  pendingNodeIds: string[]
): DagExecutionRun {
  return contextToRun(ctx, workflowName, completedNodeIds, pendingNodeIds)
}
