import type {
  Tool,
  ToolCall,
  ToolResult,
  ToolProgressUpdate,
  ToolExecutionContext,
  ToolRiskLevel,
  ToolPermissionContext,
  PermissionResult,
  PermissionRule,
} from './types'
import type { ToolInvokeResult } from '@/types/mescli'
import { fetchApi, toolApi, workspaceApi } from '@/api/client'
import { safeStringify } from '@/utils/safeSerialize'
import type { ApprovalGate, ApprovalDecision } from './approvalGate'
import type { ClarifyGate } from './clarifyGate'
import { validateJsonSchema, formatSchemaErrors } from './schemaValidator'
import { useStateKeeperStore, CONSULT_STOP_ESCALATE_THRESHOLD } from '@/stores/stateKeeperStore'
import { useShellCwdStore } from '@/stores/shellCwdStore'
import { watchCommandTask } from '@/agent/backgroundShellManager'
import { writeFile } from '@/services/fileSystem'
import { findDirectoryRuleCovering, suggestDirectoryRule } from './permissionRules'

/**
 * 目录挑战-重试链覆盖的工具（2026-09-01 P0-7 从 run_command 独享扩成全体共用）：
 * 这些工具触及未登记物理路径时，后端（或本地工具的适配器层）会产出
 * directory_not_registered 挑战，走"登记+原样重试"自愈闭环。
 */
const CHALLENGE_CAPABLE_TOOLS = new Set([
  'run_command',
  'read_file',
  'write_file',
  'str_replace',
  'list_files',
  'glob',
  'grep',
  'delete_file',
])

/**
 * 渲染工具声明的 impactStatement 模板。
 * - 函数形式：直接调用并返回结果
 * - 字符串形式：将 {key} 替换为 args 中对应值
 */
function renderImpactStatement(
  tool: Tool<unknown, unknown> | undefined,
  args: Record<string, unknown>
): string {
  if (!tool?.impactStatement) return ''
  if (typeof tool.impactStatement === 'function') {
    try {
      return tool.impactStatement(args) || ''
    } catch {
      return ''
    }
  }
  return tool.impactStatement.replace(/\{(\w+)\}/g, (_, key) => {
    return key in args ? String(args[key]) : `{${key}}`
  })
}

