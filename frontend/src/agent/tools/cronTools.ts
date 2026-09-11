import type { Tool, ToolExecutionContext } from '@/agent/types'
import { cronApi } from '@/api/client'
import type { CronTask } from '@/types/cron'
import CronExpressionParser from 'cron-parser'

/**
 * cron_create / cron_list / cron_toggle / cron_delete：对话内管理定时任务
 * （2026-08-05 pipeline/agent/cron 一体系统，批 4）。
 *
 * 产品形态：定时任务不开独立页面也能用——用户在对话里说"每天早上8点整理昨天
 * 密炼车间的质量情况"，模型把意图转成【调度+自足任务 prompt】落库；到点后前端
 * 调度器派遣后台 agent 执行，结果落库为一个新会话出现在侧栏（可打开看过程、
 * 接着提问）。能力目录里的"定时任务"声明从此有真工具支撑。
 *
 * prompt 撰写纪律（cron_create 描述承担，边界条件的严谨性在这里兑现）：
 * 定时任务在无人值守的全新上下文执行，看不到本对话——prompt 必须自包含：
 * 背景、数据口径（时间锚点=执行当天）、完成标准、允许/禁止的操作边界。
 */

export const CRON_CREATE_TOOL_NAME = 'cron_create'
export const CRON_LIST_TOOL_NAME = 'cron_list'
export const CRON_TOGGLE_TOOL_NAME = 'cron_toggle'
export const CRON_UPDATE_TOOL_NAME = 'cron_update'
export const CRON_DELETE_TOOL_NAME = 'cron_delete'

/** 写操作后同步前端调度器内存清单（否则新任务要等下次 loadTasks 才参与轮询）。
 *  动态 import 防循环依赖：cronSchedulerStore→dag 执行链→chatStore→本模块（TDZ 白屏教训） */
async function refreshSchedulerTasks(): Promise<void> {
  try {
    const { useCronSchedulerStore } = await import('@/stores/cronSchedulerStore')
    await useCronSchedulerStore.getState().loadTasks()
  } catch (err) {
    console.warn('[cronTools] 刷新调度器任务清单失败（不影响已完成的写操作）:', err)
  }
}

const PROMPT_GUIDE = `
任务 prompt 撰写要求（定时任务在无人值守的全新上下文执行，看不到当前对话，执行中无法向人确认——所以该问的创建时就要问清，写进 prompt 的就当铁的事实）：
【创建时你要做对的】
- 自包含：写清背景与目标，不要用"这个/那个/上面说的"等指代；
- 时间口径用相对锚点（"昨天"=执行日的前一天，"本周"=执行日所在周），系统会按执行当天解析，不要写死日期；
- 完成标准可判定：如"在工作区生成 质量日报-MMdd.xlsx 且包含汇总与明细两个表"；
- 边界写清：业务库只读、工作区文件可写（/workspace/ 下）、需要人工审批的业务写操作会被自动跳过并记录在结论里；
- 推送约定当场确认：用户提到"通知我/发给某人/发到群里"时，创建前先把三要素问清并写进任务 prompt——通道（工作通知到个人 / 机器人单聊 / 群消息）、接收人（userId 或群标识）、详略（仅摘要，或摘要+全文文件路径）。
【要写进任务 prompt、给触发后的执行者看的】
- 结尾输出 3-5 句给用户看的结论摘要，数据说话；
- 触达用户：用户不会守着对话等结果——约定了推送的，结尾把摘要顺手经能力目录里的推送类工具（/mcp/ 下，如钉钉群机器人推送）发给约定的接收人或群；推不出去（通道没配、调用失败）是常事，不影响任务本身，结论里如实记一句即可，会话里的完整结果用户随时可查。批量事项合并成一条推，执行过程中不推；长报告正文落工作区文件，消息里给摘要+关键数字+文件路径。`.trim()

interface CronCreateInput {
  name: string
  cron_expression?: string
  run_at?: string
  prompt: string
  enabled?: boolean
}

interface CronCreateOutput {
  content: string
  taskId?: string
  created: boolean
}

