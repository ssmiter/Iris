import type { AgenticLoopHandle } from '@/agent/agenticLoop'

/**
 * 子 Agent 后台运行注册表（2026-08-01 异步化，对齐 claude-code 的 AppState.tasks）。
 *
 * claude-code 机制对照（源码：LocalAgentTask.tsx / AgentTool.tsx / stopTask.ts）：
 * - 后台 Agent 注册时**刻意不挂父 abort**（注释原文：background agents should survive
 *   when the user presses ESC）——这里同构：controller 由本模块自持，主 loop 停止不级联；
 * - kill = abort controller + **终态通知补发**（killed 也发通知、带部分成果）；
 * - SendMessage 运行中路径 = 消息进 pendingMessages、下一 tool round 边界注入——
 *   这里直接复用子 loop 的 supplement 队列（步骤间隙注入，语义相同）；
 * - 完成通知经 listener 单点出口（chatStore 注册），manager 不知道消息形态——
 *   通知怎么进对话（忙时 supplement/闲时唤醒 turn）是 chatStore 的职责。
 *
 * 通用性：launch 只约定 runner 签名，explore 之外的子 Agent 类型（general/analysis）可复用。
 */

export interface SubAgentRunResult {
  status: 'done' | 'error' | 'cancelled'
  /** 完整报告文本（含终态标记与统计 footer；取消/出错时为部分成果） */
  report: string
  reportPath?: string
  error?: string
  /** 本 run 写工具触碰过的文件路径（通用 agent 完成通知产出/修改清单用） */
  touchedFiles?: string[]
  /** 与同会话其他并行 run 的触碰面交集提示（有冲突时由运行体计算） */
  conflictNote?: string
  /** 结构化输出契约的提交结果（派遣时声明了 schema 才有；程序化消费通道，报告文本外双通道） */
  structuredOutput?: { submitted: boolean; value?: unknown }
}

export interface SubAgentCompletion extends SubAgentRunResult {
  runId: string
  kind: string
  conversationId?: number
  /** 任务会话 id（2026-09-01 二阶段）：kind='task' 时存在——完成通知据此告知模型入口 */
  taskConversationId?: number
  task: string
}

interface ActiveEntry {
  runId: string
  kind: string
  conversationId?: number
  task: string
  controller: AbortController
  /** 子 loop 启动后由 runner 回调注入；在此之前 sendToSubAgent 的文本进 pendingTexts 暂存 */
  loopHandle?: Pick<AgenticLoopHandle, 'supplement'>
  pendingTexts: string[]
  timeout: ReturnType<typeof setTimeout>
}

export interface LaunchSubAgentOptions {
  runId: string
  kind: string
  conversationId?: number
  /** 任务会话 id（kind='task'）：运行归属=任务会话，通知归属=conversationId（父会话），两者分离 */
  taskConversationId?: number
  task: string
  /** 后台运行 guard 超时（默认 20min）：同步路径有执行器 15min timeoutMs，
   *  后台路径没有执行器兜底，挂死的子 loop 不能永远占信号量槽位 */
  timeoutMs?: number
  /**
   * 派遣方自备完成回调（2026-08-05 代码侧派遣）：提供后**跳过**全局 completionListener
   * （chatStore 的"[子 Agent 通知]"注入）。cron 定时任务等代码侧派遣用它把结果引向
   * 自己的落库通道——结果是一份独立交付物，不该唤醒/打扰主对话。
   */
  onComplete?: (completion: SubAgentCompletion) => void
  run: (
    signal: AbortSignal,
    onLoopHandle: (handle: Pick<AgenticLoopHandle, 'supplement'>) => void
  ) => Promise<SubAgentRunResult>
}

const DEFAULT_BACKGROUND_TIMEOUT_MS = 20 * 60 * 1000

const active = new Map<string, ActiveEntry>()

type CompletionListener = (completion: SubAgentCompletion) => void
let completionListener: CompletionListener | null = null

/** chatStore 在模块初始化时注册（单点出口，重复注册后者覆盖前者） */
export function setSubAgentCompletionListener(listener: CompletionListener): void {
  completionListener = listener
}

export function launchBackgroundSubAgent(opts: LaunchSubAgentOptions): void {
  const controller = new AbortController()
  const entry: ActiveEntry = {
    runId: opts.runId,
    kind: opts.kind,
    conversationId: opts.conversationId,
    task: opts.task,
    controller,
    pendingTexts: [],
    timeout: setTimeout(
      // 前缀对齐运行体的超时判据（settleAborted 认 '工具调用超时' → 报告标记"执行超时"）
      () => controller.abort(new Error('工具调用超时（后台运行 guard）')),
      opts.timeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT_MS
    ),
  }
  active.set(opts.runId, entry)

  const notify = (result: SubAgentRunResult) => {
    const completion: SubAgentCompletion = {
      runId: opts.runId,
      kind: opts.kind,
      conversationId: opts.conversationId,
      taskConversationId: opts.taskConversationId,
      task: opts.task,
      ...result,
    }
    // 派遣方自备回调优先（代码侧派遣走自己的结果通道）；否则全局单点出口
    if (opts.onComplete) opts.onComplete(completion)
    else completionListener?.(completion)
  }

  void opts
    .run(controller.signal, (handle) => {
      entry.loopHandle = handle
      // loop 启动前暂存的补充（信号量排队期间用户就发了话）启动后一次性注入
      for (const text of entry.pendingTexts.splice(0)) handle.supplement(text)
    })
    .then((result) => notify(result))
    .catch((err: unknown) => {
      notify({
        status: controller.signal.aborted ? 'cancelled' : 'error',
        report: '',
        error: err instanceof Error ? err.message : String(err),
      })
    })
    .finally(() => {
      clearTimeout(entry.timeout)
      active.delete(opts.runId)
    })
}

/**
 * 终止后台子 Agent（claude-code TaskStop 对应物）。
 * 终态通知由运行体的 abort 路径自行补发（带部分成果），这里只负责 abort。
 */
export function killSubAgent(runId: string): 'killed' | 'not-running' {
  const entry = active.get(runId)
  if (!entry) return 'not-running'
  entry.controller.abort(new Error('用户终止'))
  return 'killed'
}

/**
 * 向运行中的子 Agent 补充消息（claude-code SendMessage 运行中路径对应物）：
 * loop 已启动→直接进 supplement 队列（步骤间隙注入）；未启动（信号量排队中）→暂存，
 * 启动后一次性注入；已结束/不存在→not-running（恢复续聊=defer P2，原料在 trace.json）。
 */
export function sendToSubAgent(
  runId: string,
  text: string
): 'delivered' | 'queued' | 'not-running' {
  const entry = active.get(runId)
  if (!entry) return 'not-running'
  if (entry.loopHandle) {
    entry.loopHandle.supplement(text)
    return 'delivered'
  }
  entry.pendingTexts.push(text)
  return 'queued'
}

/** 某 runId 是否仍在后台活动（排队/运行中） */
export function hasActiveSubAgent(runId: string): boolean {
  return active.has(runId)
}
