import type { CronTask, CronTaskResult, TaskExecutionMode, TaskStatus, StalePolicy } from '@/types/cron'
import type { CronJobDto, CronJobExecutionDto, CronJobListDto } from '@/types/mescli'
import { fetchApi } from '@/api/client'

export interface CronTaskCreateRequest {
  name: string
  description?: string
  cronExpression: string
  executionMode: string
  payload: Record<string, unknown>
  isEnabled?: boolean
  /** 前端调度器预计算的下次执行时间（前端是调度状态唯一计算者，避免服务端 UTC 基准偏时区） */
  nextRunAt?: string
}

export interface CronTaskUpdateRequest {
  name?: string
  description?: string
  cronExpression?: string
  executionMode?: string
  payload?: Record<string, unknown>
  isEnabled?: boolean
  /** 前端预算的下次执行时间（cron/启停变更时携带；停用由后端自动清空，无需传 null） */
  nextRunAt?: string
}

/** 前端执行回报体（对应后端 CronExecutionReportRequest，camelCase 由 ASP.NET 默认序列化对齐） */
export interface CronExecutionReport {
  status: 'completed' | 'failed'
  output?: string
  errorMessage?: string
  executionTimeMs?: number
  triggeredAt?: string
  /** 下次执行时间（前端本地 cron-parser 计算，UTC ISO）；单次任务传 null */
  nextRunAt?: string | null
  /** 单次任务执行后置 true：后端写 next_run_at=null 并自动停用 */
  disableAfterReport?: boolean
}

function toCronTask(dto: CronJobDto): CronTask {
  return {
    id: dto.id,
    name: dto.name,
    description: dto.description,
    cron: { expression: dto.cronExpression },
    payload: {
      execution_mode: dto.executionMode as TaskExecutionMode,
      ...(dto.payload ?? {}),
    },
    is_enabled: dto.isEnabled,
    status: dto.status as TaskStatus,
    created_at: dto.createdAt,
    updated_at: dto.updatedAt,
    last_run_at: dto.lastRunAt,
    next_run_at: dto.nextRunAt,
    run_count: dto.runCount,
    stale_after_days: dto.staleAfterDays,
    stale_policy: dto.stalePolicy as StalePolicy,
  }
}

function toCronTaskResult(dto: CronJobExecutionDto): CronTaskResult {
  return {
    task_id: dto.taskId,
    triggered_at: dto.triggeredAt,
    completed_at: dto.completedAt,
    status: dto.status as TaskStatus,
    output: dto.output,
    error_message: dto.errorMessage,
    coalesced_count: dto.coalescedCount,
    stale: dto.stale,
    execution_time_ms: dto.executionTimeMs,
  }
}

/** 创建入参：保留 next_run_at——前端是调度状态唯一计算者（本地时区 cron-parser），
 *  创建时就把下次执行时间算好随任务落库，避免服务端 UTC 基准偏时区 */
export type CreateTaskInput = Omit<CronTask, 'id' | 'status' | 'created_at' | 'updated_at' | 'last_run_at' | 'run_count'>

function toCreateRequest(task: CreateTaskInput): CronTaskCreateRequest {
  return {
    name: task.name,
    description: task.description,
    cronExpression: task.cron?.expression ?? '',
    executionMode: task.payload?.execution_mode ?? 'llm_prompt',
    payload: (task.payload ?? {}) as Record<string, unknown>,
    isEnabled: task.is_enabled ?? true,
    nextRunAt: task.is_enabled !== false ? task.next_run_at : undefined,
  }
}

function toUpdateRequest(updates: Partial<CronTask>): CronTaskUpdateRequest {
  const req: CronTaskUpdateRequest = {}
  if (updates.name !== undefined) req.name = updates.name
  if (updates.description !== undefined) req.description = updates.description
  if (updates.cron?.expression !== undefined) req.cronExpression = updates.cron.expression
  if (updates.payload?.execution_mode !== undefined) req.executionMode = updates.payload.execution_mode
  if (updates.payload !== undefined) req.payload = updates.payload as unknown as Record<string, unknown>
  if (updates.is_enabled !== undefined) req.isEnabled = updates.is_enabled
  if (updates.next_run_at !== undefined) req.nextRunAt = updates.next_run_at
  return req
}

export const mescliCronApi = {
  /** GET /api/cron */
  getTasks: async (): Promise<CronTask[]> => {
    const res = await fetchApi<CronJobListDto>('/api/cron')
    return res.tasks.map(toCronTask)
  },

  /** POST /api/cron */
  createTask: async (task: CreateTaskInput): Promise<CronTask> => {
    const req = toCreateRequest(task)
    const dto = await fetchApi<CronJobDto>('/api/cron', {
      method: 'POST',
      body: JSON.stringify(req),
    })
    return toCronTask(dto)
  },

  /** PUT /api/cron/{id} */
  updateTask: async (id: string, updates: Partial<CronTask>): Promise<CronTask> => {
    const req = toUpdateRequest(updates)
    const dto = await fetchApi<CronJobDto>(`/api/cron/${id}`, {
      method: 'PUT',
      body: JSON.stringify(req),
    })
    return toCronTask(dto)
  },

  /** DELETE /api/cron/{id} */
  deleteTask: async (id: string): Promise<void> => {
    await fetchApi<void>(`/api/cron/${id}`, {
      method: 'DELETE',
    })
  },

  /** POST /api/cron/{id}/run */
  runTask: async (id: string): Promise<CronTaskResult> => {
    const dto = await fetchApi<CronJobExecutionDto>(`/api/cron/${id}/run`, {
      method: 'POST',
    })
    return toCronTaskResult(dto)
  },

  /** GET /api/cron/{id}/executions?limit —— 后端 executions 表的完整执行历史
   *  （2026-08-08 接上：此前前端只显示本次会话内存结果，重启即空） */
  getExecutions: async (id: string, limit = 20): Promise<CronTaskResult[]> => {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100)
    const dtos = await fetchApi<CronJobExecutionDto[]>(`/api/cron/${encodeURIComponent(id)}/executions?limit=${safeLimit}`)
    return dtos.map(toCronTaskResult)
  },

  /** POST /api/cron/{id}/toggle —— 启用时应携带前端预算的 nextRunAt（服务端 NCrontab 以 UTC 为基准偏时区） */
  toggleTask: async (id: string, nextRunAt?: string): Promise<CronTask> => {
    const dto = await fetchApi<CronJobDto>(`/api/cron/${id}/toggle`, {
      method: 'POST',
      body: JSON.stringify(nextRunAt ? { nextRunAt } : {}),
    })
    return toCronTask(dto)
  },

  /**
   * POST /api/cron/{id}/execution-report —— 前端本地执行完成后的回报（2026-08-05）。
   * 前端是调度状态唯一计算者：下次执行时间由本地 cron-parser 算好一并上报，
   * 后端据此回写 next_run_at/last_run_at/run_count 并记一条 executions 历史，
   * 否则后端只有创建时的旧 next_run_at，重启 loadTasks 会把全部循环任务误判成"错过"而补跑。
   * 单次任务：nextRunAt 传 null + disableAfterReport=true（执行后自动停用）。
   */
  reportExecution: async (id: string, report: CronExecutionReport): Promise<CronTask> => {
    const dto = await fetchApi<CronJobDto>(`/api/cron/${id}/execution-report`, {
      method: 'POST',
      body: JSON.stringify(report),
    })
    return toCronTask(dto)
  },
}