export function createCronCreateTool(): Tool<CronCreateInput, CronCreateOutput> {
  return {
    name: CRON_CREATE_TOOL_NAME,
    description:
      '创建一个定时任务：到点自动派遣一个后台 Agent 在新会话中执行任务（可用工具、可读写工作区、可查业务数据），' +
      '结果以完整对话形式出现在会话列表，用户可打开查看并接着提问。' +
      '周期性需求（"每天早上/每周五/每小时…"）用 cron_expression；单次需求（"明天下午3点/8月10号上午9点做一次…"）用 run_at，执行一次后自动停用。' +
      '调用前先把调度时间的人话含义和任务 prompt 给用户确认，确认后再创建。\n' +
      PROMPT_GUIDE,
    inputSchema: {
      type: 'object',
      required: ['name', 'prompt'],
      properties: {
        name: {
          type: 'string',
          description: '任务名（也是结果会话的标题），一句话说清干什么，如"每日密炼质量整理"。',
        },
        cron_expression: {
          type: 'string',
          description:
            '周期任务的调度：标准 5 段 cron 表达式（分 时 日 月 周），本地时区。如每天早上8点="0 8 * * *"；每周五下午5点="0 17 * * * 5"；每小时="0 * * * *"。与 run_at 二选一。',
        },
        run_at: {
          type: 'string',
          description:
            '单次任务的执行时刻：本地时间 "YYYY-MM-DD HH:mm"（如 "2026-08-06 08:00"），必须是将来的时刻。与 cron_expression 二选一。',
        },
        prompt: {
          type: 'string',
          description: '任务 prompt：按工具描述里的撰写要求生成，自包含、时间相对锚点、完成标准可判定、边界写清。',
        },
        enabled: {
          type: 'boolean',
          description: '是否立即启用（默认 true）。',
          default: true,
        },
      },
    },
    riskLevel: 'standard',
    isReadOnly: false,
    isConcurrencySafe: true,
    isDestructive: false,
    alwaysLoad: true,
    maxResultSizeChars: 4000,

    execute: async (input: CronCreateInput, _ctx: ToolExecutionContext): Promise<CronCreateOutput> => {
      if (!input.prompt?.trim()) {
        return { content: '缺少任务 prompt。', created: false }
      }
      if (!input.name?.trim()) {
        return { content: '缺少任务名。', created: false }
      }

      // 调度二选一：run_at（单次，精确分钟 cron + payload.once）或 cron_expression（周期）
      const runAtRaw = input.run_at?.trim()
      const cronRaw = input.cron_expression?.trim()
      if (!runAtRaw && !cronRaw) {
        return { content: '缺少调度：周期任务给 cron_expression，单次任务给 run_at。', created: false }
      }
      if (runAtRaw && cronRaw) {
        return { content: 'cron_expression 与 run_at 只能给一个（周期用前者，单次用后者）。', created: false }
      }

      const enabled = input.enabled !== false
      let expression: string
      let once = false
      let nextRunAt: string | undefined
      let scheduleDesc: string

      if (runAtRaw) {
        // 兼容 "YYYY-MM-DD HH:mm"（空格转 T 后按本地时间解析）
        const at = new Date(runAtRaw.includes('T') ? runAtRaw : runAtRaw.replace(' ', 'T'))
        if (Number.isNaN(at.getTime())) {
          return { content: `run_at 无法解析："${runAtRaw}"。应为本地时间 "YYYY-MM-DD HH:mm"，如 "2026-08-06 08:00"。`, created: false }
        }
        if (at.getTime() <= Date.now()) {
          return { content: `run_at 必须是将来的时刻（收到 ${at.toLocaleString('zh-CN', { hour12: false })}，已过去）。`, created: false }
        }
        expression = `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *`
        once = true
        nextRunAt = enabled ? at.toISOString() : undefined
        scheduleDesc = `单次，${at.toLocaleString('zh-CN', { hour12: false })} 执行一次后自动停用`
      } else {
        expression = cronRaw!
        try {
          nextRunAt = enabled
            ? CronExpressionParser.parse(expression).next().toISOString() ?? undefined
            : undefined
        } catch {
          return {
            content: `cron 表达式无法解析："${expression}"。应为标准 5 段格式（分 时 日 月 周），如 "0 8 * * *"。`,
            created: false,
          }
        }
        scheduleDesc = `周期：${expression}（本地时区）`
      }

      try {
        const task = await cronApi.createTask({
          name: input.name.trim(),
          cron: { expression },
          payload: { execution_mode: 'agent_prompt', prompt: input.prompt.trim(), ...(once ? { once: true } : {}) },
          is_enabled: enabled,
          next_run_at: nextRunAt,
        })
        await refreshSchedulerTasks()
        const next = task.next_run_at
          ? new Date(task.next_run_at).toLocaleString('zh-CN', { hour12: false })
          : '未知'
        return {
          content:
            `定时任务已创建：「${task.name}」（id: ${task.id}）。\n` +
            `调度：${scheduleDesc}，下次执行：${next}。\n` +
            '到点后会自动开始一个新会话执行任务，结果出现在会话列表里。',
          taskId: task.id,
          created: true,
        }
      } catch (err) {
        return {
          content: `创建失败：${err instanceof Error ? err.message : String(err)}`,
          created: false,
        }
      }
    },
  }
}

