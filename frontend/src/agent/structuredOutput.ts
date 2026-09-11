import type { Tool } from '@/agent/types'
import type { AgenticLoopHandle } from '@/agent/agenticLoop'

/**
 * StructuredOutput 机制（2026-08-03 W1 基础设施，借鉴 claude-code SyntheticOutputTool 三件套；
 * 同日经五路盲猜实验修订：熔断语义/挂点/文案/幂等/自检）。
 *
 * 解决的问题：双 Agent 范式里"状态对象"必须由模型产出、又要形态可信——
 * 没有 schema 强制，状态就是模型随手写的 JSON，下游（另一个 agent / 确定性代码）不敢消费。
 *
 * 三件套：
 * ①动态 schema 工具（submit_state）：inputSchema=调用方给的状态 schema，execute 时校验，
 *   校验失败把带字段路径的错误清单作为工具结果回给模型——纠偏回路不靠硬失败，
 *   靠"违反原因回喂"让模型自我修正；
 * ②Stop-hook 等价物：onTurnFinish（loop 终态判定回调）检测到自然收尾但尚未提交时，
 *   经 supplement 注入系统反馈把子 Agent 顶回去继续（复用既有补充通道，零 loop 手术）；
 * ③重试熔断（claude-code 同款语义）：预算计"submit_state 调用次数"（含校验失败），
 *   不是顶回次数——校验失败的死循环同样烧预算；顶回另设小上限。耗尽后放行结束，
 *   运行体把"未提交"如实标为失败终态。
 *
 * 校验器是最小子集手写实现（type/required/properties/items/enum/additionalProperties 等），
 * 不引 ajv——状态 schema 都是我们自定的简单结构，子集足够，零依赖零构建风险。
 * 与执行器前置校验互补：minItems/maxItems 只有这里查，其余两边都会查（双重兜底）。
 */

