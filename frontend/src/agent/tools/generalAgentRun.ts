import type { Message, ToolCatalogItem } from '@/types/mescli'
import type { AgenticLoopHandle } from '@/agent/agenticLoop'
import { createToolRegistry } from '@/agent/toolRegistry'
import { createToolExecutor } from '@/agent/toolExecutor'
import { startAgenticLoop } from '@/agent/agenticLoop'
import { createTraceCollector } from '@/agent/traceCollector'
import { applyBackendToolOverrides } from '@/agent/backendToolOverrides'
import { getFileTools } from './fileTools'
import { recallFactsTool } from './factTools'
import {
  createListCapabilitiesTool,
  createReadCapabilityTool,
} from './capabilityDiscoveryTools'
import { createStopCommandTaskTool } from './stopCommandTaskTool'
import { webSearchTool, webFetchTool } from './web'
import { webBridgeClient } from '@/api/webbridgeClient'
import { writeFile } from '@/services/fileSystem'
import { useSessionToolStore } from '@/stores/sessionToolStore'
import { useSubAgentRunStore } from '@/stores/subAgentRunStore'
import { getRuntimeMode } from '@/utils/runtimeMode'
import { buildGeneralAgentSystemPrompt } from '@/agent/generalAgentPrompt'
import { buildAnswerLanguageNote } from '@/agent/prompt'
import type { Tool, ToolExecutionContext, ApprovalRequest, ExecutionMode } from '@/agent/types'
import type { ChatMessage } from '@/types/chat'
import type { ExploreAgentDeps } from './exploreAgentRun'
import { isPureWrite } from './exploreAgentRun'
import { createWriteStateTool } from './writeStateTool'
import { acquireSubAgentSlot } from './subAgentSlots'
import {
  createStructuredOutputEnforcer,
  type StructuredOutputEnforcer,
  type StructuredOutputSpec,
} from '@/agent/structuredOutput'

/**
 * 通用子 Agent（agent 工具 subagent_type=general）运行体（2026-08-01 多 Agent 第二步）。
 *
 * 与 explore 同源同骨架（注册表构建 → 子 loop → 报告组装 → 落盘 → 终态），
 * 三处结构性反转（设计文档 learn/05/workshop/通用agent设计-2026-08-01.md §4）：
 * - 工具面=主 Agent 全集：目录不预过滤、写文件原语全注册、已发现工具名全量继承；
 * - 审批桥（D1 方案 A）：提供 onApprovalRequested，写审批冒泡到主对话审批卡
 *   （deps.requestApproval 由 chatStore 桥接进 pendingApprovals，store 级机制
 *   不依赖主 loop 存活——后台子 Agent 的审批卡照常显示，超越 claude-code 后台
 *   auto-deny 的终端形态限制）；
 * - 并行一致性三层（D2 P1）：写工具包装记录 touchedFiles（引导分区在 agent 工具
 *   描述里）→ 完成时与同会话其他 run 求交集 → conflictNote 进报告与完成通知。
 *
 * 深度守卫（D3）保留：agent/explore 派遣工具不注册进子注册表，子 Agent 无法再派生
 * （claude-code 同款：工具面裁剪而非深度计数）。
 */

export const GENERAL_AGENT_KIND = 'general'

/** 通用执行固定 40 轮（2026-08-02 从 30 上调：定位是"系统性分析+产出文件"的重活，
 *  最重的场景恰是价值所在——撞顶中断+重新派遣接力的代价大于多 10 轮的 token 成本。
 *  压缩续命一次后等效 ~80 轮；再大的任务应拆给并行子 Agent，而非一个跑到底。
 *  上限是防失控保险而非预算目标，正常任务不该碰到它；后台 guard 超时 20min 兜底） */
const GENERAL_MAX_TURNS = 40

export interface GeneralAgentInput {
  /** 自足的任务描述：背景、目标、产出要求（含期望的产出文件路径）、约束 */
  task: string
}

export interface GeneralAgentOutput {
  /** 给模型的报告文本（extractOutputText 优先取 content） */
  content: string
  runId: string
  /** 报告全文落盘路径（落盘失败时缺省） */
  reportPath?: string
  /** 执行器防双重落盘约定字段（= reportPath） */
  persistedUrl?: string
  stats: {
    toolCalls: number
    discoveredTools: number
    durationMs: number
  }
}

