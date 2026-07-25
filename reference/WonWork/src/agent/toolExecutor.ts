/**
 * 跨 chat / DAG 的统一工具执行门面
 *
 * - DAG 路径沿用现有 `/api/dag/node/tool/execute`；
 * - chat 路径当前为后端 SSE 驱动（MESCLI）或 Standalone 本地未支持，返回 graceful 错误。
 */

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
import { fetchApi, toolApi } from '@/api/client'
import { safeStringify } from '@/utils/safeSerialize'
import type { ApprovalGate, ApprovalDecision } from './approvalGate'
import { validateJsonSchema, formatSchemaErrors } from './schemaValidator'
import { PROJECT_WRITE_GRANT } from './sessionGrants'

/**
 * S4 D3：/project 写入判定——仅文件写入工具（write_file / str_replace），
 * delete_file 走 destructive 底线确认（每次必问），不在此列。
 */
const PROJECT_WRITE_TOOLS = new Set(['write_file', 'str_replace'])

function isProjectWrite(toolName: string, args: Record<string, unknown>): boolean {
  if (!PROJECT_WRITE_TOOLS.has(toolName)) return false
  const path = args.path
  return typeof path === 'string' && path.trim().startsWith('/project/')
}

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
  // 0. 防御性检查：required 字段不允许为空字符串
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
 * 按工具声明的 maxResultSizeChars 限制结果文本长度。
 */
function applyResultBudget(result: ToolResult, maxChars?: number): ToolResult {
  if (!maxChars || maxChars <= 0) return result
  const text = result.outputText ?? safeStringify(result.output)
  if (text.length <= maxChars) return result
  const truncated = text.slice(0, maxChars) + '\n\n[...结果已截断...]'
  return {
    ...result,
    outputText: truncated,
    isTruncated: true,
  }
}

import { FrontendToolRegistry, evaluateToolFlag } from './toolRegistry'

/**
 * 跨 chat / DAG 的统一工具执行门面
 */

export type ToolExecutionContextType = 'chat' | 'dag'

export interface ExecuteToolOptions {
  contextType: ToolExecutionContextType
  toolName: string
  args: Record<string, unknown>
  toolCallId: string
  traceId: string
  conversationId?: number
  systemCode?: string
  /** 当前对话轮次的真实用户原话。 */
  userMessage?: string
  /** 默认 120000ms */
  timeoutMs?: number
  abortSignal?: AbortSignal
  onProgress?: (update: ToolProgressUpdate) => void
  /** 审批闸 */
  approvalGate?: ApprovalGate
  /** 当前会话已批准的审批决策 */
  approvalDecisions?: ApprovalDecision[]
  /** 权限上下文 */
  permissionContext?: ToolPermissionContext
}

export interface ExecuteBatchOptions {
  calls: ToolCall[]
  contextType: ToolExecutionContextType
  /** 将 ToolCall 映射到实际执行参数 */
  getArguments: (call: ToolCall) => Record<string, unknown>
  /** 公共上下文 */
  commonContext: Omit<ExecuteToolOptions, 'contextType' | 'toolName' | 'args' | 'toolCallId'>
}

export interface ToolExecutor {
  execute(options: ExecuteToolOptions): Promise<ToolResult>
  executeBatch(options: ExecuteBatchOptions): Promise<ToolResult[]>
}

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

function reportProgress(
  onProgress: ((update: ToolProgressUpdate) => void) | undefined,
  update: ToolProgressUpdate
): void {
  try {
    onProgress?.(update)
  } catch {
    // 忽略回调异常
  }
}

function createTimeoutController(timeoutMs: number): AbortController {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`工具调用超时（${timeoutMs}ms）`))
  }, timeoutMs)
  const cleanup = () => clearTimeout(timer)
  controller.signal.addEventListener('abort', cleanup, { once: true })
  return controller
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