/** 状态对象 JSON Schema 的最小子集类型（自解析，避免引入外部 schema 类型） */
export interface StateSchema {
  type?: string
  properties?: Record<string, StateSchema>
  required?: string[]
  items?: StateSchema
  enum?: unknown[]
  additionalProperties?: boolean
  minItems?: number
  maxItems?: number
  minLength?: number
  maxLength?: number
  description?: string
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

/** 校验 value 是否符合 schema，返回错误清单（空数组=通过）。path 用于错误定位。 */
export function validateStateSchema(schema: StateSchema, value: unknown, path = ''): string[] {
  const errors: string[] = []
  const at = path || '(根)'

  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${at}: 值不在枚举内（允许：${schema.enum.map((e) => JSON.stringify(e)).join('/')}）`)
    return errors
  }

  if (schema.type) {
    const actual = typeOf(value)
    // integer 兼容 number 声明；number 声明接受 integer 值
    const typeOk =
      schema.type === actual ||
      (schema.type === 'number' && actual === 'integer') ||
      (schema.type === 'integer' && actual === 'integer')
    if (!typeOk) {
      errors.push(`${at}: 类型应为 ${schema.type}，实际是 ${actual}`)
      return errors // 类型不对后续校验无意义
    }
  }

  if (schema.type === 'object' || schema.properties) {
    const obj = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (!(key in obj) || obj[key] === undefined || obj[key] === null) {
        errors.push(`${at}: 缺少必填字段 "${key}"`)
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
      if (obj[key] !== undefined) errors.push(...validateStateSchema(propSchema, obj[key], `${path}.${key}`))
    }
    if (schema.additionalProperties === false && schema.properties) {
      const extra = Object.keys(obj).filter((k) => !(k in (schema.properties ?? {})))
      if (extra.length > 0) errors.push(`${at}: 多出未声明字段 ${extra.map((k) => `"${k}"`).join('、')}，请移除`)
    }
  }

  if ((schema.type === 'array' || schema.items) && Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push(`${at}: 数组至少 ${schema.minItems} 项，实际 ${value.length} 项`)
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      errors.push(`${at}: 数组最多 ${schema.maxItems} 项，实际 ${value.length} 项`)
    }
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validateStateSchema(schema.items!, item, `${path}[${i}]`)))
    }
  }

  if (schema.type === 'string' && typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push(`${at}: 字符串至少 ${schema.minLength} 字，实际 ${value.length} 字`)
    }
    if (schema.maxLength != null && value.length > schema.maxLength) {
      errors.push(`${at}: 字符串最多 ${schema.maxLength} 字，实际 ${value.length} 字`)
    }
  }

  return errors
}

/**
 * 创建期 schema 本体自检（claude-code ajv.validateSchema 同款）：
 * 模型/调用方给的 schema 若是废稿，在派遣前就拒掉，不进 loop 空烧轮次。
 * 返回 null=合法，否则返回错误说明。
 */
export function validateSchemaSpec(schema: unknown): string | null {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return 'structured_output_schema 必须是一个 JSON Schema 对象'
  }
  const s = schema as StateSchema
  if (s.type !== undefined && typeof s.type !== 'string') return 'schema.type 必须是字符串'
  if (s.type !== 'object' && s.properties === undefined) {
    return '状态对象 schema 的顶层应为 { type: "object", properties: {...} }'
  }
  if (s.properties !== undefined && (typeof s.properties !== 'object' || s.properties === null)) {
    return 'schema.properties 必须是对象'
  }
  if (s.required !== undefined && !Array.isArray(s.required)) return 'schema.required 必须是字符串数组'
  return null
}

export interface StructuredOutputSpec {
  /** 状态对象 schema（submit_state 的 inputSchema 原样使用） */
  schema: StateSchema
  /** 提交工具名，缺省 submit_state */
  toolName?: string
  /** 工具描述（向模型说明提交物的语义），缺省给通用文案 */
  description?: string
  /** 顶回熔断次数（自然收尾未提交的顶回上限），缺省 3 */
  maxReminders?: number
  /** 提交尝试预算（含校验失败的调用次数，claude-code MAX_STRUCTURED_OUTPUT_RETRIES 同款语义），缺省 5 */
  maxRetries?: number
  /** 顶回发生时的进度透传（运行体接 setLiveLine，防"卡死"误判与用户误杀） */
  onReminder?: (reminderCount: number, maxReminders: number) => void
}

export interface StructuredOutputEnforcer {
  /** 注册进子注册表的动态 schema 工具 */
  tool: Tool<unknown, unknown>
  /** Stop-hook 等价物：接 loop 的 onTurnFinish（自然收尾判定回调） */
  onTurnFinish: (assistant: { toolCalls?: unknown[] }, handle: AgenticLoopHandle) => void
  /** 是否已成功提交 */
  isSubmitted: () => boolean
  /** 提交值（未提交为 undefined） */
  getValue: () => unknown
  /** 预算/顶回耗尽仍没提交 → 运行体应如实标失败终态 */
  isExhausted: () => boolean
}

export function createStructuredOutputEnforcer(spec: StructuredOutputSpec): StructuredOutputEnforcer {
  const toolName = spec.toolName ?? 'submit_state'
  const maxRetries = spec.maxRetries ?? 5
  const maxReminders = spec.maxReminders ?? 3
  let submitted = false
  let value: unknown
  /** 提交尝试计数（成功+校验失败都算——claude-code 同款：死循环校验同样烧预算） */
  let submitCalls = 0
  let reminders = 0
  /** 最近一次校验失败清单（顶回时附诊断，模型不用猜"是没调用还是没通过"） */
  let lastErrors: string[] = []

  const tool: Tool<unknown, unknown> = {
    name: toolName,
    description:
      spec.description ??
      '提交任务要求的结构化状态对象——任务的最终交付物，整个任务只应成功提交一次。' +
        '内容必须符合参数 schema，校验失败会返回带字段位置的错误清单，修正后重新提交。' +
        '成功提交即代表你确认任务已全部完成；之后再收到的补充消息按新工作处理，不要重复提交。',
    inputSchema: spec.schema,
    riskLevel: 'standard',
    // 只写运行体内存（不碰文件/数据/外部系统）：标只读，sandbox 模式才不会误杀
    // （2026-08-03 五路实验 2 号发现：非只读在 sandbox 被一刀切 deny → 结构化交付必败）
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    // confirm 模式下审批卡的影响陈述（confirm 既定行为=一切皆确认，至少让卡片说人话）
    impactStatement: '提交子任务的最终结果（不改动任何文件或数据）',
    maxResultSizeChars: 4000,
    alwaysLoad: true,
    execute: async (input: unknown) => {
      submitCalls += 1
      const errors = validateStateSchema(spec.schema, input)
      if (errors.length > 0) {
        lastErrors = errors
        const budgetLeft = maxRetries - submitCalls
        if (budgetLeft <= 0) {
          // 预算耗尽：明确告知别再试了，走降级交付——逼模型继续只会造假
          return {
            success: false,
            error:
              `提交仍未通过校验，且补交次数已用完（${maxRetries} 次）。请不要再调用 ${toolName}，` +
              '改用普通文本如实说明：已完成什么、哪部分无法按规定格式交付、原因是什么，然后结束任务。',
          }
        }
        // 纠偏回路：带字段位置的错误清单回喂模型，不是硬失败
        return {
          success: false,
          error:
            `提交未通过校验（${errors.length} 处问题，还可补交 ${budgetLeft} 次）。请按下述清单修正后重新调用 ${toolName}：\n` +
            errors.map((e) => `- ${e}`).join('\n'),
        }
      }
      lastErrors = []
      const isResubmit = submitted
      submitted = true
      value = input
      return {
        success: true,
        content: isResubmit
          ? '已收到新的提交并覆盖先前版本（以最新为准）。任务交付完成，请用一两句话向调用方总结要点后结束。'
          : '结构化状态已提交并通过校验。任务交付完成，请用一两句话向调用方总结要点后结束。',
      }
    },
  }

  return {
    tool,
    onTurnFinish: (assistant, handle) => {
      // 自然收尾=无工具调用；已提交或预算耗尽（失败工具结果已给降级指引）不再顶回
      const hasToolCalls = Array.isArray(assistant.toolCalls) && assistant.toolCalls.length > 0
      if (hasToolCalls || submitted || reminders >= maxReminders || submitCalls >= maxRetries) return
      reminders += 1
      spec.onReminder?.(reminders, maxReminders)
      // 文案纪律（3 号模型实验+claude-code 对照收敛）：不带"N/M 计数"（预告骚扰是负资产），
      // 统一【系统反馈】前缀（模型能识别非用户输入），附上次失败诊断；最后一次给降级出口
      const diagnosis =
        lastErrors.length > 0
          ? `你上一次的提交未通过校验：${lastErrors[0]}${lastErrors.length > 1 ? ` 等 ${lastErrors.length} 处问题` : ''}。请按工具返回的完整清单修正后重新提交。`
          : '你的上一条消息是要结束任务，但还没有检测到提交动作。'
      const degrade =
        reminders >= maxReminders
          ? '如果确实无法按规定格式提交，可以用普通文本如实说明完成情况与卡点，标注【降级交付】后结束。'
          : ''
      handle.supplement(
        `【系统反馈】任务要求调用 ${toolName} 提交结构化结果，这是唯一完成标志，文本总结不能替代。` +
          diagnosis +
          degrade
      )
    },
    isSubmitted: () => submitted,
    getValue: () => value,
    isExhausted: () => !submitted && (submitCalls >= maxRetries || reminders >= maxReminders),
  }
}
