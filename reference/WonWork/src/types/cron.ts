/**
 * Cron Task 类型定义
 * 适配 WonWork 项目
 */

import i18n from '@/i18n'

// ============================================================================
// 枚举
// ============================================================================

export type TaskType = 'one_time' | 'recurring' | 'interval' | 'conditional'
export const TASK_TYPES: TaskType[] = ['one_time', 'recurring', 'interval', 'conditional']

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'coalesced'
export const TASK_STATUSES: TaskStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'expired',
  'coalesced',
]

export type TaskExecutionMode =
  | 'llm_prompt'
  | 'code_exec'
  | 'webbridge'
  /** @deprecated 2026-08-08 用户拍板：多 Agent 蜂群方向废弃，执行器恒 NotSupported。
   *  保留类型仅为渲染存量任务（列表显示「已废弃」），新建不得使用。 */
  | 'agent_swarm'
  | 'notification'
  | 'agent_prompt'
/** 新建可选的执行方式（2026-08-08 收敛：主路径=agent_prompt 统一 agent 闭环；
 *  agent_swarm 已废弃不入列；workflow/dag_workflow 已随旧工作流两族下线（2026-09-09）；
 *  其余后端模式仅存量任务可见，不在新建表单提供） */
export const TASK_EXECUTION_MODES: TaskExecutionMode[] = [
  'llm_prompt',
  'code_exec',
  'webbridge',
  'notification',
  'agent_prompt',
]

export type ApprovalMode = 'require_approval' | 'auto_execute' | 'yolo_mode'

export type TimezoneMode = 'local' | 'utc' | 'system'

export type StalePolicy =
  | 'auto_delete'
  | 'notify_and_delete'
  | 'notify_and_keep'
  | 'renew_auto'

export type CodeLanguage = 'python' | 'shell'

export type NotificationType = 'desktop' | 'sound' | 'popup'

// ============================================================================
// 核心接口
// ============================================================================

/**
 * 标准 5-field cron 表达式
 * 格式：minute hour day-of-month month day-of-week
 */
export interface CronExpression {
  expression: string
  timezone?: TimezoneMode
  // 解析后的字段（可选，用于展示）
  minute?: string
  hour?: string
  day_of_month?: string
  month?: string
  day_of_week?: string
}

/**
 * 任务触发时执行的负载
 */
export interface TaskPayload {
  execution_mode: TaskExecutionMode
  // llm_prompt
  prompt?: string
  // code_exec
  language?: CodeLanguage
  code?: string
  working_dir?: string
  // webbridge
  actions?: Record<string, unknown>[]
  // agent_swarm
  swarm_config?: Record<string, unknown>
  // notification
  notification_type?: NotificationType
  message?: string
  // agent_prompt 单次任务标记（2026-08-05）：cron_create 的 run_at 落地方式=
  // 精确分钟 cron + once=true，执行一次后自动停用（next_run_at=null）
  once?: boolean
}

/**
 * 单个定时任务定义
 */
export interface CronTask {
  id: string
  name: string
  description?: string
  task_type?: TaskType
  cron?: CronExpression
  one_time_at?: string // ISO 8601 datetime
  interval_seconds?: number
  payload?: TaskPayload
  status?: TaskStatus
  is_enabled?: boolean
  created_at?: string
  updated_at?: string
  last_run_at?: string
  next_run_at?: string
  run_count?: number
  max_runs?: number
  stale_after_days?: number
  stale_policy?: StalePolicy
  session_id?: string
  tags?: string[]
  // 运行时状态（前端展示用，不持久化到后端）
  isRunning?: boolean
}

/**
 * 单次任务执行结果
 */
export interface CronTaskResult {
  task_id: string
  triggered_at: string
  completed_at?: string
  /** 任务本次运行状态 */
  status: TaskStatus
  /** 旧路径字符串输出（保留兼容） */
  output?: string
  /** DAG 工作流输出的对象形式 */
  outputs?: Record<string, unknown>
  error_message?: string
  /** 完整错误对象或字符串 */
  error?: string
  /** 运行日志摘要 */
  logs?: string[]
  /** 运行开始时间戳 */
  ranAt?: number
  /** agent_prompt 执行落库的会话 id（2026-08-08：行内「查看结果」直达该会话） */
  conversation_id?: number
  coalesced_count?: number
  stale?: boolean
  execution_time_ms?: number
}

/**
 * 系统配置
 */
export interface CronTaskConfig {
  disabled?: boolean
  max_tasks_per_session?: number
  prompt_max_size_bytes?: number
  enable_jitter?: boolean
  jitter_max_minutes?: number
  enable_coalescing?: boolean
  default_stale_days?: number
  stale_policy?: StalePolicy
  persist_across_sessions?: boolean
  keep_awake?: boolean
  execution_modes?: TaskExecutionMode[]
}

