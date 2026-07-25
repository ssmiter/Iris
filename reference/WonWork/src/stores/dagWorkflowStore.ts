/**
 * DAG 工作流 Store
 * 负责 DAG workflow 的 CRUD、持久化与执行调度
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { dagWorkflowApi } from '@/api/client'
import type { DagWorkflow, DagExecutionContext, DagNodeData } from '@/types/dagWorkflow'
import type { WorkflowDefinition } from '@/types/webbridge'
import { executeDagWorkflow, computeDagLayout, type DagExecutionResumeContext } from '@/stores/dagExecutionEngine'
import { webbridgeWorkflowToDag, dagToWebbridgeWorkflow } from '@/utils/dagConverters'
import { wizardWorkflowToDag } from '@/utils/wizardToDagConverters'
import {
  startWorkflowRunChatThread,
  formatWorkflowOutputsToMarkdown,
  syncWorkflowFilesToWorkspace,
} from '@/utils/workflowRunToChat'
import type { WorkflowStep } from '@/types/mescli'
import {
  useDagExecutionQueueStore,
  snapshotContextToRun,
} from '@/stores/dagExecutionQueueStore'

interface DagWorkflowState {
  workflows: DagWorkflow[]
  activeWorkflowId: string | null
  activeRunId: string | null
  isExecuting: boolean
  executionContext: DagExecutionContext | null
  error: string | null
  abortController: AbortController | null

  loadWorkflows: () => Promise<void>
  createWorkflow: (draft: Omit<DagWorkflow, 'id' | 'createdAt' | 'updatedAt'>) => Promise<DagWorkflow>
  updateWorkflow: (id: string, updates: Partial<DagWorkflow>) => Promise<DagWorkflow | null>
  deleteWorkflow: (id: string) => Promise<void>
  duplicateWorkflow: (id: string) => Promise<DagWorkflow | null>
  exportAll: () => Promise<Blob | null>
  importWorkflows: (file: File) => Promise<DagWorkflow[] | null>
  setActiveWorkflow: (id: string | null) => void
  getWorkflowById: (id: string) => DagWorkflow | undefined

  runWorkflow: (id: string, inputs?: Record<string, unknown>, options?: { onNavigateToChat?: () => void }) => Promise<DagExecutionContext | null>
  stopWorkflow: () => void
  pauseWorkflow: () => void
  resumeWorkflow: () => Promise<DagExecutionContext | null>
  retryWorkflow: (fromNodeId?: string) => Promise<DagExecutionContext | null>

  importFromWebBridge: (workflow: WorkflowDefinition) => Promise<DagWorkflow>
  importFromWizard: (workflowCode: string, workflowName: string, steps: WorkflowStep[]) => Promise<DagWorkflow>
  exportToWebBridge: (id: string) => WorkflowDefinition | null
  autoLayout: (id: string) => Promise<DagWorkflow | null>
  updateNodeData: (workflowId: string, nodeId: string, data: Partial<DagNodeData>) => Promise<DagWorkflow | null>
}

function deepMergeNodeData(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMergeNodeData(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>
      )
    } else {
      result[key] = value
    }
  }
  return result
}

export const useDagWorkflowStore = create<DagWorkflowState>()(
  persist(
    (set, get) => ({
      workflows: [],
      activeWorkflowId: null,
      activeRunId: null,
      isExecuting: false,
      executionContext: null,
      error: null,
      abortController: null,

      loadWorkflows: async () => {
        try {
          const workflows = await dagWorkflowApi.getAll()
          set({ workflows, error: null })
        } catch (err) {
          set({ error: err instanceof Error ? err.message : '加载 DAG 工作流失败' })
        }
      },

      createWorkflow: async (draft) => {
        const created = await dagWorkflowApi.create(draft)
        set((state) => ({
          workflows: [created, ...state.workflows],
          activeWorkflowId: created.id,
          error: null,
        }))
        return created
      },

      updateWorkflow: async (id, updates) => {
        try {
          const updated = await dagWorkflowApi.update(id, updates)
          set((state) => ({
            workflows: state.workflows.map((w) => (w.id === id ? updated : w)),
            error: null,
          }))
          return updated
        } catch (err) {
          set({ error: err instanceof Error ? err.message : '更新 DAG 工作流失败' })
          return null
        }
      },

      deleteWorkflow: async (id) => {
        try {
          await dagWorkflowApi.delete(id)
          set((state) => ({
            workflows: state.workflows.filter((w) => w.id !== id),
            activeWorkflowId: state.activeWorkflowId === id ? null : state.activeWorkflowId,
            error: null,
          }))
        } catch (err) {
          set({ error: err instanceof Error ? err.message : '删除 DAG 工作流失败' })
        }
      },

      duplicateWorkflow: async (id) => {
        try {
          const copy = await dagWorkflowApi.duplicate(id)
          set((state) => ({
            workflows: [copy, ...state.workflows],
            activeWorkflowId: copy.id,
            error: null,
          }))
          return copy
        } catch (err) {
          set({ error: err instanceof Error ? err.message : '复制 DAG 工作流失败' })
          return null
        }
      },

      exportAll: async () => {
        try {
          const blob = await dagWorkflowApi.exportAll()
          set({ error: null })
          return blob
        } catch (err) {
          set({ error: err instanceof Error ? err.message : '导出 DAG 工作流失败' })
          return null
        }
      },

      importWorkflows: async (file) => {
        try {
          const text = await file.text()
          const imported = await dagWorkflowApi.import(text)
          set((state) => ({
            workflows: [...imported, ...state.workflows],
            error: null,
          }))
          return imported
        } catch (err) {
          set({ error: err instanceof Error ? err.message : '导入 DAG 工作流失败' })
          return null
        }
      },

      setActiveWorkflow: (id) => set({ activeWorkflowId: id }),

      getWorkflowById: (id) => get().workflows.find((w) => w.id === id),

      runWorkflow: async (id, inputs = {}, options) => {
        // 调试追踪：旧执行路径不应再从 UI 触发，记录调用栈以便排查
        console.warn('[dagWorkflowStore.runWorkflow] 旧执行路径被调用，workflowId:', id, '\n', new Error().stack)
        const workflow = get().workflows.find((w) => w.id === id)
        if (!workflow) {
          set({ error: `未找到 DAG 工作流：${id}` })
          return null
        }

        const queue = useDagExecutionQueueStore.getState()
        const run = queue.enqueue(workflow.id, workflow.name, inputs)
        queue.setActiveRun(run.id)

        const abortController = new AbortController()
        get().abortController = abortController

        set({
          isExecuting: true,
          executionContext: null,
          error: null,
          activeRunId: run.id,
        })

        const chatThread = options?.onNavigateToChat
          ? await startWorkflowRunChatThread(workflow.name, 'dag', inputs)
          : null
        if (chatThread) {
          options?.onNavigateToChat?.()
        }

        const execute = async (
          resumeCtx?: DagExecutionResumeContext,
          completedNodeIds?: string[]
        ): Promise<DagExecutionContext> => {
          return executeDagWorkflow(workflow, inputs, {
            abortSignal: abortController.signal,
            resumeContext: resumeCtx,
            completedNodeIds,
            workflowName: workflow.name,
            getWorkflowById: (id) => get().workflows.find((w) => w.id === id),
            onNodeStart: (nodeId) => {
              set((state) => ({
                executionContext: state.executionContext
                  ? { ...state.executionContext, currentNodeIds: [nodeId] }
                  : null,
              }))
              chatThread?.updateLog(`开始执行节点：${nodeId}`)
            },
            onNodeComplete: (nodeId, output) => {
              set((state) => ({
                executionContext: state.executionContext
                  ? {
                      ...state.executionContext,
                      nodeOutputs: new Map(state.executionContext.nodeOutputs).set(nodeId, output),
                    }
                  : null,
              }))
              chatThread?.updateLog(`节点 ${nodeId} 执行完成`)
            },
            onLog: (log) => {
              set((state) => ({
                executionContext: state.executionContext
                  ? { ...state.executionContext, logs: [...state.executionContext.logs, log] }
                  : null,
              }))
              chatThread?.updateLog(`[${log.level}] ${log.message}`)
            },
            onCheckpoint: (ctx, completed, pending) => {
              const queueState = useDagExecutionQueueStore.getState()
              queueState.updateRun(run.id, snapshotContextToRun(ctx, workflow.name, completed, pending))
              set({
                executionContext: ctx,
              })
            },
            checkPaused: () => {
              return useDagExecutionQueueStore.getState().isPaused
            },
          })
        }

        try {
          const ctx = await execute()

          const finalRun = snapshotContextToRun(
            ctx,
            workflow.name,
            Array.from(ctx.nodeOutputs.keys()).filter((nid) => nid !== '__outputs__'),
            []
          )
          useDagExecutionQueueStore.getState().updateRun(run.id, finalRun)

          if (ctx.status === 'paused') {
            set({ executionContext: ctx, isExecuting: false, activeRunId: run.id })
          } else {
            set({ executionContext: ctx, isExecuting: false, activeRunId: null })
          }

          const outputs = ctx.nodeOutputs.get('__outputs__') as Record<string, unknown> | undefined
          let summary: string
          if (outputs && Object.keys(outputs).length > 0) {
            summary = `工作流「${workflow.name}」执行完成。\n\n${formatWorkflowOutputsToMarkdown(outputs)}`
            // 同步文件到 WebBridge 工作区（best effort）
            syncWorkflowFilesToWorkspace(outputs).catch((err) => {
              console.warn('[DagWorkflowStore] 同步工作流文件到工作区失败:', err)
            })
          } else if (ctx.status === 'failed' && ctx.error) {
            summary = `工作流「${workflow.name}」执行完成，状态：${ctx.status}。\n\n错误：${ctx.error}`
          } else {
            summary = `工作流「${workflow.name}」执行完成，状态：${ctx.status}。`
          }
          chatThread?.finalize(ctx.status === 'failed' ? 'error' : 'completed', summary)

          return ctx
        } catch (err) {
          const message = err instanceof Error ? err.message : '执行失败'
          set({ error: message, isExecuting: false })
          chatThread?.finalize('error', `工作流「${workflow.name}」执行失败：${message}`)
          return null
        } finally {
          get().abortController = null
          useDagExecutionQueueStore.getState().resume()
        }
      },

      stopWorkflow: () => {
        const controller = get().abortController
        if (controller) {
          controller.abort()
        } else {
          const runId = get().activeRunId
          if (runId) {
            useDagExecutionQueueStore.getState().cancel(runId)
            set((state) =>
              state.executionContext
                ? {
                    executionContext: { ...state.executionContext, status: 'cancelled', endTime: Date.now() },
                    isExecuting: false,
                    activeRunId: null,
                  }
                : state
            )
          }
        }
      },

      pauseWorkflow: () => {
        useDagExecutionQueueStore.getState().pause()
      },

      resumeWorkflow: async () => {
        const queue = useDagExecutionQueueStore.getState()
        const run = queue.activeRunId ? queue.getRun(queue.activeRunId) : undefined
        if (!run || run.status !== 'paused') return null

        const workflow = get().workflows.find((w) => w.id === run.workflowId)
        if (!workflow) {
          set({ error: '无法恢复：工作流不存在' })
          return null
        }

        queue.resume()
        const abortController = new AbortController()
        get().abortController = abortController
        set({ isExecuting: true, error: null })

        const resumeCtx: DagExecutionResumeContext = {
          runId: run.id,
          inputs: run.inputs,
          variables: run.variables,
          nodeOutputs: run.nodeOutputs,
          logs: run.logs,
          status: 'paused',
          startTime: run.startTime,
        }

        try {
          const ctx = await executeDagWorkflow(workflow, run.inputs, {
            abortSignal: abortController.signal,
            resumeContext: resumeCtx,
            completedNodeIds: run.completedNodeIds,
            workflowName: workflow.name,
            getWorkflowById: (id) => get().workflows.find((w) => w.id === id),
            onNodeStart: (nodeId) => {
              set((state) => ({
                executionContext: state.executionContext
                  ? { ...state.executionContext, currentNodeIds: [nodeId] }
                  : null,
              }))
            },
            onNodeComplete: (nodeId, output) => {
              set((state) => ({
                executionContext: state.executionContext
                  ? {
                      ...state.executionContext,
                      nodeOutputs: new Map(state.executionContext.nodeOutputs).set(nodeId, output),
                    }
                  : null,
              }))
            },
            onLog: (log) => {
              set((state) => ({
                executionContext: state.executionContext
                  ? { ...state.executionContext, logs: [...state.executionContext.logs, log] }
                  : null,
              }))
            },
            onCheckpoint: (ctx, completed, pending) => {
              useDagExecutionQueueStore
                .getState()
                .updateRun(run.id, snapshotContextToRun(ctx, workflow.name, completed, pending))
              set({ executionContext: ctx })
            },
            checkPaused: () => useDagExecutionQueueStore.getState().isPaused,
          })

          const finalRun = snapshotContextToRun(
            ctx,
            workflow.name,
            Array.from(ctx.nodeOutputs.keys()).filter((nid) => nid !== '__outputs__'),
            []
          )
          queue.updateRun(run.id, finalRun)
          set({ executionContext: ctx, isExecuting: false, activeRunId: null })
          return ctx
        } catch (err) {
          const message = err instanceof Error ? err.message : '恢复执行失败'
          set({ error: message, isExecuting: false })
          return null
        } finally {
          get().abortController = null
          queue.resume()
        }
      },

      retryWorkflow: async (fromNodeId) => {
        const queue = useDagExecutionQueueStore.getState()
        const run = queue.activeRunId ? queue.getRun(queue.activeRunId) : undefined
        if (!run || (run.status !== 'failed' && run.status !== 'paused')) return null

        const workflow = get().workflows.find((w) => w.id === run.workflowId)
        if (!workflow) {
          set({ error: '无法重试：工作流不存在' })
          return null
        }

        queue.retry(run.id, fromNodeId)
        queue.resume()
        const abortController = new AbortController()
        get().abortController = abortController
        set({ isExecuting: true, error: null })

        // 重试时：若指定 fromNodeId，则将该节点及之后标记为未完成
        const completedNodeIds = fromNodeId
          ? run.completedNodeIds.filter((nid) => nid !== fromNodeId)
          : run.completedNodeIds

        const resumeCtx: DagExecutionResumeContext = {
          runId: run.id,
          inputs: run.inputs,
          variables: run.variables,
          nodeOutputs: run.nodeOutputs,
          logs: run.logs,
          status: 'paused',
          startTime: run.startTime,
        }

        try {
          const ctx = await executeDagWorkflow(workflow, run.inputs, {
            abortSignal: abortController.signal,
            resumeContext: resumeCtx,
            completedNodeIds,
            workflowName: workflow.name,
            getWorkflowById: (id) => get().workflows.find((w) => w.id === id),
            onNodeStart: (nodeId) => {
              set((state) => ({
                executionContext: state.executionContext
                  ? { ...state.executionContext, currentNodeIds: [nodeId] }
                  : null,
              }))
            },
            onNodeComplete: (nodeId, output) => {
              set((state) => ({
                executionContext: state.executionContext
                  ? {
                      ...state.executionContext,
                      nodeOutputs: new Map(state.executionContext.nodeOutputs).set(nodeId, output),
                    }
                  : null,
              }))
            },
            onLog: (log) => {
              set((state) => ({
                executionContext: state.executionContext
                  ? { ...state.executionContext, logs: [...state.executionContext.logs, log] }
                  : null,
              }))
            },
            onCheckpoint: (ctx, completed, pending) => {
              useDagExecutionQueueStore
                .getState()
                .updateRun(run.id, snapshotContextToRun(ctx, workflow.name, completed, pending))
              set({ executionContext: ctx })
            },
            checkPaused: () => useDagExecutionQueueStore.getState().isPaused,
          })

          const finalRun = snapshotContextToRun(
            ctx,
            workflow.name,
            Array.from(ctx.nodeOutputs.keys()).filter((nid) => nid !== '__outputs__'),
            []
          )
          queue.updateRun(run.id, finalRun)
          set({ executionContext: ctx, isExecuting: false, activeRunId: null })
          return ctx
        } catch (err) {
          const message = err instanceof Error ? err.message : '重试执行失败'
          set({ error: message, isExecuting: false })
          return null
        } finally {
          get().abortController = null
          queue.resume()
        }
      },

      importFromWebBridge: async (workflow) => {
        const dag = webbridgeWorkflowToDag(workflow)
        const created = await dagWorkflowApi.create(dag)
        set((state) => ({
          workflows: [created, ...state.workflows],
          activeWorkflowId: created.id,
          error: null,
        }))
        return created
      },

      importFromWizard: async (workflowCode, workflowName, steps) => {
        const dag = wizardWorkflowToDag(workflowCode, workflowName, steps)
        const created = await dagWorkflowApi.create(dag)
        set((state) => ({
          workflows: [created, ...state.workflows],
          activeWorkflowId: created.id,
          error: null,
        }))
        return created
      },

      exportToWebBridge: (id) => {
        const workflow = get().workflows.find((w) => w.id === id)
        if (!workflow) return null
        return dagToWebbridgeWorkflow(workflow)
      },

      autoLayout: async (id) => {
        const workflow = get().workflows.find((w) => w.id === id)
        if (!workflow) return null
        const laidOut = computeDagLayout(workflow)
        return get().updateWorkflow(id, { nodes: laidOut.nodes })
      },

      updateNodeData: async (workflowId, nodeId, data) => {
        const workflow = get().workflows.find((w) => w.id === workflowId)
        if (!workflow) {
          set({ error: `未找到 DAG 工作流：${workflowId}` })
          return null
        }
        const updatedNodes = workflow.nodes.map((n) =>
          n.id === nodeId
            ? { ...n, data: deepMergeNodeData(n.data as Record<string, unknown>, data as Record<string, unknown>) as DagNodeData }
            : n
        )
        return get().updateWorkflow(workflowId, { nodes: updatedNodes })
      },
    }),
    {
      name: 'wonclaw-dag-workflow',
      partialize: (state) => ({
        workflows: state.workflows,
        activeWorkflowId: state.activeWorkflowId,
      }),
    }
  )
)