interface CronListOutput {
  content: string
  count: number
}

export function createCronListTool(): Tool<Record<string, never>, CronListOutput> {
  return {
    name: CRON_LIST_TOOL_NAME,
    description:
      '列出全部定时任务（名称、调度、启用状态、下次执行时间、最近执行结果）。' +
      '用户问"我有哪些定时任务/那个任务还在跑吗"，或要修改/删除任务前先查 id 时使用。',
    inputSchema: { type: 'object', properties: {} },
    riskLevel: 'read_only',
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    alwaysLoad: true,
    maxResultSizeChars: 8000,

    execute: async (): Promise<CronListOutput> => {
      try {
        const tasks = await cronApi.getTasks()
        if (tasks.length === 0) {
          return { content: '当前没有任何定时任务。', count: 0 }
        }
        const lines = tasks.map((t) => {
          const next = t.next_run_at
            ? new Date(t.next_run_at).toLocaleString('zh-CN', { hour12: false })
            : '—'
          const last = t.last_run_at
            ? `，上次执行：${new Date(t.last_run_at).toLocaleString('zh-CN', { hour12: false })}${t.status ? `（${t.status}）` : ''}`
            : ''
          const onceTag = t.payload?.once ? '｜单次' : ''
          return `- 「${t.name}」id: ${t.id}｜${t.is_enabled ? '启用' : '停用'}${onceTag}｜${t.cron?.expression ?? '—'}｜下次：${next}${last}`
        })
        return { content: `共 ${tasks.length} 个定时任务：\n${lines.join('\n')}`, count: tasks.length }
      } catch (err) {
        return {
          content: `查询失败：${err instanceof Error ? err.message : String(err)}`,
          count: 0,
        }
      }
    },
  }
}

interface CronToggleInput {
  task_id: string
}
interface CronToggleOutput {
  content: string
  enabled?: boolean
}