// ============================================================================
// 工具接口（与 cron 工具接口对齐）
// ============================================================================

/**
 * CronCreate 工具参数
 */
export interface CronCreateParams {
  cron: string // 5-field cron 表达式
  prompt: string // 触发文本（最大 8KB UTF-8）
  recurring?: boolean // true=循环，false=一次性
}

export interface CronCreateResult {
  id: string // 8 位十六进制 ID
  humanSchedule: string // 例如 "every 5 minutes"
  nextFireAt: string // ISO 8601 时间戳
}

/**
 * CronList 工具结果
 */
export interface CronListResult {
  tasks: Array<{
    id: string
    cron: string
    humanSchedule: string
    nextFireAt: string
    recurring: boolean
    ageDays: number
    stale: boolean
  }>
}

/**
 * CronDelete 工具参数
 */
export interface CronDeleteParams {
  id: string // 任务 ID
}

// ============================================================================
// 环境变量文档
// ============================================================================

export interface EnvVarDoc {
  description: string
  type: string
  default: string
  values?: string
}

export const ENV_VARS: Record<string, EnvVarDoc> = {
  WONWORK_DISABLE_CRON: {
    description: 'Globally disable all cron tasks',
    type: 'bool',
    default: '0',
    values: '1=disabled, 0=enabled',
  },
  WONWORK_CRON_MAX_TASKS: {
    description: 'Maximum tasks per session',
    type: 'int',
    default: '50',
  },
  WONWORK_CRON_PROMPT_LIMIT: {
    description: 'Max prompt size in bytes',
    type: 'int',
    default: '8192',
  },
  WONWORK_CRON_JITTER: {
    description: 'Enable trigger jitter',
    type: 'bool',
    default: '1',
  },
  WONWORK_CRON_STALE_DAYS: {
    description: 'Default stale expiration days',
    type: 'int',
    default: '7',
  },
}

// ============================================================================
// 预设工厂
// ============================================================================

export class CronPreset {
  static dailyAt(hour: number, minute = 0, prompt = ''): CronTask {
    return {
      id: '',
      name: `daily-${String(hour).padStart(2, '0')}-${String(minute).padStart(2, '0')}`,
      description: `Daily task at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      task_type: 'recurring',
      cron: { expression: `${minute} ${hour} * * *` },
      payload: { execution_mode: 'llm_prompt', prompt },
    }
  }

  static weekdayAt(hour: number, minute = 0, prompt = ''): CronTask {
    return {
      id: '',
      name: `weekday-${String(hour).padStart(2, '0')}-${String(minute).padStart(2, '0')}`,
      description: `Weekday task at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      task_type: 'recurring',
      cron: { expression: `${minute} ${hour} * * 1-5` },
      payload: { execution_mode: 'llm_prompt', prompt },
    }
  }

  static hourly(minute = 0, prompt = ''): CronTask {
    return {
      id: '',
      name: `hourly-${String(minute).padStart(2, '0')}`,
      description: `Hourly task at :${String(minute).padStart(2, '0')}`,
      task_type: 'recurring',
      cron: { expression: `${minute} * * * *` },
      payload: { execution_mode: 'llm_prompt', prompt },
    }
  }

  static everyNMinutes(n: number, prompt = ''): CronTask {
    return {
      id: '',
      name: `every-${n}-minutes`,
      description: `Every ${n} minutes`,
      task_type: 'recurring',
      cron: { expression: `*/${n} * * * *` },
      payload: { execution_mode: 'llm_prompt', prompt },
    }
  }

