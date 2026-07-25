/**
 * Cron 定时任务类型
 *
 * 与 E:\code\WonWork\learn\05\cron\cron-overview.md 中的接口契约对应。
 */

// ==================== 核心任务类型 ====================

export type TaskStatus = 'pending' | 'running' | 'completed' | 'error'

export type TaskExecutionMode = 'llm_prompt' | 'tool_execute' | 'workflow_run'

export type StalePolicy = 'warning' | 'disable' | 'delete'

/** Cron 表达式（6 段式 UNIX cron + 秒） */
export interface CronExpression {
  raw: string
  second?: string
  minute: string
  hour: string
  dayOfMonth: string
  month: string
  dayOfWeek: string
  description?: string
}

export interface CronTask {
  id: string
  name: string
  description?: string
  cron: CronExpression
  payload?: Record<string, unknown>
  is_enabled: boolean
  status: TaskStatus
  created_at: string
  updated_at: string
  last_run_at?: string
  next_run_at?: string
  run_count: number
  stale_after_days: number
  stale_policy: StalePolicy
}

export interface CronTaskResult {
  task_id: string
  triggered_at: string
  completed_at?: string
  status: TaskStatus
  output?: string
  error_message?: string
  coalesced_count: number
  stale: boolean
  execution_time_ms?: number
}

// ==================== 预设配置 ====================

export type CronPresetLabel =
  | 'every_1min'
  | 'every_5min'
  | 'every_30min'
  | 'every_1h'
  | 'every_6h'
  | 'every_day_8am'
  | 'every_monday_9am'
  | 'every_month_1st'
  | 'custom'

export class CronPreset {
  label: CronPresetLabel
  expression: string
  display: string

  constructor(label: CronPresetLabel, expression: string, display: string) {
    this.label = label
    this.expression = expression
    this.display = display
  }
}

export const CommonPresets: CronPreset[] = [
  new CronPreset('every_1min', '* * * * *', '每分钟'),
  new CronPreset('every_5min', '*/5 * * * *', '每5分钟'),
  new CronPreset('every_30min', '*/30 * * * *', '每30分钟'),
  new CronPreset('every_1h', '0 * * * *', '每小时'),
  new CronPreset('every_6h', '0 */6 * * *', '每6小时'),
  new CronPreset('every_day_8am', '0 8 * * *', '每天 08:00'),
  new CronPreset('every_monday_9am', '0 9 * * 1', '每周一 09:00'),
  new CronPreset('every_month_1st', '0 0 1 * *', '每月1日'),
]
