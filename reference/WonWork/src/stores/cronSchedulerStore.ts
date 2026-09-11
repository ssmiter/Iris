import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { cronApi } from '@/api/client'
import type { CreateTaskInput } from '@/api/mescli/cronApi'
import type { CronTask, CronTaskResult } from '@/types/cron'
import CronExpressionParser from 'cron-parser'
import { toast } from 'sonner'
import i18n from '@/i18n'

// ──────────────────────── 唤醒调度（事件驱动，2026-08-05 替代固定轮询）────────────────────────
// 机制：永远只 arm 一个 setTimeout，指向所有启用任务中最近的 next_run_at；
// 到点执行到期任务（finish 会重算 next_run_at）→ 重新 arm 下一个。
// 任何任务变更（增/删/改/启停/后端同步完成）都重新 arm。
// 已知弱点的兜底在 App.tsx：后台标签节流/系统睡眠 → focus/visibilitychange 补查 + 5min 保险丝。
let wakeTimer: ReturnType<typeof setTimeout> | null = null

export function scheduleNextWake(): void {
  if (wakeTimer) {
    clearTimeout(wakeTimer)
    wakeTimer = null
  }
  const { tasks, runningTaskIds } = useCronSchedulerStore.getState()
  const now = Date.now()
  const times = tasks
    .filter((t) => t.is_enabled && !t.isRunning && !runningTaskIds.has(t.id) && t.next_run_at)
    .map((t) => new Date(t.next_run_at!).getTime())
    .filter((ms) => !Number.isNaN(ms))
  if (times.length === 0) return
  const delay = Math.max(0, Math.min(...times) - now)
  wakeTimer = setTimeout(() => {
    wakeTimer = null
    void useCronSchedulerStore
      .getState()
      .checkAndRunDueTasks()
      .finally(() => scheduleNextWake())
  }, delay)
}

/** 错过补跑的宽限：next_run_at 落后超过此时长视为"错过"，补跑时向用户说明原计划时间 */
const MISSED_RUN_GRACE_MS = 10 * 60 * 1000

/** 单次任务过期阈值（2026-08-05）：提醒类单次任务错过超过此时长不再补跑
 *  （"5分钟后提醒喝水"关机三天后补跑=无意义打扰），直接停用并说明 */
const ONCE_TASK_EXPIRE_MS = 60 * 60 * 1000

/** 时区指纹存储键：检测机器时区变更（差旅/跨国，用户提"中国、非洲也有用户"的延伸） */
const TIMEZONE_STORAGE_KEY = 'wonclaw-cron-timezone'

/**
 * 时区变更对账：cron 语义=本机墙钟，派生缓存 next_run_at 是旧时区算的绝对点，
 * 机器换时区后"早8点"会漂移。启动时比对时区指纹，变了就对启用且未到期的任务
 * 按新时区重算并回写；已过期的任务不动（走既有错过补跑/过期跳过语义，
 * 避免单次任务被重算推到明年同一天）。
 */
async function reconcileTimezoneIfChanged(tasks: CronTask[]): Promise<CronTask[]> {
  const currentTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const lastTz = localStorage.getItem(TIMEZONE_STORAGE_KEY)
  if (lastTz === currentTz) return tasks
  localStorage.setItem(TIMEZONE_STORAGE_KEY, currentTz)
  if (!lastTz) return tasks // 首次记录指纹，非变更

  const now = Date.now()
  const result: CronTask[] = []
  let shifted = 0
  for (const t of tasks) {
    const futureDue = t.is_enabled && t.next_run_at && new Date(t.next_run_at).getTime() > now
    const next = futureDue ? computeNextRun(t.cron?.expression) : undefined
    if (futureDue && next && next !== t.next_run_at) {
      try {
        result.push(await cronApi.updateTask(t.id, { next_run_at: next }))
        shifted++
        continue
      } catch (err) {
        console.warn(`[cron] 时区重算回写失败（${t.name}），保留原值:`, err)
      }
    }
    result.push(t)
  }
  if (shifted > 0) {
    toast.info(
      i18n.t('chat.toast.timezoneShifted', {
        from: lastTz,
        to: currentTz,
        count: shifted,
      })
    )
  }
  return result
}

/** 加载代际守卫（2026-08-08，同 mcpMarketStore.loadServersSeq 模式）：
 *  任何会改变任务集的操作先 bump，使此前发出的在途 loadTasks 响应失去落定资格 */
let loadTasksSeq = 0