  static weekly(day: number, hour: number, minute = 0, prompt = ''): CronTask {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    return {
      id: '',
      name: `weekly-${dayNames[day]}-${String(hour).padStart(2, '0')}-${String(minute).padStart(2, '0')}`,
      description: `Weekly on ${dayNames[day]} at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      task_type: 'recurring',
      cron: { expression: `${minute} ${hour} * * ${day}` },
      payload: { execution_mode: 'llm_prompt', prompt },
    }
  }

  static oneTime(at: string, prompt = ''): CronTask {
    const date = new Date(at)
    return {
      id: '',
      name: `reminder-${date.toISOString().slice(0, 16).replace(/[-T:]/g, '')}`,
      description: `One-time reminder at ${at}`,
      task_type: 'one_time',
      one_time_at: at,
      payload: { execution_mode: 'llm_prompt', prompt },
      stale_after_days: 1,
    }
  }

  static delayed(minutesFromNow: number, prompt = ''): CronTask {
    const at = new Date(Date.now() + minutesFromNow * 60_000).toISOString()
    return CronPreset.oneTime(at, prompt)
  }
}

/**
 * 常见预置任务
 */
export class CommonPresets {
  static dailyStandupSummary(): CronTask {
    return CronPreset.weekdayAt(
      9,
      0,
      'Summarize the recent CI failures, pending PRs, and important commits since yesterday. Provide a concise standup-ready report.'
    )
  }

  static hourlyHealthCheck(): CronTask {
    return CronPreset.hourly(
      0,
      'Check production health endpoints: /health, /ready, /metrics. Report any anomalies.'
    )
  }

  static dailyNewsBriefing(): CronTask {
    return CronPreset.dailyAt(
      8,
      30,
      "Generate a morning briefing: summarize today's tech news, stock market highlights, and important announcements. Focus on AI, software engineering, and finance."
    )
  }

  static weeklyReport(): CronTask {
    return CronPreset.weekly(
      5,
      17,
      0,
      'Generate a weekly summary report covering: project progress, key accomplishments, blockers, and plans for next week.'
    )
  }

  static codeReviewReminder(): CronTask {
    return CronPreset.weekdayAt(
      14,
      30,
      'Check for pending code review requests and PRs that need attention. List them with priority and estimated review time.'
    )
  }

  static deployVerification(minutesAfterDeploy = 10): CronTask {
    return CronPreset.delayed(
      minutesAfterDeploy,
      'Verify the recent deployment: check application health, error rates, and key metrics. Confirm everything is stable.'
    )
  }

  static databaseBackupCheck(): CronTask {
    return CronPreset.dailyAt(
      3,
      0,
      "Verify last night's database backup completed successfully. Check backup size, integrity, and retention policy compliance."
    )
  }

  static securityAuditScan(): CronTask {
    return CronPreset.weekly(
      1,
      2,
      0,
      'Run security audit: check for vulnerable dependencies, exposed secrets in code, and review access logs for anomalies.'
    )
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 将 cron 表达式转换为人类可读描述（2026-08-08 中文化重写）。
 * 覆盖常见形态给出中文人话（对齐 claude-code cronToHuman 的列表可读化意图）；
 * 非常见形态兜底 `分 时 日 月 周` 原文，由调用方以 mono 小字展示。
 */
export function humanReadableCron(expression: string): string {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return expression
  const [minute, hour, dom, month, dow] = parts
  const hm = (h: string, m: string) =>
    `${h.padStart(2, '0')}:${m.padStart(2, '0')}`

  // */n 分钟
  const everyMin = minute.match(/^\*\/(\d+)$/)
  if (everyMin && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return i18n.t('cron.schedule.everyNMinutes', { n: everyMin[1] })
  }
  // 每小时（整点分）
  if (/^\d+$/.test(minute) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return i18n.t('cron.schedule.everyHourAtMinute', { minute })
  }
  // */n 小时
  const everyHour = hour.match(/^\*\/(\d+)$/)
  if (everyHour && dom === '*' && month === '*' && dow === '*') {
    return i18n.t('cron.schedule.everyNHours', { n: everyHour[1] })
  }
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && month === '*') {
    const time = hm(hour, minute)
    if (dom === '*' && dow === '*') return i18n.t('cron.schedule.dailyAt', { time })
    if (dom === '*' && dow === '1-5') return i18n.t('cron.schedule.weekdaysAt', { time })
    if (dom === '*' && dow === '0,6') return i18n.t('cron.schedule.weekendsAt', { time })
    if (dom === '*' && /^\d$/.test(dow)) {
      // 星期名随语言走（中文「一」、英文「Mon」），不能硬编码中文数组
      const weekday = i18n.t(`cron.schedule.weekdayNames.${dow}`)
      return i18n.t('cron.schedule.weeklyOnAt', { weekday, time })
    }
    if (/^\d+$/.test(dom) && dow === '*') return i18n.t('cron.schedule.monthlyOnAt', { day: Number(dom), time })
  }
  return expression
}

/**
 * 验证 5-field cron 表达式（基础验证）
 */
export function validateCron(expression: string): boolean {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return false
  return parts.every((p) => /^[\d*,/\-?L#]+$/.test(p))
}

/**
 * 创建默认配置
 */
export function createDefaultCronConfig(): CronTaskConfig {
  return {
    disabled: false,
    max_tasks_per_session: 50,
    prompt_max_size_bytes: 8192,
    enable_jitter: true,
    jitter_max_minutes: 15,
    enable_coalescing: true,
    default_stale_days: 7,
    stale_policy: 'notify_and_delete',
    persist_across_sessions: true,
    keep_awake: false,
    execution_modes: ['llm_prompt', 'code_exec'],
  }
}