export function createCronToggleTool(): Tool<CronToggleInput, CronToggleOutput> {
  return {
    name: CRON_TOGGLE_TOOL_NAME,
    description:
      '启用/停用某个定时任务（状态翻转，任务保留）。用户说"先停一下那个任务/恢复那个任务"时使用；' +
      'task_id 从 cron_list 结果中取。',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string', description: '任务 id（cron_list 结果中携带）。' },
      },
    },
    riskLevel: 'standard',
    isReadOnly: false,
    isConcurrencySafe: true,
    isDestructive: false,
    alwaysLoad: true,
    maxResultSizeChars: 2000,

    execute: async (input: CronToggleInput): Promise<CronToggleOutput> => {
      try {
        // 走 store 而非裸 cronApi：启用时由 store 预算 next_run_at 随请求带上
        // （服务端 NCrontab 以 UTC 为基准偏时区），且内存清单/唤醒定时器同步重排
        const { useCronSchedulerStore } = await import('@/stores/cronSchedulerStore')
        const task = await useCronSchedulerStore.getState().toggleTask(input.task_id)
        if (!task) {
          return { content: `操作失败：任务 ${input.task_id} 不存在或切换出错（task_id 可从 cron_list 查询确认）` }
        }
        return {
          content: `「${task.name}」已${task.is_enabled ? '启用' : '停用'}。`,
          enabled: task.is_enabled,
        }
      } catch (err) {
        return {
          content: `操作失败：${err instanceof Error ? err.message : String(err)}（task_id 可从 cron_list 查询确认）`,
        }
      }
    },
  }
}

interface CronUpdateInput {
  task_id: string
  name?: string
  cron_expression?: string
  run_at?: string
  prompt?: string
  enabled?: boolean
}

interface CronUpdateOutput {
  content: string
  updated: boolean
}