interface CronSchedulerState {
  tasks: CronTask[]
  loading: boolean
  error: string | null
  results: Record<string, CronTaskResult>
  runningTaskIds: Set<string>

  loadTasks: () => Promise<void>
  createTask: (task: CreateTaskInput) => Promise<CronTask | null>
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

export const useCronSchedulerStore = create<CronSchedulerState>()(
  persist(
    (set, get) => ({
      tasks: [],
      loading: false,
      error: null,
      results: {},
      runningTaskIds: new Set(),

      loadTasks: async () => {
        const seq = ++loadTasksSeq
        set({ loading: true, error: null })
        try {
          const tasks = await cronApi.getTasks()
          const reconciled = await reconcileTimezoneIfChanged(tasks)
          if (seq !== loadTasksSeq) return // 已有更新的操作接管，旧快照不落定
          set({ tasks: sortTasks(reconciled), loading: false })
          scheduleNextWake()
        } catch (err) {
          if (seq !== loadTasksSeq) return
          set({ error: err instanceof Error ? err.message : '加载任务失败', loading: false })
        }
      },

      createTask: async (task) => {
        try {
          // 前端是调度状态唯一计算者：创建时预算下次执行时间随任务落库
          // （后端 NCrontab 以 UtcNow 为基准，中国/非洲等时区下会偏）
          const withNext =
            task.next_run_at === undefined && task.is_enabled !== false
              ? { ...task, next_run_at: computeNextRun(task.cron?.expression) }
              : task
          const created = await cronApi.createTask(withNext)
          set((state) => ({ tasks: sortTasks([...state.tasks, created]), error: null }))
          scheduleNextWake()
          return created
        } catch (err) {
          set({ error: err instanceof Error ? err.message : '创建任务失败' })
          return null
        }
      },

      updateTask: async (id, updates) => {
        try {
          // cron 或启停变更时同步预算 next_run_at（停用不传，后端自动清空）
          const current = get().tasks.find((t) => t.id === id)
          const scheduleChanged = updates.cron?.expression !== undefined || updates.is_enabled !== undefined
          if (current && scheduleChanged && updates.next_run_at === undefined) {
            const enabled = updates.is_enabled ?? current.is_enabled ?? true
            const expression = updates.cron?.expression ?? current.cron?.expression
            updates = { ...updates, next_run_at: enabled ? computeNextRun(expression) : undefined }
          }
          const updated = await cronApi.updateTask(id, updates)
          set((state) => ({
            tasks: sortTasks(state.tasks.map((t) => (t.id === id ? updated : t))),
            error: null,
          }))
          scheduleNextWake()
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
          scheduleNextWake()
        } catch (err) {
          set({ error: err instanceof Error ? err.message : '删除任务失败' })
        }
      },

      toggleTask: async (id) => {
        // 乐观启停（2026-08-08，同 MCP updateSettings 模式）：开关立即翻转，
        // 失败回滚；bump 代际守卫作废点击前发出的在途 loadTasks 旧快照
        loadTasksSeq++
        const prev = get().tasks.find((t) => t.id === id)
        if (!prev) return null
        const optimisticEnabled = !(prev.is_enabled ?? true)
        // 即将启用时预算下次执行时间（服务端 NCrontab 以 UTC 为基准偏时区）：
        // 乐观态同步翻转 next_run_at，行内「下次执行」不等待 API 往返
        const optimisticNext = optimisticEnabled ? computeNextRun(prev.cron?.expression) : undefined
        set((state) => ({
          tasks: sortTasks(
            state.tasks.map((t) => (t.id === id ? { ...t, is_enabled: optimisticEnabled, next_run_at: optimisticNext } : t))
          ),
        }))
        scheduleNextWake()
        try {
          const updated = await cronApi.toggleTask(id, optimisticNext)
          set((state) => ({
            tasks: sortTasks(state.tasks.map((t) => (t.id === id ? updated : t))),
            error: null,
          }))
          scheduleNextWake()
          return updated
        } catch (err) {
          // 回滚到点击前状态
          set((state) => ({
            tasks: sortTasks(state.tasks.map((t) => (t.id === id ? prev : t))),
            error: err instanceof Error ? err.message : '切换任务状态失败',
          }))
          scheduleNextWake()
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
        // 单次任务（cron_create run_at 落地方式：精确分钟 cron + payload.once）执行一次后自动停用
        const isOnce = task.payload?.once === true
        // 本地执行（agent_prompt）才需要回报后端；llm_prompt 旧路径由后端
        // /run 端点自己更新 next_run_at/run_count，再回报会重复计数
        let executedLocally = false

        const finish = (result: CronTaskResult) => {
          const nextRun = isOnce ? undefined : computeNextRun(task.cron?.expression)
          set((state) => ({
            tasks: sortTasks(
              state.tasks.map((t) =>
                t.id === id
                  ? {
                      ...t,
                      isRunning: false,
                      is_enabled: isOnce ? false : t.is_enabled,
                      status: result.status,
                      last_run_at: result.completed_at ?? result.triggered_at,
                      next_run_at: nextRun,
                      run_count: (t.run_count ?? 0) + 1,
                    }
                  : t
              )
            ),
            results: { ...state.results, [id]: result },
            runningTaskIds: new Set([...state.runningTaskIds].filter((tid) => tid !== id)),
            error: null,
          }))
          // 执行回报（2026-08-05）：本地执行后端无感知，必须主动回写——否则后端
          // next_run_at 停在创建时的旧值，下次启动 loadTasks 会把全部循环任务
          // 误判成"错过"而补跑。回报顺带记一条 executions 历史。
          if (executedLocally) {
            void cronApi
              .reportExecution(id, {
                status: result.status === 'completed' ? 'completed' : 'failed',
                output: result.output,
                errorMessage: result.error_message,
                executionTimeMs: result.execution_time_ms,
                triggeredAt,
                nextRunAt: nextRun ?? null,
                disableAfterReport: isOnce,
              })
              .then((updated) => {
                // 回写后的权威版本合并进来（isRunning 本地已清除，保持 false）
                set((state) => ({
                  tasks: sortTasks(state.tasks.map((t) => (t.id === id ? { ...updated, isRunning: false } : t))),
                }))
                scheduleNextWake()
              })
              .catch((err) => {
                console.warn('[cron] 执行回报失败（本地状态已更新，后端 next_run_at 可能滞后一次）:', err)
              })
          }
          scheduleNextWake()
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
          // agent_prompt（2026-08-05 一体系统主路径）：前端派遣后台 agent 跑任务，
          // 整段对话落库为新会话（侧栏可见可接力提问），不打扰主对话。
          if (task.payload?.execution_mode === 'agent_prompt') {
            executedLocally = true
            const prompt = task.payload.prompt?.trim()
            if (!prompt) {
              return fail('缺少任务 prompt')
            }

            const { launchBackgroundAgent } = await import('@/agent/backgroundAgent')
            const firedAt = new Date()
            // 同名周期任务每次执行产生一个会话，带日期后缀防侧栏被同名会话淹没
            const dateSuffix = `${String(firedAt.getMonth() + 1).padStart(2, '0')}-${String(firedAt.getDate()).padStart(2, '0')}`
            const agentResult = await launchBackgroundAgent({
              prompt,
              title: `${task.name} · ${dateSuffix}`,
              source: 'cron',
            })

            localLogs.push(
              agentResult.conversationId != null
                ? `结果已落库为会话 #${agentResult.conversationId}（侧栏可查看）`
                : '会话落库不可用，结果仅保存在本执行记录'
            )
            const completedAt = new Date().toISOString()
            const result: CronTaskResult = {
              task_id: id,
              triggered_at: triggeredAt,
              completed_at: completedAt,
              status: agentResult.status === 'done' ? 'completed' : 'failed',
              output: agentResult.report,
              error: agentResult.error,
              error_message: agentResult.error,
              logs: localLogs,
              ranAt: startedAt,
              conversation_id: agentResult.conversationId ?? undefined,
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
          const plannedMs = new Date(task.next_run_at!).getTime()
          const missedMs = Date.now() - plannedMs
          // 单次任务过期跳过（2026-08-05）：提醒类单次任务错过太久，补跑=无意义打扰
          // ——不执行，直接停用并说明
          if (task.payload?.once && missedMs > ONCE_TASK_EXPIRE_MS) {
            toast.info(
              `单次任务已过期跳过：「${task.name}」（原计划 ${new Date(plannedMs).toLocaleString('zh-CN', { hour12: false })}）`
            )
            await get().updateTask(task.id, { is_enabled: false })
            continue
          }
          // 错过补跑可见性（2026-08-05）：关机/睡眠错过较久的任务补跑前说明原计划时间，
          // 否则开机后一个会话突然自动开跑会显得莫名（claude-code missed-task 通知同款意图）
          if (missedMs > MISSED_RUN_GRACE_MS) {
            toast.info(
              `补跑错过的定时任务：「${task.name}」（原计划 ${new Date(plannedMs).toLocaleString('zh-CN', { hour12: false })}）`
            )
          }
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