/** 运行结果=工具输出+终态+触碰面（异步路径 manager 据此组装完成通知） */
export interface GeneralRunResult extends GeneralAgentOutput {
  status: 'done' | 'error' | 'cancelled'
  error?: string
  touchedFiles?: string[]
  conflictNote?: string
  /** 声明了结构化输出契约时：是否提交+提交值（调用方据此消费状态对象） */
  structuredOutput?: { submitted: boolean; value?: unknown }
}

export interface GeneralAgentDeps extends ExploreAgentDeps {
  /** 审批桥（D1）：子 loop 需审批的调用冒泡到主对话审批卡。
   *  chatStore 实现=addPendingApproval + sourceRunId/sourceTask 标记；
   *  用户批准/拒绝/超时后 resolve，子 loop 继续或收到拒绝。 */
  requestApproval: (
    request: ApprovalRequest,
    resolve: (approved: boolean, reason?: string) => void,
    runId: string,
    task: string
  ) => void
  /** 实时读取主会话权限模式（与主 Agent 同一来源，对话中切换即时生效） */
  getExecutionMode?: () => ExecutionMode
}

export interface GeneralRunOptions {
  /** 父工具执行上下文的进度透传（仅同步路径有：喂主 loop watchdog/executionLog） */
  onProgress?: ToolExecutionContext['onProgress']
  /** 发起它的父瀑布工具调用 id（SubAgentFlow 挂靠链第①级显式接缝） */
  parentToolCallId?: string
  /** 子 loop 启动后回调句柄（异步路径 manager 持有，供 sendToSubAgent 补充注入） */
  onLoopHandle?: (handle: AgenticLoopHandle) => void
  /** 外部登记的 runId（异步路径 manager 生成后传入，保证注册表/运行记录/通知同一 id） */
  runId?: string
  /**
   * 结构化输出契约（2026-08-03 W1）：声明后注册动态 schema 提交工具并强制提交——
   * 状态对象的可信生产方式（schema 校验回炉+收尾顶回+重试熔断，见 structuredOutput.ts）。
   * 角色化子 Agent（评审/状态维护）靠它交付可信的状态对象给调用方/确定性代码消费。
   */
  structuredOutput?: StructuredOutputSpec
  /**
   * 运行体 helper 参数（2026-08-13 泛化，helper 契约驱动）：stateKeeper 专属字段收拢进
   * helper 对象——readOnly 主开关 / 状态维护参数 / 轮数上限由 agentTool 按 helper 契约
   * （helperContracts.ts）装配后统一传入，运行体不再关心"哪种角色"。
   * 状态维护角色（2026-08-03 §五·补四）：工具面=只读面 + write_state 一把写钥匙，
   * 身份 prompt 走元认知变体。
   * 认知连续性由状态文件承担而非子 Agent 上下文——每次同步是一个短任务实例，
   * 不需要常驻 loop（常驻缺回复通道与空闲等待机制，且状态文件本就是设计的事实底座）。
   * （原 A1 readOnly 评审角色已于 2026-08-03 裁剪：评审类任务派 explore 即可，
   *  内部只读工具面过滤逻辑保留给本角色复用。）
   */
  helper?: {
    /** 只读面主开关（helper 契约 toolScope=readonly 驱动）：写工具不注册/不可发现/不挂审批桥 */
    readOnly: boolean
    /** 状态维护角色：一把写钥匙=write_state（只写指定状态文件） */
    stateKeeper?: { statePath: string; domainPack?: string }
    /** 轮数上限（state=12，来自契约；缺省 GENERAL_MAX_TURNS=40） */
    maxTurns?: number
  }
  /**
   * 任务会话 id（2026-09-02）：as_task 派遣时由 taskSession 传入——运行记录带上它，
   * 任务会话内实况渲染（TaskLiveRun）与胶囊条排除都据此定位，不靠 kind 猜。
   */
  taskConversationId?: number
  /**
   * 历史前缀（2026-09-02 §16.7 追问即续跑）：插在 system 与本次任务之间的既有会话消息
   * （任务会话的 user/assistant 序列）。续跑运行靠它接续前次结论而非从零开始。
   */
  priorMessages?: Message[]
  /** 轮数上限覆盖（优先级高于 helper.maxTurns）：任务会话长程档位由 taskSession 传入 */
  maxTurns?: number
}