/** 工具并发上限 */
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

  // 1.5 沙箱模式：禁止一切非只读工具
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

  // 3. 显式允许
  const allowedBehavior = evaluatePermissionRules(tool.name, context.allowRules)
  if (allowedBehavior === 'allow') {
    return { allowed: true, behavior: 'allow' }
  }

  // 3.5 /project 首次写入确认
  if (
    isProjectWrite(tool.name, args) &&
    !context.grantedPermissions?.has(PROJECT_WRITE_GRANT)
  ) {
    return {
      allowed: false,
      behavior: 'ask',
      alwaysAsk: true,
      reason: `首次向项目目录（/project）写入需要人工确认，确认后会话内不再重复询问`,
    }
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
      timeoutMs = DEFAULT_TIMEOUT_MS,
      abortSignal,
      onProgress,
      approvalGate,
      permissionContext,
    } = options

    const startedAt = Date.now()

    reportProgress(onProgress, {
      toolCallId,
      toolName,
      status: 'pending',
      message: `准备执行 ${toolName}`,
    })

    // 1. chat 模式下先进行权限与审批判断
    let approvalReason = ''
    let needsApproval = false
    let permissionDeniedReason: string | undefined
    let maxResultChars: number | undefined

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
        } else {
          permissionDeniedReason = permission.reason || `权限检查未通过: ${toolName}`
        }
      }

      const explicitlyRequiresApproval =
        tool.requiresApproval === true || tool.approvalMode === 'explicit'
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

      const approved = await approvalGate.requestApproval({
        toolCallId,
        toolName,
        riskLevel: (this.registry.get(toolName)?.riskLevel ?? 'standard') as ToolRiskLevel,
        impactStatement: renderImpactStatement(this.registry.get(toolName), args),
        rawParams: args,
        argumentsSummary: safeStringify(args),
        reason: approvalReason,
        requestedAt: Date.now(),
        expiresAt: Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS,
      })
      if (!approved) {
        const deniedMessage = `用户拒绝了 ${toolName} 的执行`
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

    reportProgress(onProgress, {
      toolCallId,
      toolName,
      status: 'running',
      message: `开始执行 ${toolName}`,
    })

    // 2. 构造 per-call 子 abort controller，并关联超时
    const childController = createChildAbortController(abortSignal)
    const timeoutController = createTimeoutController(timeoutMs)
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
      const result = await this.routeExecute(options, combinedController.signal)
      cleanup()
      const endedAt = Date.now()

      const outputText =
        typeof result.data === 'string'
          ? result.data
          : extractOutputText(result.structuredData ?? result.data)

      const toolResult: ToolResult = {
        toolCallId,
        name: toolName,
        success: result.success,
        output: result.structuredData ?? result.data,
        outputText,
        isTruncated: result.isTruncated ?? false,
        persistedUrl: result.persistedUrl,
        startedAt,
        endedAt,
        error: result.error,
      }

      const finalResult = applyResultBudget(toolResult, maxResultChars)

      reportProgress(onProgress, {
        toolCallId,
        toolName,
        status: finalResult.success ? 'completed' : 'error',
        message: finalResult.success ? `${toolName} 执行完成` : finalResult.error,
        detail: finalResult.output,
      })
      return finalResult
    } catch (err) {
      cleanup()
      const endedAt = Date.now()
      const errorMessage = err instanceof Error ? err.message : String(err)
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
    signal: AbortSignal
  ): Promise<{
    success: boolean
    data?: unknown
    structuredData?: unknown
    isTruncated?: boolean
    persistedUrl?: string
    error?: string
  }> {
    const { contextType, toolName, args, systemCode } = options

    if (contextType === 'dag') {
      const response = (await fetchApi('/api/dag/node/tool/execute', {
        method: 'POST',
        body: JSON.stringify({ toolName, args, systemCode }),
        signal,
      })) as {
        success?: boolean
        data?: unknown
        error?: string
        structuredData?: unknown
        isTruncated?: boolean
        persistedUrl?: string
      }
      return {
        success: response.success ?? true,
        data: response.data,
        structuredData: response.structuredData,
        isTruncated: response.isTruncated,
        persistedUrl: response.persistedUrl,
        error: response.error,
      }
    }

    // contextType === 'chat'
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
        traceId: options.traceId,
        conversationId: options.conversationId,
        systemCode,
        abortSignal: signal,
        onProgress: options.onProgress,
      })

      if (result && typeof result === 'object' && 'success' in result) {
        const r = result as { success: boolean; error?: string }
        return {
          success: r.success,
          data: result,
          structuredData: result,
          error: r.error,
        }
      }

      return {
        success: true,
        data: result,
        structuredData: result,
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
        traceId: options.traceId,
        approvalDecisions:
          options.approvalGate?.getDecisions() ?? options.approvalDecisions ?? [],
      },
      {
        onApprovalRequired: options.approvalGate
          ? async (approval) => {
              const tool = this.registry.get(approval.toolName)
              const rawParams = approval.rawParams ?? args
              const impactStatement =
                approval.impactStatement ?? renderImpactStatement(tool, rawParams)
              const approved = await options.approvalGate!.requestApproval({
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
              return approved
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

  async executeBatch(options: ExecuteBatchOptions): Promise<ToolResult[]> {
    const { calls, contextType, getArguments, commonContext } = options
    const parentSignal = commonContext.abortSignal

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
