import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { cronApi } from '@/api/client'
import { useDagWorkflowStore } from '@/stores/dagWorkflowStore'
import type { CronTask, CronTaskResult } from '@/types/cron'
import { normalizeInputSchema } from '@/types/dagWorkflow'
import { runDagWorkflowAsAgent, type DagWorkflowRunResult } from '@/utils/dagWorkflowExecutionAgent'
import CronExpressionParser from 'cron-parser'

interface CronSchedulerState {
  tasks: CronTask[]
  loading: boolean
  error: string | null
  results: Record<string, CronTaskResult>
  runningTaskIds: Set<string>

  loadTasks: () => Promise<void>
  createTask: (task: Omit<CronTask, 'id' | 'status' | 'created_at' | 'updated_at' | 'last_run_at' | 'next_run_at' | 'run_count'>) => Promise<CronTask | null>
  updateTask: (id: string, updates: Partial<CronTask>) => Promise<CronTask | null>
  deleteTask: (id: string) => Promise<void>
  toggleTask: (id: string) => Promise<CronTask | null>
  runTask: (id: string) => Promise<CronTaskResult | null>
  checkAndRunDueTasks: () => Promise<void>
  clearError: () => void
  getTaskResult: (id: string) => CronTaskResult | undefined
}

function sortTasks(tasks: CronTask[]): CronTask[] {
  return [...tasks].sort((a, b) => {
    if (!a.next_run_at) return 1
    if (!b.next_run_at) return -1
    return new Date(a.next_run_at).getTime() - new Date(b.next_run_at).getTime()
  })
}

function buildTaskInputs(
  schema: import('@/types/dagWorkflow').DagWorkflow['inputSchema'],
  payloadInputs: Record<string, unknown>
): Record<string, unknown> {
  const normalized = normalizeInputSchema(schema)
  const inputs: Record<string, unknown> = {}

  for (const field of normalized) {
    if (payloadInputs[field.name] !== undefined) {
      inputs[field.name] = payloadInputs[field.name]
    } else if (field.default !== undefined) {
      inputs[field.name] = field.default
    } else if (field.required) {
      switch (field.type) {
        case 'boolean':
          inputs[field.name] = false
          break
        case 'array':
          inputs[field.name] = []
          break
        case 'object':
          inputs[field.name] = {}
          break
        case 'number':
          inputs[field.name] = 0
          break
        default:
          inputs[field.name] = ''
      }
    } else {
      switch (field.type) {
        case 'boolean':
          inputs[field.name] = false
          break
        case 'array':
          inputs[field.name] = []
          break
        case 'object':
          inputs[field.name] = {}
          break
        case 'number':
          inputs[field.name] = NaN
          break
        default:
          inputs[field.name] = ''
      }
    }
  }

  return { ...payloadInputs, ...inputs }
}