/** 工具参数校验：JSON Schema + 工具自定义校验 */
function validateToolInput(
  toolName: string,
  args: Record<string, unknown>,
  schema: unknown,
  customValidate?: (input: unknown) => { valid: boolean; error?: string }
): { valid: boolean; error?: string } {
  // 0. 防御性检查：required 字段不允许为空字符串（针对 Kimi Code 空参数类 bug）
  if (isObject(schema)) {
    const required = Array.isArray(schema.required) ? schema.required : []
    const emptyRequired: string[] = []
    for (const key of required) {
      if (typeof key === 'string' && key in args && args[key] === '') {
        emptyRequired.push(key)
      }
    }
    if (emptyRequired.length > 0) {
      return {
        valid: false,
        error: `工具 ${toolName} 的必需参数为空字符串: ${emptyRequired.join(', ')}。收到参数: ${safeStringify(args)}`,
      }
    }
  }

  // 1. JSON Schema 校验
  const schemaResult = validateJsonSchema(args, schema)
  if (!schemaResult.valid) {
    return {
      valid: false,
      error: `工具 ${toolName} 参数校验失败:\n${formatSchemaErrors(schemaResult.errors)}\n收到参数: ${safeStringify(args)}`,
    }
  }

  // 2. 工具自定义校验
  if (customValidate) {
    const customResult = customValidate(args)
    if (!customResult.valid) {
      return {
        valid: false,
        error: `工具 ${toolName} 自定义校验失败: ${customResult.error || '未知错误'}。收到参数: ${safeStringify(args)}`,
      }
    }
  }

  return { valid: true }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function extractOutputText(data: unknown): string | undefined {
  if (typeof data === 'string') return data
  if (!data || typeof data !== 'object') return undefined

  const obj = data as Record<string, unknown>
  if (typeof obj.content === 'string') return obj.content
  if (typeof obj.summary === 'string') return obj.summary
  if (typeof obj.message === 'string') return obj.message
  return safeStringify(data)
}

/**
 * 按工具声明的 maxResultSizeChars 限制结果文本长度，避免过大结果冲爆上下文。
 *
 * 2026-07-28 落盘兜底（信息不丢失主线）：截断前把完整结果写入
 * /workspace/outputs/tool_results/，截断文案带路径与读回指引——模型可用
 * read_file 分段阅读、grep 检索或 execute_python_script 交叉分析。
 * 此前截断即不可逆丢失，且诱发模型重复调工具重查。
 * 工具自身已落盘（persistedUrl，如 SQL 工具）时不重复落盘，直接引用原路径。
 */
async function applyResultBudget(
  result: ToolResult,
  maxChars?: number,
  toolCallId?: string
): Promise<ToolResult> {
  if (!maxChars || maxChars <= 0) return result
  const text = result.outputText ?? safeStringify(result.output)
  if (text.length <= maxChars) return result

  const makePointer = (path: string) =>
    `\n\n[结果过大已截断（共 ${text.length} 字符）。完整内容已保存到 ${path}，` +
    `可用 read_file（带 offset/limit 参数）分段阅读、grep 检索或 execute_python_script 交叉分析，请勿重复执行本工具]`

  if (result.persistedUrl) {
    return {
      ...result,
      outputText: text.slice(0, maxChars) + makePointer(result.persistedUrl),
      isTruncated: true,
    }
  }

  let persistedUrl: string | undefined
  let pointer: string
  try {
    const safeId = (toolCallId ?? `tr-${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, '_')
    persistedUrl = `/workspace/outputs/tool_results/${safeId}.txt`
    await writeFile(persistedUrl, text)
    pointer = makePointer(persistedUrl)
  } catch (err) {
    // 落盘失败退化为旧行为（纯截断），不阻断工具结果返回
    console.warn('[toolExecutor] 大结果落盘失败，退化为纯截断:', err)
    persistedUrl = undefined
    pointer = '\n\n[...结果已截断...]'
  }

  return {
    ...result,
    outputText: text.slice(0, maxChars) + pointer,
    isTruncated: true,
    persistedUrl,
  }
}

import { FrontendToolRegistry, evaluateToolFlag } from './toolRegistry'

/**
 * 工具执行门面（2026-09-09 起仅 chat 车道——旧 DAG 执行体系已随两族下线删除）
 *
 * - chat 路径：后端 SSE 驱动（MESCLI）或前端本地工具实现；未识别工具返回 graceful 错误。
 */

export type ToolExecutionContextType = 'chat'

export interface ExecuteToolOptions {
  contextType: ToolExecutionContextType
  toolName: string
  args: Record<string, unknown>
  toolCallId: string
  conversationId?: number
  systemCode?: string
  /** 当前对话轮次的真实用户原话。 */
  userMessage?: string
  /** 默认 120000ms，与统一工具执行超时对齐 */
  timeoutMs?: number
  abortSignal?: AbortSignal
  onProgress?: (update: ToolProgressUpdate) => void
  /** 审批闸；高风险写工具会暂停等待用户确认 */
  approvalGate?: ApprovalGate
  /** 反问闸；ask_user 等交互工具会暂停等待用户作答 */
  clarifyGate?: ClarifyGate
  /** 当前会话已批准的审批决策，调用后端工具时回传 */
  approvalDecisions?: ApprovalDecision[]
  /** 权限上下文；缺省时按工具 riskLevel 与 executionMode 兜底 */
  permissionContext?: ToolPermissionContext
}

export interface ExecuteBatchOptions {
  calls: ToolCall[]
  contextType: ToolExecutionContextType
  /** 将 ToolCall 映射到实际执行参数 */
  getArguments: (call: ToolCall) => Record<string, unknown>
  /** 公共上下文，不含 contextType / toolName / args / toolCallId */
  commonContext: Omit<ExecuteToolOptions, 'contextType' | 'toolName' | 'args' | 'toolCallId'>
}

export interface ToolExecutor {
  execute(options: ExecuteToolOptions): Promise<ToolResult>
  executeBatch(options: ExecuteBatchOptions): Promise<ToolResult[]>
}

const DEFAULT_TIMEOUT_MS = 120000
/** 审批请求默认有效期（5 分钟），与后端超时对齐 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

/** routeExecute 的统一返回形状 */
interface RouteExecuteResult {
  success: boolean
  data?: unknown
  structuredData?: unknown
  isTruncated?: boolean
  persistedUrl?: string
  error?: string
}

/**
 * 从后端结构化错误中读取目录授权挑战（run_command 未登记 cwd 的环境事实报告，
 * 2026-08-31 前后端职责切分）；非挑战返回 null。命令未执行，登记后重试无副作用。
 */
function readDirectoryChallenge(
  structuredData: unknown
): { path: string; exists: boolean; directory?: string | null } | null {
  if (!structuredData || typeof structuredData !== 'object') return null
  const sd = structuredData as Record<string, unknown>
  if (sd.error_code !== 'directory_not_registered') return null
  const path = sd.path
  if (typeof path !== 'string' || !path) return null
  // directory（2026-09-04）：后端算好的"建议登记目录"（文件取父目录）——登记授权是
  // 目录粒度，拿文件路径登记会被后端 Directory.Exists 校验 400（read_file 首次必败根因）
  const directory =
    sd.directory === null
      ? null // 后端显式置 null（2026-09-04）：父链上溯不到可登记目录，不应再尝试登记
      : typeof sd.directory === 'string' && sd.directory
        ? sd.directory
        : undefined
  return { path, exists: sd.exists !== false, directory }
}

function reportProgress(
  onProgress: ((update: ToolProgressUpdate) => void) | undefined,
  update: ToolProgressUpdate
): void {
  try {
    onProgress?.(update)
  } catch {
    // 忽略回调异常，避免影响主流程
  }
}

function createTimeoutController(timeoutMs: number): AbortController {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`工具调用超时（${timeoutMs}ms）`))
  }, timeoutMs)
  // 清理 timer：当 abort 被外部触发时也清理
  const cleanup = () => clearTimeout(timer)
  controller.signal.addEventListener('abort', cleanup, { once: true })
  return controller
}

/**
 * 小结构化回执并入模型可见文本（2026-08-13 回执交接断点修复）。
 *
 * 背景：后端 ToolResult.Ok(text, structuredData) 的设计意图是 structuredData 供机器
 * 消费，但模型可见的只有 text——confirm_and_schedule 的 plan_id、next_action 这类
 * "交接钥匙"曾因此对模型不可见（模型只能空调用 get_status 报"plan_id 不能为空"）。
 * 主 Agent 是结构化回执最重要的消费者，小负载应可见：
 * - 只附小负载（≤800 字符）：回执型（id/状态/下一步）才需要进上下文；
 *   数据型大负载走落盘/文本内嵌约定，不重复进上下文；
 * - 文本已内嵌 JSON 标记（WONWORK_JSON_RESULT）的跳过——那是工具自己的内嵌约定；
 * - 已在文本中出现的跳过（防重复）。
 */
function appendStructuredReceipt(text: string, structuredData: unknown): string {
  if (structuredData == null || typeof structuredData === 'string') return text
  if (text.includes('WONWORK_JSON_RESULT_START')) return text
  let compact: string
  try {
    compact = JSON.stringify(structuredData)
  } catch {
    return text
  }
  if (!compact || compact === '{}' || compact === '[]' || compact.length > 800) return text
  if (text.includes(compact)) return text
  return `${text}\n\n回执数据：${compact}`
}

function combineSignals(externalSignal?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  if (!externalSignal) {
    return { signal: new AbortController().signal, dispose: () => {} }
  }
  const controller = new AbortController()
  const handler = () => controller.abort(externalSignal.reason)
  if (externalSignal.aborted) {
    controller.abort(externalSignal.reason)
  } else {
    externalSignal.addEventListener('abort', handler, { once: true })
  }
  return {
    signal: controller.signal,
    dispose: () => externalSignal.removeEventListener('abort', handler),
  }
}

/** 工具并发上限（借鉴 claude-code：避免同时触发过多子进程/网络请求） */
const MAX_CONCURRENT_TOOLS = 10

class Semaphore {
  private queue: (() => void)[] = []
  private count: number

  constructor(count: number) {
    this.count = count
  }

  acquire(): Promise<() => void> {
    if (this.count > 0) {
      this.count--
      return Promise.resolve(() => this.release())
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.count--
        resolve(() => this.release())
      })
    })
  }

  private release(): void {
    this.count++
    const next = this.queue.shift()
    next?.()
  }
}

/**
 * 创建与父 signal 联动的子 AbortController。
 * 父 signal abort 时子也会 abort；子 abort 时自动解除对父的监听，避免泄漏。
 */
export function createChildAbortController(parentSignal?: AbortSignal): AbortController {
  const child = new AbortController()
  if (!parentSignal) return child

  const onParentAbort = () => child.abort(parentSignal.reason)
  if (parentSignal.aborted) {
    child.abort(parentSignal.reason)
  } else {
    parentSignal.addEventListener('abort', onParentAbort, { once: true })
    child.signal.addEventListener(
      'abort',
      () => parentSignal.removeEventListener('abort', onParentAbort),
      { once: true }
    )
  }
  return child
}

function matchPermissionRule(toolName: string, rule: PermissionRule): boolean {
  if (typeof rule.pattern === 'string') {
    const lowerPattern = rule.pattern.toLowerCase()
    const lowerName = toolName.toLowerCase()
    return lowerName === lowerPattern || lowerName.includes(lowerPattern)
  }
  return rule.pattern.test(toolName)
}

function evaluatePermissionRules(
  toolName: string,
  rules?: PermissionRule[]
): PermissionRule['behavior'] | undefined {
  if (!rules) return undefined
  for (const rule of rules) {
    if (matchPermissionRule(toolName, rule)) {
      return rule.behavior
    }
  }
  return undefined
}

/**
 * 综合工具声明、自定义 checkPermissions、权限规则与模式，给出是否允许执行。
 */
function checkToolPermissions(
  tool: Tool,
  args: Record<string, unknown>,
  context?: ToolPermissionContext
): PermissionResult {
  if (!context) {
    return { allowed: true, behavior: 'allow' }
  }

  // 1. 显式拒绝优先
  const deniedBehavior = evaluatePermissionRules(tool.name, context.denyRules)
  if (deniedBehavior === 'deny') {
    return {
      allowed: false,
      behavior: 'deny',
      reason: `权限规则拒绝执行 ${tool.name}`,
    }
  }

  // 1.5 沙箱模式（打磨任务2 S1）：禁止一切非只读工具，仅次于显式拒绝
  if (context.mode === 'sandbox' && !evaluateToolFlag(tool.isReadOnly, args, false)) {
    return {
      allowed: false,
      behavior: 'deny',
      reason: `沙箱模式：禁止写入操作 ${tool.name}`,
    }
  }

  // 2. 工具自定义权限检查
  if (tool.checkPermissions) {
    try {
      const result = tool.checkPermissions(args, context)
      const behavior = result.behavior ?? (result.allowed ? 'allow' : 'deny')
      // bypass 模式（打磨任务2 S1）：自定义 ask 一律放行，destructive 与底线确认（alwaysAsk）除外。
      // 注意覆盖两种 ask 形态：allowed:true+ask 与 allowed:false+ask（如 SQL 写操作动态审批）。
      if (
        behavior === 'ask' &&
        context.mode === 'bypass' &&
        tool.riskLevel !== 'destructive' &&
        !result.alwaysAsk
      ) {
        return { allowed: true, behavior: 'allow' }
      }
      if (!result.allowed) {
        return { ...result, behavior }
      }
      if (behavior === 'ask') {
        return { ...result, behavior: 'ask' }
      }
    } catch {
      // 自定义检查异常时继续走兜底规则
    }
  }

  // 2.6 写前状态对账门控（consult_state，2026-08-08 双 agent P0）：
  // 会话存在活跃状态任务时，requiresStateConsult 写工具必须持有 state agent 的
  // proceed 回执（一次性令牌，消费后下一笔写需重新对账）；否则结构性拒绝+
  // 引导文案（read-before-write 同款"拒绝→引导→重试"模式，模型一轮即学会）。
  // 2026-08-09 三拍板：
  // S1 门分级——hardConsultToolNames（publish 类不可逆写）无活跃状态任务也拦
  //   （fail-closed，护栏不押在主 Agent 自觉上）；软门维持原 fail-open 语义；
  // S2 令牌绑定工具名——放行声明了别的工具即不可用（并行写不能拿错对账结论）；
  // S3 此处只 peek 不消费——消费推迟到工具真正执行前一刻（DefaultToolExecutor），
  //   审批被拒/后续步骤拦截时写未发生，令牌自然保留，无需"归还"。
  // 审计修正②：会话匹配两侧都必须非 null——任一侧缺会话 id 时宁可 fail-open，
  // 也不能让一条无归属令牌被任意会话的写消费。
  const sk = useStateKeeperStore.getState()
  // requiresStateConsult=前端本地写工具静态标记；consultToolNames=域装配按名挂软门
  // （后端目录工具没有标记字段，APS 写工具走这条），同一步骤同一语义
  const isHardGated = sk.hardConsultToolNames.has(tool.name)
  const isSoftGated = tool.requiresStateConsult || sk.consultToolNames.has(tool.name)
  if ((isHardGated || isSoftGated) && !context.stateConsultExempt) {
    const sameConversation =
      sk.conversationId != null &&
      context.conversationId != null &&
      sk.conversationId === context.conversationId
    const gateActive = sk.statePath != null && sameConversation
    // S1 硬门：无活跃状态任务也拦——不可逆写不许裸奔，引导先建状态护航
    if (isHardGated && !gateActive) {
      return {
        allowed: false,
        behavior: 'deny',
        reason:
          `${tool.name} 是不可逆写操作（写后没有撤销键），必须先建立状态护航：调用 agent 工具` +
          `（subagent_type='state'，state_path 如 /workspace/state/0813-排产-plan1278.txt——日期+主题+任务对象），先做【里程碑】同步建立状态，` +
          '再以【对账】开头写清动作类型、目标对象/版本、修改范围、关键参数、用户授权原话、预期状态变化、写后验证与失败去向；' +
          '对账通过（proceed 回执）后再执行本工具。',
      }
    }
    if (gateActive && !sk.peekProceedToken(tool.name)) {
      const bindingNote =
        sk.receipt?.verdict === 'proceed' && sk.receipt.actionTool && sk.receipt.actionTool !== tool.name
          ? `上次对账放行的是 ${sk.receipt.actionTool}（${sk.receipt.summary}）——不覆盖本次 ${tool.name}，请针对这笔动作重新对账。`
          : ''
      // 收敛判据（2026-08-10 体系映射 L1/L2 修复，Graph Engineering"失败路由"构件）：
      // 对账连续受阻（hold/对账失败）达阈值——继续派遣只会 ping-pong 空转，
      // 此时 deny 文案升级为"路由到人工"：带着卡点清单向用户说明状态、请其定夺，
      // 不再引导重试。这是受控循环的退出边，不是新增机制。
      const stops = sk.consultStops
      if (stops.length >= CONSULT_STOP_ESCALATE_THRESHOLD) {
        const stopList = stops
          .slice(0, CONSULT_STOP_ESCALATE_THRESHOLD)
          .map((s, i) => `${i + 1}）${s.kind === 'error' ? '对账失败' : 'hold'}：${s.summary}${s.concerns.length ? `（${s.concerns.join('；')}）` : ''}`)
          .join(' ')
        return {
          allowed: false,
          behavior: 'deny',
          reason:
            `写前对账已连续受阻 ${stops.length} 次（最近卡点：${stopList}）——` +
            '不要再派遣对账或重试本工具，继续只会原地空转。' +
            '请先向用户说明当前状态：任务进行到哪一步、卡点是什么、你已经尝试过什么解决办法；' +
            '然后请用户定夺：补充缺失的信息或授权、调整方案、还是放弃这笔写。用户给出新指示后再行动。',
        }
      }
      return {
        allowed: false,
        behavior: 'deny',
        reason:
          `写前对账（当前任务有活跃的状态维护：${sk.statePath}）：此写操作需先经状态 Agent 对账。` +
          `请调用 agent 工具（subagent_type='state'、state_path='${sk.statePath}'），task 以【对账】开头` +
          '写清动作类型、目标对象/版本、修改范围、关键参数、用户授权或业务依据、预期状态变化、写后验证与失败去向；对账通过（proceed 回执）后只重试这笔调用。' +
          bindingNote +
          (sk.receipt?.verdict === 'error'
            ? `上次对账失败了（不是还没对账）：${sk.receipt.summary}——检查 task 描述是否自足、必要时缩窄对账范围或改用后台派遣，然后重新对账。`
            : '') +
          (sk.receipt?.verdict === 'hold'
            ? `上次对账结论是 hold：${sk.receipt.summary}（${sk.receipt.concerns.join('；') || '详见回执'}）——先解决阻碍再对账。`
            : '') +
          (sk.receipt?.verdict === 'offtopic'
            ? '上次同步被判 offtopic（与该状态文件无关）：若本次写属于新主题，请换一个 state_path 新建状态文件重新对账。'
            : ''),
      }
    }
    // 门已过（peek 通过）：令牌在执行前一刻才消费，后续权限步骤照常
  }

  // 3. 显式允许
  const allowedBehavior = evaluatePermissionRules(tool.name, context.allowRules)
  if (allowedBehavior === 'allow') {
    return { allowed: true, behavior: 'allow' }
  }

  // 4. 显式询问
  const askBehavior = evaluatePermissionRules(tool.name, context.askRules)
  if (askBehavior === 'ask') {
    return {
      allowed: false,
      behavior: 'ask',
      reason: `权限规则要求对 ${tool.name} 进行确认`,
    }
  }

  // 5. 模式兜底
  if (context.mode === 'bypass' || context.canBypass) {
    return { allowed: true, behavior: 'allow' }
  }
  if (context.mode === 'confirm') {
    // 全部请求确认（打磨任务2 S1）：连只读工具也需要确认
    return {
      allowed: false,
      behavior: 'ask',
      reason: `confirm 模式下工具 ${tool.name} 需要确认`,
    }
  }

  return { allowed: true, behavior: 'allow' }
}

export class DefaultToolExecutor implements ToolExecutor {
  constructor(private registry: FrontendToolRegistry) {}

  async execute(options: ExecuteToolOptions): Promise<ToolResult> {
    const {
      contextType,
      toolName,
      args,
      toolCallId,
      timeoutMs: timeoutMsOpt,
      abortSignal,
      onProgress,
      approvalGate,
      permissionContext,
    } = options

    const startedAt = Date.now()

    // 2026-07-31 去冗余：生命周期事件（pending/running/completed）不再携带样板文案——
    // 节点状态（queued→running→done）已表达同一信息，executionLog 只保留真实输出
    // （pip 日志、web 进度、审批/超时说明等）。秒级工具不再刷"准备/开始/完成"三行。
    reportProgress(onProgress, {
      toolCallId,
      toolName,
      status: 'pending',
    })

    // 1. chat 模式下先进行权限与审批判断
    let approvalReason = ''
    let needsApproval = false
    let permissionDeniedReason: string | undefined
    let maxResultChars: number | undefined
    // P0-2 权限表：checkPermissions 给的"记住"建议，随审批单透传到审批卡
    let suggestedRule: import('./types').SuggestedPermissionRule | undefined

    if (contextType === 'chat') {
      const tool = this.registry.get(toolName)
      if (!tool) {
        return {
          toolCallId,
          name: toolName,
          success: false,
          output: null,
          outputText: `未找到工具: ${toolName}`,
          isTruncated: false,
          startedAt,
          endedAt: Date.now(),
          error: `未找到工具: ${toolName}`,
        }
      }

      maxResultChars = tool.maxResultSizeChars

      const permission = checkToolPermissions(tool, args, permissionContext)
      if (!permission.allowed) {
        if (permission.behavior === 'ask') {
          needsApproval = true
          approvalReason = permission.reason || `权限规则要求确认 ${toolName}`
          suggestedRule = permission.suggestedRule
        } else {
          permissionDeniedReason = permission.reason || `权限检查未通过: ${toolName}`
        }
      }

      const explicitlyRequiresApproval =
        tool.requiresApproval === true || tool.approvalMode === 'explicit'
      // 权限模式矩阵（2026-07-24 审计定稿，与 PERMISSION_MODE_OPTIONS 文案一一对应）：
      // ┌────────────┬─────────────────────────────────────────────────────┐
      // │ bypass     │ read_only/standard/elevated 全放行；                 │
      // │ 全部自动   │ 仅 destructive 与 checkPermissions alwaysAsk（如 SQL │
      // │            │ 写、项目首写）保留确认——底线语义，勿放宽              │
      // │ auto       │ read_only/standard（本地可逆写）放行；               │
      // │ 高风险确认 │ elevated/destructive/显式 requiresApproval 确认       │
      // │ confirm    │ checkToolPermissions 第 5 步兜底：一切调用都确认     │
      // │ sandbox    │ checkToolPermissions 第 1.5 步：非只读直接 deny      │
      // └────────────┴─────────────────────────────────────────────────────┘
      // 注意：工具真实风险随输入变化时（如 execute_sql_query），应把静态
      // riskLevel 设为 standard 并用 checkPermissions 动态判定（见
      // backendToolOverrides），否则静态标高会让读操作在 auto 下也被审批。
      const isBypass = permissionContext?.mode === 'bypass'
      const mustAsk = tool.riskLevel === 'destructive'
      const shouldAsk = !isBypass && (tool.riskLevel === 'elevated' || explicitlyRequiresApproval)
      if (
        !needsApproval &&
        !permissionDeniedReason &&
        (mustAsk || shouldAsk)
      ) {
        needsApproval = true
        if (!approvalReason) {
          approvalReason = tool.riskLevel === 'destructive'
            ? `工具 ${toolName} 为破坏性操作，需要人工确认（全部自动模式下仍保留）`
            : `工具 ${toolName} 为高风险操作，需要人工确认`
        }
      }

      if (permissionDeniedReason) {
        reportProgress(onProgress, {
          toolCallId,
          toolName,
          status: 'error',
          message: permissionDeniedReason,
        })
        return {
          toolCallId,
          name: toolName,
          success: false,
          output: null,
          outputText: permissionDeniedReason,
          isTruncated: false,
          startedAt,
          endedAt: Date.now(),
          error: permissionDeniedReason,
        }
      }
    }

    if (needsApproval && contextType === 'chat' && !approvalGate) {
      const failCloseMessage = `工具 ${toolName} 需要审批，但当前 chat 上下文未提供审批 gate，执行已拒绝。`
      reportProgress(onProgress, {
        toolCallId,
        toolName,
        status: 'error',
        message: failCloseMessage,
      })
      return {
        toolCallId,
        name: toolName,
        success: false,
        output: null,
        outputText: failCloseMessage,
        isTruncated: false,
        startedAt,
        endedAt: Date.now(),
        error: failCloseMessage,
      }
    }

    if (needsApproval && approvalGate) {
      reportProgress(onProgress, {
        toolCallId,
        toolName,
        status: 'awaiting_approval',
        message: approvalReason,
      })

      const outcome = await approvalGate.requestApproval({
        toolCallId,
        toolName,
        riskLevel: (this.registry.get(toolName)?.riskLevel ?? 'standard') as ToolRiskLevel,
        impactStatement: renderImpactStatement(this.registry.get(toolName), args),
        rawParams: args,
        argumentsSummary: safeStringify(args),
        reason: approvalReason,
        requestedAt: Date.now(),
        expiresAt: Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS,
        suggestedRule,
      })
      if (!outcome.approved) {
        // 2026-07-31 区分三种否决原因，避免模型把超时/中断误读为用户拒绝而盲目重试
        const reason = outcome.reason ?? ''
        const deniedMessage = reason.includes('超时')
          ? `审批超时（5 分钟无响应），${toolName} 未被执行。这不是用户主动拒绝——如需继续，请向用户确认后重新发起该工具调用。`
          : reason.includes('中断')
            ? `用户在审批等待期间中断了会话，${toolName} 未被执行。不要重试该调用，等待用户新的指示。`
            : `用户拒绝了 ${toolName} 的执行${reason ? `（理由：${reason}）` : ''}。不要原样重试同一调用——先调整方案或参数再征得用户同意。`
        reportProgress(onProgress, {
          toolCallId,
          toolName,
          status: 'error',
          message: deniedMessage,
        })
        return {
          toolCallId,
          name: toolName,
          success: false,
          output: null,
          outputText: deniedMessage,
          isTruncated: false,
          startedAt,
          endedAt: Date.now(),
          error: deniedMessage,
        }
      }
    }

    // 令牌执行前消费（2026-08-09 S3）：步骤 2.6 只 peek——审批通过、确定要执行了
    // 才消费一次性令牌；审批被拒/权限拦截时写未发生，令牌自然保留无需归还。
    // 并行两笔写：都过了 peek，先执行者消费，后到者在此被拒并引导重新对账。
    if (contextType === 'chat' && permissionContext && !permissionContext.stateConsultExempt) {
      const gatedTool = this.registry.get(toolName)
      if (gatedTool) {
        const sk = useStateKeeperStore.getState()
        const isGated =
          gatedTool.requiresStateConsult ||
          sk.consultToolNames.has(gatedTool.name) ||
          sk.hardConsultToolNames.has(gatedTool.name)
        const gateActive =
          sk.statePath != null &&
          sk.conversationId != null &&
          permissionContext.conversationId != null &&
          sk.conversationId === permissionContext.conversationId
        if (isGated && gateActive && !sk.consumeProceedToken(gatedTool.name)) {
          const message =
            `写前对账令牌不可用（${toolName}）：对账放行是一次性的且只覆盖对账写清的那笔动作` +
            '（可能已被另一笔写消费，或上次放行的是别的工具）。请重新对账后再执行本工具。'
          reportProgress(onProgress, { toolCallId, toolName, status: 'error', message })
          return {
            toolCallId,
            name: toolName,
            success: false,
            output: null,
            outputText: message,
            isTruncated: false,
            startedAt,
            endedAt: Date.now(),
            error: message,
          }
        }
      }
    }

    reportProgress(onProgress, {
      toolCallId,
      toolName,
      status: 'running',
    })

    // 2. 构造 per-call 子 abort controller，并关联超时。
    // 超时取值优先级：显式传入 > 工具自身声明（Tool.timeoutMs，子 Agent 等长程工具
    // 必须放宽，120s 默认必然半路掐死）> 执行器默认。
    const effectiveTimeoutMs =
      timeoutMsOpt ??
      (contextType === 'chat' ? this.registry.get(toolName)?.timeoutMs : undefined) ??
      DEFAULT_TIMEOUT_MS
    const childController = createChildAbortController(abortSignal)
    const timeoutController = createTimeoutController(effectiveTimeoutMs)
    const combinedController = new AbortController()

    const onChildAbort = () => combinedController.abort(childController.signal.reason)
    const onTimeoutAbort = () => combinedController.abort(timeoutController.signal.reason)

    if (childController.signal.aborted) {
      combinedController.abort(childController.signal.reason)
    } else {
      childController.signal.addEventListener('abort', onChildAbort, { once: true })
    }
    if (timeoutController.signal.aborted) {
      combinedController.abort(timeoutController.signal.reason)
    } else {
      timeoutController.signal.addEventListener('abort', onTimeoutAbort, { once: true })
    }

    const cleanup = () => {
      childController.signal.removeEventListener('abort', onChildAbort)
      timeoutController.signal.removeEventListener('abort', onTimeoutAbort)
    }

    try {
      let result = await this.routeExecute(options, combinedController.signal, childController.signal)
      // 目录授权自愈挑战-重试（2026-08-31 前后端职责切分：后端=客观环境只报结构化
      // 事实，agent 逻辑全在前端）：预检缓存与后端登记表发散时（典型=后端重启清了
      // 会话层），后端不再硬拒死路一条，而是给 directory_not_registered 挑战，
      // 这里按权限表规则静默补登记或弹卡后重试一次（命令未执行，重试无副作用）。
      let approvedViaChallenge = false
      if (contextType === 'chat' && CHALLENGE_CAPABLE_TOOLS.has(toolName) && !result.success) {
        const healed = await this.handleDirectoryChallenge(
          result,
          options,
          combinedController.signal,
          childController.signal
        )
        result = healed.result
        approvedViaChallenge = healed.approved
      }
      // facts 项目层锚（2026-08-31 下限工程）：run_command 成功后从回执同步「当前工作目录」
      // 进 shellCwdStore——项目=你在哪干活（claude-code 语义），recall_facts 沿此目录的
      // 祖先链合并项目层事实；被动追踪零后端改动，没跑过命令=没有当前项目（诚实冷启动）。
      if (toolName === 'run_command' && result.success) {
        const cwd = (result.structuredData as { cwd?: unknown } | undefined)?.cwd
        if (typeof cwd === 'string' && cwd.trim()) {
          useShellCwdStore.getState().setCwd(cwd.trim())
        }
        // 后台回执（2026-09-01 切片2）：注册 watcher——wait 长等待接事件，
        // 完成/停滞/丢失翻译成系统通知注入归属会话（backgroundShellManager）。
        const bg = result.structuredData as
          | { background?: unknown; task_id?: unknown; output_file?: unknown }
          | undefined
        if (
          contextType === 'chat' &&
          bg?.background === true &&
          typeof bg.task_id === 'string' &&
          typeof bg.output_file === 'string'
        ) {
          watchCommandTask({
            taskId: bg.task_id,
            command: typeof options.args.command === 'string' ? options.args.command : '',
            outputPath: bg.output_file,
            conversationId: options.conversationId,
          })
        }
      }
      cleanup()
      const endedAt = Date.now()

      // 优先使用工具自身返回的字符串 data，否则从 content/summary/message 提取；
      // 带小结构化回执的并入可见文本（交接钥匙类负载对模型可见，见 appendStructuredReceipt）
      const outputText =
        typeof result.data === 'string'
          ? appendStructuredReceipt(result.data, result.structuredData)
          : extractOutputText(result.structuredData ?? result.data)

      // 审批卡确认过的调用给模型一行最小事实（2026-08-31 验收实测根因）：
      // 不作说明时模型无法区分"自动放行"与"用户点过批准"，会把审批链误判为
      // 未生效并建议用户检查配置。一行事实，不展开机制细节（needsApproval=true
      // 且走到这里 ⇒ 审批卡已被批准；被拒/超时已在前面 return）。
      const finalOutputText = needsApproval || approvedViaChallenge
        ? `${outputText}\n（本次操作经用户确认后执行）`
        : outputText

      const toolResult: ToolResult = {
        toolCallId,
        name: toolName,
        success: result.success,
        output: result.structuredData ?? result.data,
        outputText: finalOutputText,
        isTruncated: result.isTruncated ?? false,
        persistedUrl: result.persistedUrl,
        startedAt,
        endedAt,
        error: result.error,
      }

      const finalResult = await applyResultBudget(toolResult, maxResultChars, toolCallId)

      reportProgress(onProgress, {
        toolCallId,
        toolName,
        status: finalResult.success ? 'completed' : 'error',
        // 成功不刷"执行完成"（节点 done 态已表达）；错误保留文本进日志便于追溯
        message: finalResult.success ? undefined : finalResult.error,
        detail: finalResult.output,
      })
      return finalResult
    } catch (err) {
      cleanup()
      const endedAt = Date.now()
      // 用户中断（含后端调用被 fetch abort 掐断）时给干净文案，不泄漏 AbortError 原文
      const reason = combinedController.signal.aborted ? combinedController.signal.reason : undefined
      const errorMessage = combinedController.signal.aborted
        ? (reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '工具执行已中断')
        : err instanceof Error
          ? err.message
          : String(err)
      reportProgress(onProgress, {
        toolCallId,
        toolName,
        status: 'error',
        message: errorMessage,
      })
      return {
        toolCallId,
        name: toolName,
        success: false,
        output: null,
        outputText: errorMessage,
        isTruncated: false,
        startedAt,
        endedAt,
        error: errorMessage,
      }
    }
  }

  private async routeExecute(
    options: ExecuteToolOptions,
    signal: AbortSignal,
    // 用户中断专线（不含超时）：后端调用挂它，abort 关连接触发后端 RequestAborted
    // 真取消；超时仍由后端自身预算把守，前端不在半路掐长工具（2026-08-28 假取消修复）
    userCancelSignal?: AbortSignal
  ): Promise<RouteExecuteResult> {
    const { toolName, args, systemCode } = options

    const tool = this.registry.get(toolName)
    if (!tool) {
      return {
        success: false,
        error: `未找到工具: ${toolName}`,
      }
    }

    const validation = validateToolInput(toolName, args, tool.inputSchema, tool.validateInput)
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error,
      }
    }

    // 优先本地执行；没有本地实现时调用后端统一工具执行接口
    if (tool.execute) {
      const result = await tool.execute(args, {
        conversationId: options.conversationId,
        systemCode,
        abortSignal: signal,
        onProgress: options.onProgress,
        toolCallId: options.toolCallId,
        clarifyGate: options.clarifyGate,
      })

      if (result && typeof result === 'object' && 'success' in result) {
        const r = result as { success: boolean; error?: string; persistedUrl?: string }
        return {
          success: r.success,
          data: result,
          structuredData: result,
          persistedUrl: r.persistedUrl,
          error: r.error,
        }
      }

      // 约定：工具输出对象可带 persistedUrl 声明"完整内容已自行落盘于该路径"——
      // applyResultBudget 直接引用而不重复落盘（子 Agent 报告等双重落盘防护）
      return {
        success: true,
        data: result,
        structuredData: result,
        persistedUrl:
          result && typeof result === 'object'
            ? (result as { persistedUrl?: string }).persistedUrl
            : undefined,
      }
    }

    // 后端工具执行适配器
    const backendResult: ToolInvokeResult = await toolApi.execute(
      {
        toolName,
        arguments: JSON.stringify(args),
        conversationId: options.conversationId,
        systemCode,
        userMessage: options.userMessage,
        toolUseId: options.toolCallId,
        // 审批可能在 execute 内部才完成，因此实际调用后端前重新取最新决策，
        // 而不是使用 tryStartToolExecution 传入时的快照。
        approvalDecisions:
          options.approvalGate?.getDecisions() ?? options.approvalDecisions ?? [],
      },
      {
        // 用户中断专线挂到 fetch：abort 关连接 → 后端 RequestAborted → 执行令牌真取消，
        // 写工具（publish/confirm 等）不再"界面说中断、后台照落库"（2026-08-28 审计实锤修复）
        signal: userCancelSignal,
        // 2026-07-31 进度动脉：后端 SSE progress 事件（如 pip 安装日志）透传到瀑布节点
        onProgress: options.onProgress
          ? (message) =>
              reportProgress(options.onProgress, {
                toolCallId: options.toolCallId,
                toolName,
                status: 'running',
                message,
              })
          : undefined,
        onApprovalRequired: options.approvalGate
          ? async (approval) => {
              const tool = this.registry.get(approval.toolName)
              const rawParams = approval.rawParams ?? args
              const impactStatement =
                approval.impactStatement ?? renderImpactStatement(tool, rawParams)
              const outcome = await options.approvalGate!.requestApproval({
                toolCallId: approval.toolUseId,
                toolName: approval.toolName,
                riskLevel:
                  (approval.riskLevel as ToolRiskLevel) ??
                  (tool?.riskLevel as ToolRiskLevel) ??
                  'elevated',
                impactStatement: impactStatement || approval.reason || '后端要求审批',
                rawParams,
                argumentsSummary: JSON.stringify(rawParams),
                reason: approval.reason || '后端要求审批',
                requestedAt: Date.now(),
                expiresAt: approval.expiresAt ?? Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS,
              })
              return outcome.approved
            }
          : undefined,
      }
    )
    return {
      success: backendResult.success,
      data: backendResult.data,
      structuredData: backendResult.structuredData,
      error: backendResult.error,
    }
  }

  /**
   * 目录授权自愈（2026-08-31 前后端职责切分：后端=客观环境只报事实，agent 逻辑全在前端；
   * 2026-09-01 P0-7 从 run_command 独享扩成与文件六原语共用——同一登记根、同一挑战协议）。
   *
   * 后端对未登记物理路径返回结构化挑战
   * { error_code:'directory_not_registered', path, exists }——操作未执行，重试无副作用。
   * 两条路：
   * - 权限表已有覆盖该路径的目录规则（= 用户此前批准过；典型场景：后端重启清了会话层
   *   登记表，前端「本对话不再询问」规则仍在）→ 按规则档位静默补登记 + 原样重试一次，
   *   无审批卡、模型无感。前后端登记存储的发散在此自愈，取代发送前的"对账"补丁；
   * - 无规则覆盖（预检缓存与后端真值发散的其余情形）→ 弹目录审批卡；批准走 chatStore
   *   既有沉淀通道（权限表同步落规则 + fire-and-forget 后端登记），这里再 await 一次
   *   会话档登记兜底（幂等）消除"批准即重试"与异步登记的竞态，随后重试一次。
   * 目录不存在（exists=false）不是授权问题：原样交回模型自纠路径，不弹卡。
   * 重试上限一次：重试仍挑战说明登记未生效，放弃并把该次失败交回模型。
   * 重试复用本轮 signal 是安全的：审批卡 5 分钟过期 < 工具执行预算；
   * 用户在卡片打开期间中断会话会经 approvalGate.abort() 以「用户中断」结算，不走重试。
   */
  private async handleDirectoryChallenge(
    first: RouteExecuteResult,
    options: ExecuteToolOptions,
    signal: AbortSignal,
    userCancelSignal?: AbortSignal
  ): Promise<{ result: RouteExecuteResult; approved: boolean }> {
    const challenge = readDirectoryChallenge(first.structuredData)
    if (!challenge) return { result: first, approved: false }
    if (!challenge.exists) return { result: first, approved: false }

    // 登记/查规则一律用目录（文件路径取后端给的父目录，旧后端无 directory 字段回退原 path）
    if (challenge.directory === null) return { result: first, approved: false }
    const regDir = challenge.directory ?? challenge.path
    const convId = options.conversationId != null ? String(options.conversationId) : null
    const covering = findDirectoryRuleCovering(convId, regDir)

    if (covering) {
      try {
        // 长期档补持久层（registered-roots.json），本对话档补会话层（内存）
        await workspaceApi.registerRoot(
          regDir,
          covering.scope === 'conversation' ? 'session' : undefined
        )
      } catch (err) {
        console.warn(`[${options.toolName}] 目录挑战静默补登记失败，交回原失败:`, err)
        return { result: first, approved: false }
      }
      const retry = await this.routeExecute(options, signal, userCancelSignal)
      return { result: retry, approved: false }
    }

    if (!options.approvalGate) return { result: first, approved: false }

    reportProgress(options.onProgress, {
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      status: 'awaiting_approval',
      message: `未登记目录：${regDir}`,
    })
    const outcome = await options.approvalGate.requestApproval({
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      riskLevel: 'standard',
      impactStatement: '',
      rawParams: options.args,
      argumentsSummary: safeStringify(options.args),
      reason:
        `${options.toolName === 'run_command' ? '命令需要进入' : '操作将触及'}未登记目录：${regDir}。` +
        '批准即在本对话内允许该目录及子目录（不再询问）；选「始终允许」则跨会话生效。',
      requestedAt: Date.now(),
      expiresAt: Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS,
      suggestedRule: suggestDirectoryRule([regDir]) ?? undefined,
    })
    if (!outcome.approved) {
      // 与预检审批拒绝同形的三态文案（超时/中断/拒绝），防模型把超时误读为拒绝而盲目重试
      const reason = outcome.reason ?? ''
      const denied = reason.includes('超时')
        ? `审批超时（5 分钟无响应），${options.toolName} 未被执行。这不是用户主动拒绝——如需继续，请向用户确认后重新发起该工具调用。`
        : reason.includes('中断')
          ? `用户在审批等待期间中断了会话，${options.toolName} 未被执行。不要重试该调用，等待用户新的指示。`
          : `用户未授权目录 ${regDir}，${options.toolName} 未被执行。不要原样重试同一调用——改用已授权目录内的路径，或征得用户同意后再试。`
      return { result: { success: false, error: denied, data: denied }, approved: false }
    }
    // 批准：chatStore 沉淀通道已同步落权限表规则；其后端登记是 fire-and-forget，
    // 这里 await 一次会话档登记兜底（幂等，若用户选了「始终允许」持久登记随后也会落到）
    try {
      await workspaceApi.registerRoot(regDir, 'session')
    } catch (err) {
      console.warn(`[${options.toolName}] 目录挑战批准后登记失败，交回原失败:`, err)
      return { result: first, approved: true }
    }
    const retry = await this.routeExecute(options, signal, userCancelSignal)
    return { result: retry, approved: true }
  }

  async executeBatch(options: ExecuteBatchOptions): Promise<ToolResult[]> {
    const { calls, contextType, getArguments, commonContext } = options
    const parentSignal = commonContext.abortSignal

    // 按每个调用实际参数评估并发安全性与破坏性
    type CallSlot = { call: ToolCall; args: Record<string, unknown> }
    const safe: CallSlot[] = []
    const unsafe: CallSlot[] = []

    for (const call of calls) {
      const args = getArguments(call)
      const tool = this.registry.get(call.name)
      const concurrencySafe = evaluateToolFlag(tool?.isConcurrencySafe, args, false)
      const destructive = evaluateToolFlag(tool?.isDestructive, args, false)
      if (concurrencySafe && !destructive) {
        safe.push({ call, args })
      } else {
        unsafe.push({ call, args })
      }
    }

    const semaphore = new Semaphore(MAX_CONCURRENT_TOOLS)

    // 安全调用并发执行（受信号量限制）
    const safePromises = safe.map(async ({ call, args }) => {
      const release = await semaphore.acquire()
      try {
        if (parentSignal?.aborted) {
          return makeAbortedResult(call, parentSignal.reason, Date.now())
        }
        return await this.execute({
          ...commonContext,
          contextType,
          toolName: call.name,
          args,
          toolCallId: call.id,
          abortSignal: createChildAbortController(parentSignal).signal,
        })
      } finally {
        release()
      }
    })

    // 非安全/破坏性调用串行执行
    const unsafePromises = (async () => {
      const results: ToolResult[] = []
      for (const { call, args } of unsafe) {
        if (parentSignal?.aborted) {
          results.push(makeAbortedResult(call, parentSignal.reason, Date.now()))
          continue
        }
        const result = await this.execute({
          ...commonContext,
          contextType,
          toolName: call.name,
          args,
          toolCallId: call.id,
          abortSignal: createChildAbortController(parentSignal).signal,
        })
        results.push(result)
      }
      return results
    })()

    const [safeResults, unsafeResults] = await Promise.all([Promise.all(safePromises), unsafePromises])

    // 按原始 calls 顺序返回结果
    const resultMap = new Map<string, ToolResult>()
    for (const r of safeResults) resultMap.set(r.toolCallId, r)
    for (const r of unsafeResults) resultMap.set(r.toolCallId, r)
    return calls.map((call) => resultMap.get(call.id)).filter((r): r is ToolResult => Boolean(r))
  }
}

function makeAbortedResult(call: ToolCall, reason: unknown, startedAt: number): ToolResult {
  const message = reason instanceof Error ? reason.message : String(reason || '已取消')
  return {
    toolCallId: call.id,
    name: call.name,
    success: false,
    output: null,
    outputText: message,
    isTruncated: false,
    startedAt,
    endedAt: Date.now(),
    error: message,
  }
}

export function createToolExecutor(registry: FrontendToolRegistry): ToolExecutor {
  return new DefaultToolExecutor(registry)
}