function firstLine(text: string | undefined): string | undefined {
  if (!text) return undefined
  const line = text.split('\n').find((l) => l.trim().length > 0)
  return line?.slice(0, 80)
}

/** 收尾预警提前量（2026-08-02）：剩余轮数 ≤ 此值时注入系统补充让子 Agent 主动收束。
 *  与 exploreAgentRun 同款逻辑，修改需两边同步。 */
const WRAP_UP_WARN_REMAINING = 3

export function makeGeneralRunId(): string {
  return `general-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

/** 会写文件的工具名（执行前记录 input.path 到 runStore.touchedFiles） */
const TOUCH_TRACKED_TOOL_NAMES = new Set(['write_file', 'str_replace', 'delete_file'])

/**
 * 写工具包装：执行前把目标路径记入 runStore（冲突可见数据源）。
 * onToolStart 的 toolMsg 不携带输入参数，只能在工具 execute 入口提取。
 * 已知缺口：execute_python_script 的 OUTPUT_PATH、无文件路径的业务写工具不记（defer P2）。
 */
function wrapTouchTracking(tool: Tool<unknown, unknown>, runId: string): Tool<unknown, unknown> {
  const originalExecute = tool.execute
  if (!originalExecute) return tool
  return {
    ...tool,
    execute: async (input: unknown, ctx: ToolExecutionContext) => {
      const path = (input as { path?: unknown } | null | undefined)?.path
      if (typeof path === 'string' && path.trim()) {
        useSubAgentRunStore.getState().addTouchedFile(runId, path.trim())
      }
      return originalExecute(input, ctx)
    },
  }
}

/**
 * 跑完一个通用子 Agent 的完整生命周期。
 * signal 语义同 explore：同步=父级级联 abort，异步=manager 显式 kill/guard 超时。
 */
export async function runGeneralAgentSession(
  input: GeneralAgentInput,
  deps: GeneralAgentDeps,
  signal: AbortSignal | undefined,
  options?: GeneralRunOptions
): Promise<GeneralRunResult> {
  const runStore = useSubAgentRunStore.getState()
  const runId = options?.runId ?? makeGeneralRunId()
  const startedAt = Date.now()

  runStore.enqueueRun({
    runId,
    kind: GENERAL_AGENT_KIND,
    task: input.task,
    thoroughness: 'standard',
    conversationId: deps.conversationId,
    parentToolCallId: options?.parentToolCallId,
    taskConversationId: options?.taskConversationId,
  })

  const release = await acquireSubAgentSlot(signal).catch((err: Error) => {
    runStore.finishRun(runId, { status: 'cancelled', error: err.message })
    throw err
  })

  try {
    runStore.markRunning(runId)

    // 1. 能力目录（命中会话缓存时无网络往返）——与 explore 不同：全量加载，
    // 写/破坏性工具也进子注册表，风险由审批桥传导给主对话用户把关。
    let catalog: ToolCatalogItem[] = []
    if (deps.conversationId != null) {
      try {
        const result = await useSessionToolStore
          .getState()
          .ensureSessionTools(deps.conversationId, getRuntimeMode(), deps.systemCode, deps.fetchCatalog)
        catalog = result.tools
      } catch (err) {
        console.warn('[agent:general] 加载能力目录失败，退化为仅本地原语:', err)
      }
    }

    // 2. 子注册表：主 Agent 全集（agent 派遣工具自身不注册=深度守卫）；
    // helper 只读面角色（stateKeeper）则结构性反转为只读面（同 explore 三道只读拦截，
    // 判定单一事实源=isPureWrite）；readOnly 主开关由契约 toolScope=readonly 驱动
    const readOnly = options?.helper?.readOnly === true
    const registry = createToolRegistry({ systemCode: deps.systemCode })
    if (catalog.length > 0) {
      registry.loadFromCatalog(readOnly ? catalog.filter((item) => !isPureWrite(item)) : catalog)
      applyBackendToolOverrides(registry)
    }
    // 文件原语全量注册（readOnly 只注册读原语）；写三件包装触碰记录（D2 第 2 层）
    for (const tool of getFileTools()) {
      if (readOnly && TOUCH_TRACKED_TOOL_NAMES.has(tool.name)) continue
      registry.register(TOUCH_TRACKED_TOOL_NAMES.has(tool.name) ? wrapTouchTracking(tool, runId) : tool)
    }
    // 状态维护角色的一把写钥匙：只写指定状态文件（结构性唯一写者，其余写工具仍全禁）
    if (options?.helper?.stateKeeper) {
      registry.register(createWriteStateTool({ statePath: options.helper.stateKeeper.statePath, runId }))
    }
    // 子环境不展示 /webbridge 目录（同 explore：浏览器写原语本就不注册，列出只会诱导空转）
    registry.register(
      createListCapabilitiesTool({ systemCode: deps.systemCode, registry, includeWebBridge: false })
    )
    // 发现通道：默认无 acceptTool 过滤（写工具可发现加载，调用时审批桥把关——与主 Agent 一致）；
    // readOnly 时第三道只读拦截（写工具不可发现，返回"未加载"引导，同 explore）
    registry.register(
      createReadCapabilityTool({
        systemCode: deps.systemCode,
        registry,
        ...(readOnly ? { acceptTool: (schema) => !isPureWrite(schema) } : {}),
      })
    )
    // 技能工具已退役（2026-09-03 文件化）：子 Agent 需要的工艺由主 Agent 读好后写进任务书，
    // 子上下文保持隔离、不自行发现技能
    // 后台命令终止通道（2026-09-02 补注册）：run_command 经目录子 Agent 可用，
    // 自己启动的后台命令自己要能停（长程任务会话里构建/服务挂死不能只能干等）
    registry.register(createStopCommandTaskTool())
    // 环境事实查询（只读件）：子 Agent 干活同样需要环境坐标（SVN 检出路径等）；
    // 写件（register/forget）留在主 loop——事实登记是用户面向决策，不委托子环境
    registry.register(recallFactsTool)
    if (webBridgeClient.isConnected) {
      registry.register(webSearchTool)
      registry.register(webFetchTool)
    }

    // 结构化输出契约（W1）：动态 schema 提交工具进子注册表，收尾顶回+熔断由回调阶段接管；
    // 顶回时刻透传 liveLine（五路实验 4 号：顶回不可见+liveLine 定格"出错"会诱发用户误杀）
    let enforcer: StructuredOutputEnforcer | undefined
    if (options?.structuredOutput) {
      enforcer = createStructuredOutputEnforcer({
        ...options.structuredOutput,
        onReminder: (n, max) =>
          useSubAgentRunStore
            .getState()
            .setLiveLine(runId, `正在按要求补交最终结果（第 ${n}/${max} 次补交提醒）`),
      })
      registry.register(enforcer.tool)
    }

    // （plan 闭环已退役 2026-09-02：extraTools 注入点随之一并撤除）

    // 已发现工具名全量继承（explore 只放行只读项；这里只过滤"注册表里不存在"的；
    // helper 只读面同 explore 语义：写工具即便曾被父级发现也不继承）
    const initialDiscoveredToolNames = new Set<string>()
    for (const name of deps.getInitialDiscoveredNames()) {
      const registered = registry.get(name)
      if (!registered) continue
      if (readOnly && registered.isReadOnly !== true) continue
      initialDiscoveredToolNames.add(name)
    }

    // 3. 独立上下文：只有 [系统提示, 任务]。提示按实际能力条件化（同 explore 先例）。
    const mode = getRuntimeMode()
    const hasSqlTool = catalog.some(
      (t) => t.name === 'execute_sql_query' || (t.path?.endsWith('/execute_sql_query') ?? false)
    )
    let systemPrompt = buildGeneralAgentSystemPrompt({
      sql: hasSqlTool
        ? { dialect: mode === 'mescli-local' ? ('sqlite' as const) : ('sqlserver' as const) }
        : undefined,
      hasCapabilityPrimitives: catalog.length > 0,
      // 结构化输出契约的一句话预告：让模型从第一轮就知道最终交付物形态，
      // 别等收尾顶回才发现要提交（详细语义在 submit 工具描述里，这里不重复）
      structuredOutputToolName: enforcer?.tool.name,
      stateKeeper: options?.helper?.stateKeeper,
      domainPack: options?.helper?.stateKeeper?.domainPack,
    })
    // 回答语言注记（仅英文界面注入，中文不加）——子代理报告会直接回流对话展示
    const languageNote = buildAnswerLanguageNote()
    if (languageNote) systemPrompt += `\n\n${languageNote}`
    const requestMessages: Message[] = [
      { role: 'system', content: systemPrompt },
      // 续跑（§16.7）：任务会话历史插在 system 与本次追问之间——同一 requestMessages
      // 状态数组语义，autoCompact 内核对长历史天然兜底
      ...(options?.priorMessages ?? []),
      { role: 'user', content: input.task },
    ]

    const { provider, apiKey, baseUrl } = await deps.getRuntime()

    const traceCollector = createTraceCollector()

    // 4. 无头回调跑子 loop：与主 Agent 同一权限模式+审批桥（D1 落地处）
    const outcome = await new Promise<{ text: string; failed?: string }>((resolve) => {
      let settled = false
      let latestAssistant: ChatMessage | null = null
      const toolNames = new Map<string, string>()
      // 收尾预警计数（onTurnStart 每轮模型调用时 +1，runner 侧自累计）
      let turnCount = 0
      let wrapUpWarned = false
      const settle = (value: { text: string; failed?: string }) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const reportChildProgress = (message: string) => {
        useSubAgentRunStore.getState().setLiveLine(runId, message)
        options?.onProgress?.({
          toolCallId: '',
          toolName: 'agent',
          status: 'running',
          message,
        })
      }

      // 轮数上限：options.maxTurns（任务会话长程档位）> helper 契约声明（state=短任务，
      // 五步预期过程，预算从契约带过来）> 缺省（general）=GENERAL_MAX_TURNS
      const maxTurns = options?.maxTurns ?? options?.helper?.maxTurns ?? GENERAL_MAX_TURNS
      const handle = startAgenticLoop({
        userMessage: {
          id: runId,
          role: 'user',
          content: input.task,
          timestamp: startedAt,
        },
        provider,
        apiKey,
        baseUrl,
        // 权限与主 Agent 相同：实时读取主会话权限模式（对话中切换即时生效），
        // 缺省 auto 与主 loop 缺省一致
        executionMode: deps.getExecutionMode?.() ?? 'auto',
        getExecutionMode: deps.getExecutionMode,
        conversationId: deps.conversationId,
        systemCode: deps.systemCode,
        requestMessages,
        traceCollector,
        toolRegistry: registry,
        toolExecutor: createToolExecutor(registry),
        maxTurns,
        enableFrontendToolLoop: true,
        initialDiscoveredToolNames,
        // consult_state 门控豁免（2026-08-08 双 agent P0）：写前对账是主 loop 层职责，
        // 主 Agent 派遣写子任务前先自己对账；子 Agent 没有派遣工具，被拦即死路
        stateConsultExempt: true,
        // 任务原文压后重注入（同 explore：压缩保真结构性兜底）
        postCompactMessages: [
          {
            role: 'user',
            content:
              `【任务重申】压缩可能淡化了原始任务。你的任务始终逐字是：\n\n${input.task}\n\n` +
              '以上任务描述优先级高于摘要中的任何转述；若两者冲突，以这里为准。直接继续未完成的部分。',
          },
        ],
        callbacks: {
          onAssistantCreated: (assistant) => {
            latestAssistant = assistant
          },
          onTurnStart: () => {
            // 收尾预警（2026-08-03 修复挂点：原挂 onAssistantCreated——该回调全程只触发
            // 一次，turnCount 恒为 1，预警从未生效）。信号源改 loop 的 onTurnStart；
            // runner 侧自累计（loop 的 turn 在压缩续命后重置为 0，不能用作"已用轮数"）。
            turnCount += 1
            if (!wrapUpWarned && turnCount >= maxTurns - WRAP_UP_WARN_REMAINING) {
              wrapUpWarned = true
              handle.supplement(
                `【系统提示】轮次预算将尽（已用 ${turnCount}/${maxTurns} 轮）。` +
                '立即停止开新的探索或修改，用手头已有成果按汇报格式输出最终报告；' +
                '未完成的部分如实写入"未决问题"，不要硬凑完成。'
              )
            }
          },
          onTurnFinish: (assistant) => {
            // 结构化输出 Stop-hook 等价物（W1）：模型自然收尾且未提交时经 supplement 顶回
            enforcer?.onTurnFinish(assistant, handle)
          },
          onAssistantUpdate: (assistant) => {
            latestAssistant = assistant
          },
          onToolStart: (toolMsg) => {
            const name = toolMsg.toolCallName ?? 'unknown'
            toolNames.set(toolMsg.toolCallId ?? toolMsg.id, name)
            useSubAgentRunStore.getState().addToolEvent(runId, {
              toolCallId: toolMsg.toolCallId ?? toolMsg.id,
              name,
              status: 'running',
              at: Date.now(),
            })
            reportChildProgress(`子 Agent 调用 ${name}`)
          },
          onToolUpdate: (toolCallId, update) => {
            const status =
              update.toolCallStatus === 'done'
                ? 'done'
                : update.toolCallStatus === 'error'
                  ? 'error'
                  : undefined
            if (!status) return
            useSubAgentRunStore.getState().updateToolEvent(runId, toolCallId, {
              status,
              summary: firstLine(update.content),
            })
            reportChildProgress(`子 Agent ${toolNames.get(toolCallId) ?? '工具'} ${status === 'done' ? '完成' : '出错'}`)
          },
          onToolsDiscovered: (names) => {
            useSubAgentRunStore.getState().addDiscoveredNames(runId, names)
            deps.onToolsDiscovered?.(names)
          },
          // 审批桥（D1）：子 loop 的审批请求冒泡到主对话审批卡。
          // 用户批准后 resolve(true) 子 loop 继续；拒绝/超时 resolve(false) 子 Agent
          // 收到拒绝——提示词已告知其换路径或在报告中说明。
          // helper 只读面不挂审批桥：写调用无闸 fail-close 直接拒绝（结构性只读第②层）
          ...(readOnly
            ? {}
            : {
                onApprovalRequested: (request: ApprovalRequest, resolveApproval: (approved: boolean, reason?: string) => void) => {
                  useSubAgentRunStore.getState().setLiveLine(runId, `等待用户审批：${request.toolName}`)
                  deps.requestApproval(request, resolveApproval, runId, input.task)
                },
              }),
          onError: (error) => {
            settle({ text: latestAssistant?.content ?? '', failed: error.message })
          },
          onDone: (assistant) => {
            settle({ text: assistant.content ?? latestAssistant?.content ?? '' })
          },
        },
      })

      options?.onLoopHandle?.(handle)

      // 取消传播+终态兜底（同 explore：abort 无终态回调，外层必须自行 settle）
      const settleAborted = () => {
        handle.abort()
        const reason = signal?.reason
        const isTimeout = reason instanceof Error && reason.message.startsWith('工具调用超时')
        settle({ text: latestAssistant?.content ?? '', failed: isTimeout ? '执行超时' : '已中断' })
      }
      signal?.addEventListener('abort', settleAborted, { once: true })
      if (signal?.aborted) settleAborted()
    })

    // 5. 冲突可见（D2 第 3 层）：本 run 触碰面与同会话其他 run 求交集
    const rec = useSubAgentRunStore.getState().runs[runId]
    const allRuns = useSubAgentRunStore.getState().runs
    const myTouched = rec?.touchedFiles ?? []
    const conflicts = myTouched.filter((f) =>
      Object.values(allRuns).some(
        (r) =>
          r.runId !== runId &&
          r.conversationId === deps.conversationId &&
          r.touchedFiles?.includes(f)
      )
    )
    const conflictNote =
      conflicts.length > 0
        ? `注意：本任务与同会话其他子 Agent 触碰了相同文件：${conflicts.join('、')}——需人工核对最终内容是否符合预期。`
        : undefined

    // 6. 汇报组装：失败终态区分，部分结果不丢
    const toolCalls = rec?.toolEvents.length ?? 0
    const discoveredCount = rec?.discoveredNames.length ?? 0
    const durationMs = Date.now() - startedAt
    const aborted = signal?.aborted === true

    // 结构化输出终态（W1）：已提交 → 状态值随报告带出供调用方消费；
    // 熔断耗尽仍未提交 → 如实标失败终态（declared structuredOutput 的语义就是"必须交付状态"）。
    // 文案纪律（五路实验 4 号 UX 审计）：用户可见处不出现"结构化状态/schema/状态对象"等术语。
    const structuredSubmitted = enforcer?.isSubmitted() ?? false
    const structuredValue = enforcer?.getValue()
    const structuredFailed = enforcer ? enforcer.isExhausted() : false
    const structuredSection = structuredSubmitted
      ? `\n\n已按要求提交规定格式的结果（校验通过）。以下是机器可读的结果数据（供后续步骤使用，可忽略）：\n\`\`\`json\n${JSON.stringify(structuredValue, null, 2)}\n\`\`\``
      : structuredFailed
        ? '\n\n【未完成】任务要求交付一份规定格式的结果，子 Agent 多次补交仍未通过检查，结果缺失。'
        : ''

    const marker = aborted
      ? `（子 Agent ${outcome.failed ?? '已被中断'}，以下为已获得的部分结果）`
      : outcome.failed
        ? `（子 Agent 出错：${outcome.failed}，以下为已获得的部分结果）`
        : structuredFailed
          ? '（子 Agent 未完成约定交付，以下为已获得的部分结果）'
          : ''
    const body = outcome.text.trim() || (marker ? '（无）' : '子 Agent 未产出报告。')

    // 报告全文落盘（同 explore 惯例：outputs 持久语义，失败退化为纯内存返回）
    let reportPath: string | undefined
    try {
      reportPath = `/workspace/outputs/subagent_reports/${runId}.md`
      const fileBody = `# 通用子 Agent 报告\n\n- 任务：${input.task}\n- 状态：${aborted ? '已中断' : outcome.failed ? `出错（${outcome.failed}）` : structuredFailed ? '未完成（未交出符合要求的结果）' : '完成'}\n\n${body}${structuredSection}\n`
      await writeFile(reportPath, fileBody)
    } catch (err) {
      console.warn('[agent:general] 报告落盘失败，退化为仅内存返回:', err)
      reportPath = undefined
    }

    let tracePath: string | undefined
    try {
      const trace = traceCollector.getCurrentTrace() ?? traceCollector.getLastCompletedTrace()
      if (trace) {
        // 落盘分层（2026-08-06，第一读者判据）：trace 是排查原料（机器场景）不是交付物，
        // 落 scratch（72h 自清，排查窗口足够）；报告 .md 第一读者是人，留 outputs。
        tracePath = `/workspace/scratch/subagent_traces/${runId}.trace.json`
        await writeFile(tracePath, JSON.stringify(trace, null, 2))
      }
    } catch (err) {
      console.warn('[agent:general] 轨迹落盘失败（不阻断）:', err)
      tracePath = undefined
    }

    const touchedSection =
      myTouched.length > 0 ? `\n本任务写入/修改的文件：${myTouched.join('、')}` : ''
    const footer =
      `---\n子 Agent 运行统计：${toolCalls} 次工具调用 · 新发现 ${discoveredCount} 个工具 · 耗时 ${(durationMs / 1000).toFixed(1)}s` +
      touchedSection +
      (conflictNote ? `\n${conflictNote}` : '') +
      (reportPath ? `\n报告全文已落盘：${reportPath}（可用 read_file 复核原文）` : '')
    const report = `${marker ? marker + '\n' : ''}${body}${structuredSection}\n\n${footer}`

    const status: GeneralRunResult['status'] = aborted
      ? 'cancelled'
      : outcome.failed || structuredFailed
        ? 'error'
        : 'done'
    const errorText =
      outcome.failed ??
      (aborted
        ? '已中断'
        : structuredFailed
          ? '子 Agent 没有交出符合要求的结果（多次补交仍未通过格式检查）'
          : undefined)

    runStore.finishRun(runId, {
      status,
      report,
      reportPath,
      tracePath,
      error: errorText,
      conflictNote,
    })

    return {
      content: report,
      runId,
      reportPath,
      // 执行器约定字段：声明全文已落盘，applyResultBudget 截断时引用同一路径
      persistedUrl: reportPath,
      stats: { toolCalls, discoveredTools: discoveredCount, durationMs },
      status,
      error: errorText,
      touchedFiles: myTouched,
      conflictNote,
      structuredOutput: enforcer
        ? { submitted: structuredSubmitted, value: structuredValue }
        : undefined,
    }
  } catch (err) {
    // 异常路径终态兜底（同 explore：运行记录不能永卡 running/queued）
    const rec = useSubAgentRunStore.getState().runs[runId]
    if (rec && (rec.status === 'running' || rec.status === 'queued')) {
      runStore.finishRun(runId, {
        status: signal?.aborted ? 'cancelled' : 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
    throw err
  } finally {
    release()
  }
}