export const useCronSchedulerStore = create<CronSchedulerState>()(
  persist(
    (set, get) => ({
      tasks: [],
      loading: false,
      error: null,
      results: {},
      runningTaskIds: new Set(),

      loadTasks: async () => {
        set({ loading: true, error: null })
        try {
          const tasks = await cronApi.getTasks()
          set({ tasks: sortTasks(tasks), loading: false })
        } catch (err) {
          set({ error: err instanceof Error ? err.message : '加载任务失败', loading: false })
        }
      },

      createTask: async (task) => {
        try {
          const created = await cronApi.createTask(task)
          set((state) => ({ tasks: sortTasks([...state.tasks, created]), error: null }))
          return created
        } catch (err) {
          set({ error: err instanceof Error ? err.message : '创建任务失败' })
          return null
        }
      },

      updateTask: async (id, updates) => {
        try {
          const updated = await cronApi.updateTask(id, updates)
          set((state) => ({
            tasks: sortTasks(state.tasks.map((t) => (t.id === id ? updated : t))),
            error: null,
          }))
          return updated
        } catch (err) {
          set({ error: err instanceof Error ? err.message : '更新任务失败' })
          return null
        }
      },

      deleteTask: async (id) => {
        try {
          await cronApi.deleteTask(id)
          set((state) => ({
            tasks: state.tasks.filter((t) => t.id !== id),
            results: Object.fromEntries(Object.entries(state.results).filter(([key]) => key !== id)),
            error: null,
          }))
        } catch (err) {
          set({ error: err instanceof Error ? err.message : '删除任务失败' })
        }
      },

      toggleTask: async (id) => {
        try {
          const updated = await cronApi.toggleTask(id)
          set((state) => ({
            tasks: sortTasks(state.tasks.map((t) => (t.id === id ? updated : t))),
            error: null,
          }))
          return updated
        } catch (err) {
          set({ error: err instanceof Error ? err.message : '切换任务状态失败' })
          return null
        }
      },

      runTask: async (id) => {
        const { tasks, runningTaskIds } = get()
        const task = tasks.find((t) => t.id === id)
        if (!task) return null
        if (runningTaskIds.has(id)) return null

        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === id ? { ...t, isRunning: true } : t)),
          runningTaskIds: new Set([...state.runningTaskIds, id]),
        }))

        const triggeredAt = new Date().toISOString()
        const startedAt = Date.now()
        const localLogs: string[] = []

        const finish = (result: CronTaskResult) => {
          set((state) => ({
            tasks: sortTasks(
              state.tasks.map((t) =>
                t.id === id
                  ? {
                      ...t,
                      isRunning: false,
                      status: result.status,
                      last_run_at: result.completed_at ?? result.triggered_at,
                      next_run_at: computeNextRun(t.cron?.expression),
                      run_count: (t.run_count ?? 0) + 1,
                    }
                  : t
              )
            ),
            results: { ...state.results, [id]: result },
            runningTaskIds: new Set([...state.runningTaskIds].filter((tid) => tid !== id)),
            error: null,
          }))
        }

        const fail = (message: string) => {
          const completedAt = new Date().toISOString()
          const result: CronTaskResult = {
            task_id: id,
            triggered_at: triggeredAt,
            completed_at: completedAt,
            status: 'failed',
            error: message,
            error_message: message,
            logs: localLogs,
            ranAt: startedAt,
            execution_time_ms: Date.now() - startedAt,
          }
          finish(result)
          return result
        }

        try {
          if (task.payload?.execution_mode === 'dag_workflow') {
            const dagId = task.payload.dagWorkflowId
            if (!dagId) {
              return fail('缺少 dagWorkflowId')
            }

            const dagStore = useDagWorkflowStore.getState()
            const dagWorkflow = dagStore.getWorkflowById(dagId)
            if (!dagWorkflow) {
              return fail(`未找到 DAG 工作流：${dagId}`)
            }

            const inputs = buildTaskInputs(dagWorkflow.inputSchema, task.payload.dagInputs || {})

            let agentResult: DagWorkflowRunResult | undefined
            try {
              await runDagWorkflowAsAgent(dagWorkflow, inputs, {
                silent: true,
                onLog: (log) => {
                  localLogs.push(log)
                },
                onResult: (result) => {
                  agentResult = result
                },
                onCommitRepairs: async (repairs) => {
                  if (repairs.length === 0) return
                  for (const r of repairs) {
                    if (r.config) {
                      await dagStore.updateNodeData(dagWorkflow.id, r.nodeId, r.config as Partial<import('@/types/dagWorkflow').DagNodeData>)
                    }
                  }
                },
              })
            } catch {
              // runDagWorkflowAsAgent 失败时也会通过 onResult 返回结果
            }

            if (!agentResult) {
              return fail('DAG 执行未返回结果')
            }

            const completedAt = new Date().toISOString()
            const result: CronTaskResult = {
              task_id: id,
              triggered_at: triggeredAt,
              completed_at: completedAt,
              status: agentResult.status,
              outputs: agentResult.outputs,
              output: agentResult.outputs ? JSON.stringify(agentResult.outputs, null, 2) : undefined,
              error: agentResult.error,
              error_message: agentResult.error,
              logs: agentResult.logs,
              ranAt: startedAt,
              execution_time_ms: Date.now() - startedAt,
            }
            finish(result)
            return result
          }

          const result = await cronApi.runTask(id)
          finish(result)
          return result
        } catch (err) {
          const message = err instanceof Error ? err.message : '执行任务失败'
          set((state) => ({
            tasks: state.tasks.map((t) => (t.id === id ? { ...t, isRunning: false } : t)),
            runningTaskIds: new Set([...state.runningTaskIds].filter((tid) => tid !== id)),
            error: message,
          }))
          return fail(message)
        }
      },

      checkAndRunDueTasks: async () => {
        const { tasks, runTask, runningTaskIds } = get()
        const now = new Date().toISOString()
        const dueTasks = tasks
          .filter(
            (task) =>
              task.is_enabled &&
              !task.isRunning &&
              !runningTaskIds.has(task.id) &&
              task.next_run_at &&
              new Date(task.next_run_at) <= new Date(now)
          )
          .sort((a, b) => new Date(a.next_run_at!).getTime() - new Date(b.next_run_at!).getTime())

        for (const task of dueTasks) {
          await runTask(task.id)
        }
      },

      clearError: () => set({ error: null }),

      getTaskResult: (id) => get().results[id],
    }),
    {
      name: 'wonclaw-cron-scheduler-v2',
      partialize: (state) => ({
        // 运行状态不持久化
        tasks: state.tasks.map((t) => ({ ...t, isRunning: false })),
        results: state.results,
      }),
    }
  )
)

function computeNextRun(expression?: string): string | undefined {
  if (!expression) return undefined
  try {
    const interval = CronExpressionParser.parse(expression)
    return interval.next().toISOString() ?? undefined
  } catch {
    return undefined
  }
}

// 兼容旧导出的类型别名（供少量旧引用使用）
export type ScheduledTask = CronTask
export type ScheduleFrequency = 'once' | 'hourly' | 'daily' | 'weekly' | 'custom'