export function createCronUpdateTool(): Tool<CronUpdateInput, CronUpdateOutput> {
  return {
    name: CRON_UPDATE_TOOL_NAME,
    description:
      '修改已有定时任务：改名、改调度（周期 cron_expression 或单次 run_at，二选一）、改任务 prompt、启停。' +
      '用户说"把那个任务改成9点/换个时间/改下内容"时使用；task_id 从 cron_list 结果中取。' +
      '调用前把要改的点给用户确认，确认后再改。' +
      '改任务 prompt 时同样遵循 cron_create 的撰写要求（自包含、相对时间锚点、约定了推送就把通道/接收人/详略写清）。',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string', description: '任务 id（cron_list 结果中携带）。' },
        name: { type: 'string', description: '新任务名。' },
        cron_expression: {
          type: 'string',
          description: '改为周期调度：标准 5 段 cron（分 时 日 月 周），本地时区。与 run_at 二选一。',
        },
        run_at: {
          type: 'string',
          description: '改为单次执行：本地时间 "YYYY-MM-DD HH:mm"，必须是将来的时刻。与 cron_expression 二选一。',
        },
        prompt: {
          type: 'string',
          description: '新任务 prompt（要求同 cron_create：自包含、时间相对锚点、完成标准可判定、边界写清）。',
        },
        enabled: { type: 'boolean', description: '启用/停用。' },
      },
    },
    riskLevel: 'standard',
    isReadOnly: false,
    isConcurrencySafe: true,
    isDestructive: false,
    alwaysLoad: true,
    maxResultSizeChars: 2000,

    execute: async (input: CronUpdateInput): Promise<CronUpdateOutput> => {
      try {
        const current = (await cronApi.getTasks()).find((t) => t.id === input.task_id)
        if (!current) {
          return { content: `任务 ${input.task_id} 不存在（task_id 可从 cron_list 查询确认）。`, updated: false }
        }

        const runAtRaw = input.run_at?.trim()
        const cronRaw = input.cron_expression?.trim()
        if (runAtRaw && cronRaw) {
          return { content: 'cron_expression 与 run_at 只能给一个（周期用前者，单次用后者）。', updated: false }
        }

        const updates: Partial<CronTask> = {}
        const changeNotes: string[] = []
        if (input.name?.trim() && input.name.trim() !== current.name) {
          updates.name = input.name.trim()
          changeNotes.push(`名称→「${updates.name}」`)
        }
        if (input.enabled !== undefined && input.enabled !== (current.is_enabled ?? true)) {
          updates.is_enabled = input.enabled
          changeNotes.push(input.enabled ? '启用' : '停用')
        }

        // payload 后端全量替换——一律从现值合并；调度切换时同步摘/挂单次标记
        let payload: NonNullable<CronTask['payload']> = {
          ...(current.payload ?? { execution_mode: 'agent_prompt' }),
        }
        let payloadTouched = false

        if (cronRaw) {
          try {
            CronExpressionParser.parse(cronRaw)
          } catch {
            return {
              content: `cron 表达式无法解析："${cronRaw}"。应为标准 5 段格式（分 时 日 月 周），如 "0 8 * * *"。`,
              updated: false,
            }
          }
          updates.cron = { expression: cronRaw }
          if (payload.once) {
            payload = { ...payload }
            delete payload.once // 改成周期任务，摘掉单次标记
            payloadTouched = true
          }
          changeNotes.push(`调度→周期 ${cronRaw}`)
        } else if (runAtRaw) {
          const at = new Date(runAtRaw.includes('T') ? runAtRaw : runAtRaw.replace(' ', 'T'))
          if (Number.isNaN(at.getTime())) {
            return { content: `run_at 无法解析："${runAtRaw}"。应为本地时间 "YYYY-MM-DD HH:mm"。`, updated: false }
          }
          if (at.getTime() <= Date.now()) {
            return { content: `run_at 必须是将来的时刻（收到 ${at.toLocaleString('zh-CN', { hour12: false })}，已过去）。`, updated: false }
          }
          updates.cron = { expression: `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *` }
          updates.next_run_at = at.toISOString() // 精确时刻显式给定，store 预算不覆盖
          if (!payload.once) {
            payload = { ...payload, once: true }
            payloadTouched = true
          }
          changeNotes.push(`调度→单次 ${at.toLocaleString('zh-CN', { hour12: false })}`)
        }

        if (input.prompt?.trim()) {
          payload = { ...payload, prompt: input.prompt.trim() }
          payloadTouched = true
          changeNotes.push('任务 prompt 已更新')
        }
        if (payloadTouched) {
          updates.payload = payload
        }

        if (Object.keys(updates).length === 0) {
          return { content: '没有要修改的字段（与现值相同或未提供）。', updated: false }
        }

        // 走 store 而非裸 cronApi：cron/启停变更时由 store 预算 next_run_at 随请求带上
        // （服务端 NCrontab 以 UTC 为基准偏时区），内存清单/唤醒定时器同步重排
        const { useCronSchedulerStore } = await import('@/stores/cronSchedulerStore')
        const updated = await useCronSchedulerStore.getState().updateTask(input.task_id, updates)
        if (!updated) {
          return { content: '更新失败（详见界面错误提示）。', updated: false }
        }
        const next = updated.next_run_at
          ? new Date(updated.next_run_at).toLocaleString('zh-CN', { hour12: false })
          : '—'
        return {
          content: `「${updated.name}」已更新：${changeNotes.join('、')}。下次执行：${next}。`,
          updated: true,
        }
      } catch (err) {
        return {
          content: `更新失败：${err instanceof Error ? err.message : String(err)}`,
          updated: false,
        }
      }
    },
  }
}

interface CronDeleteInput {
  task_id: string
}interface CronDeleteOutput {
  content: string
  deleted: boolean
}

export function createCronDeleteTool(): Tool<CronDeleteInput, CronDeleteOutput> {
  return {
    name: CRON_DELETE_TOOL_NAME,
    description:
      '永久删除某个定时任务（不可恢复；已产生的历史会话不受影响）。' +
      '用户明确说"删掉/取消那个任务"时使用；只是想暂停请用 cron_toggle。task_id 从 cron_list 结果中取。',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string', description: '任务 id（cron_list 结果中携带）。' },
      },
    },
    riskLevel: 'standard',
    isReadOnly: false,
    isConcurrencySafe: true,
    isDestructive: true,
    alwaysLoad: true,
    maxResultSizeChars: 2000,

    execute: async (input: CronDeleteInput): Promise<CronDeleteOutput> => {
      try {
        await cronApi.deleteTask(input.task_id)
        await refreshSchedulerTasks()
        return { content: `任务 ${input.task_id} 已删除。`, deleted: true }
      } catch (err) {
        return {
          content: `删除失败：${err instanceof Error ? err.message : String(err)}（task_id 可从 cron_list 查询确认）`,
          deleted: false,
        }
      }
    },
  }
}
