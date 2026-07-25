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
}

export interface CronTaskUpdateRequest {
  name?: string
  description?: string
  cronExpression?: string
  executionMode?: string
  payload?: Record<string, unknown>
  isEnabled?: boolean
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

function toCreateRequest(task: Omit<CronTask, 'id' | 'status' | 'created_at' | 'updated_at' | 'last_run_at' | 'next_run_at' | 'run_count'>): CronTaskCreateRequest {
  return {
    name: task.name,
    description: task.description,
    cronExpression: task.cron?.expression ?? '',
    executionMode: task.payload?.execution_mode ?? 'llm_prompt',
    payload: (task.payload ?? {}) as Record<string, unknown>,
    isEnabled: task.is_enabled ?? true,
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
  return req
}

export const mescliCronApi = {
  /** GET /api/cron */
  getTasks: async (): Promise<CronTask[]> => {
    const res = await fetchApi<CronJobListDto>('/api/cron')
    return res.tasks.map(toCronTask)
  },

  /** POST /api/cron */
  createTask: async (task: Omit<CronTask, 'id' | 'status' | 'created_at' | 'updated_at' | 'last_run_at' | 'next_run_at' | 'run_count'>): Promise<CronTask> => {
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

  /** POST /api/cron/{id}/toggle */
  toggleTask: async (id: string): Promise<CronTask> => {
    const dto = await fetchApi<CronJobDto>(`/api/cron/${id}/toggle`, {
      method: 'POST',
    })
    return toCronTask(dto)
  },
}
