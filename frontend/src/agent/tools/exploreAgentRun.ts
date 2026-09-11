import type { Message, ProviderConfig, ToolCatalogItem } from '@/types/mescli'
import type { AgenticLoopHandle } from '@/agent/agenticLoop'
import { createToolRegistry } from '@/agent/toolRegistry'
import { createToolExecutor } from '@/agent/toolExecutor'
import { startAgenticLoop } from '@/agent/agenticLoop'
import { createTraceCollector } from '@/agent/traceCollector'
import { applyBackendToolOverrides } from '@/agent/backendToolOverrides'
import { readFileTool, listFilesTool, globTool, grepTool } from './fileTools'
import { recallFactsTool } from './factTools'
import {
  createListCapabilitiesTool,
  createReadCapabilityTool,
} from './capabilityDiscoveryTools'
import { webSearchTool, webFetchTool } from './web'
import { webBridgeClient } from '@/api/webbridgeClient'
import { writeFile } from '@/services/fileSystem'
import { useSessionToolStore } from '@/stores/sessionToolStore'
import { useSubAgentRunStore } from '@/stores/subAgentRunStore'
import { getRuntimeMode } from '@/utils/runtimeMode'
import {
  buildExploreAgentSystemPrompt,
  type ExploreThoroughness,
} from '@/agent/exploreAgentPrompt'
import { buildAnswerLanguageNote } from '@/agent/prompt'
import type { ChatMessage } from '@/types/chat'
import type { ToolExecutionContext } from '@/agent/types'

/**
 * explore_agent 子 Agent 运行体（同步/异步共用的完整生命周期）。
 *
 * 从 exploreAgentTool.ts 拆出（2026-08-01 异步化）：工具模块只负责"同步等结果 /
 * 派发到 subAgentManager 后台"的分派，运行体独立成模块保持 import 无环
 * （manager → 本模块；工具 → manager + 本模块）。
 *
 * 内核设计（2026-07-31，对齐 claude-code AgentTool/Explore 的机制，按 WonWork 约束收敛）：
 * - 复用 startAgenticLoop 换参数再调一次：独立 registry / executor / trace / 消息序列，
 *   主 loop 的 UI 副作用全部经回调注入——子 Agent 传无头回调，天然零干扰；
 * - 上下文隔离：子 Agent 只有 [系统提示, 任务描述]，看不到主对话历史；
 * - 只读强制（结构性，不靠提示词）：
 *   ① 写工具不进子注册表（write_file/str_replace/delete_file/present_artifact/python/webbridge 操作原语等缺席）；
 *   ② 不提供 onApprovalRequested → 审批闸不存在 → 需审批的调用（SQL 写、业务写工具）fail-close 拒绝；
 *   ③ 继承的已发现工具名只放行只读项；
 * - 深度守卫：explore_agent 自身不注册进子注册表，子 Agent 无法再派生；
 * - 并发守卫：模块级信号量（默认 3），排队可被中断；
 * - 取消传播：signal 由调用方持有——同步路径=父 loop 工具调用 abort（级联），
 *   异步路径=manager 自持 AbortController（刻意不级联，claude-code 同款：
 *   后台 Agent 应存活过主 loop 停止，终止只能显式 cancel_subagent / UI 按钮）。
 */

export const EXPLORE_AGENT_TOOL_NAME = 'explore_agent'

/** 彻底程度 → 最大轮数（quick 直奔目标，thorough 允许长链排查） */
const TURNS_BY_THOROUGHNESS: Record<ExploreThoroughness, number> = {
  quick: 8,
  medium: 15,
  thorough: 25,
}

export interface ExploreAgentInput {
  /** 自足的任务描述：背景、目标、关心的对象与口径、期望的报告形式 */
  task: string
  /** 彻底程度：quick 快速定位 / medium 适度交叉验证 / thorough 穷尽排查 */
  thoroughness?: ExploreThoroughness
  /** 2026-08-01 异步化：默认 true=后台运行（立即返回 runId，完成自动通知）；
   *  显式 false=同步等待报告作为工具结果返回（quick 点查等需要当场拿结论的场景） */
  run_in_background?: boolean
}

export interface ExploreAgentOutput {
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
    thoroughness: string
  }
}

/** 运行结果=工具输出+终态（异步路径 manager 据此组装完成通知） */
export interface ExploreRunResult extends ExploreAgentOutput {
  status: 'done' | 'error' | 'cancelled'
  error?: string
}

export interface ExploreAgentDeps {
  /** 解析模型调用凭据（复用主对话同一套 resolveProviderCredentials 逻辑） */
  getRuntime: () => Promise<{ provider: ProviderConfig; apiKey?: string; baseUrl?: string }>
  systemCode?: string
  conversationId?: number
  /** 拉取后端能力目录（与主对话同一 fetcher，命中 sessionToolStore 缓存时无网络） */
  fetchCatalog: () => Promise<{ tools: ToolCatalogItem[]; features: string[]; domainInsight?: string }>
  /** 主会话已发现的工具名（子 Agent 继承其中的只读项） */
  getInitialDiscoveredNames: () => Set<string>
  /** 子 Agent 新发现的工具名冒泡回会话级存储（父级后续轮次受益） */
  onToolsDiscovered?: (names: string[]) => void
}

export interface ExploreRunOptions {
  /** 父工具执行上下文的进度透传（仅同步路径有：喂主 loop watchdog/executionLog） */
  onProgress?: ToolExecutionContext['onProgress']
  /** 发起它的父瀑布工具调用 id（SubAgentFlow 挂靠链第①级显式接缝） */
  parentToolCallId?: string
  /** 子 loop 启动后回调句柄（异步路径 manager 持有，供 sendToSubAgent 补充注入） */
  onLoopHandle?: (handle: AgenticLoopHandle) => void
  /** 外部登记的 runId（异步路径 manager 生成后传入，保证注册表/运行记录/通知同一 id） */
  runId?: string
}

// ── 并发信号量：2026-08-01 提取为跨类型共享池（subAgentSlots.ts，总池 3） ──
import { acquireSubAgentSlot } from './subAgentSlots'

function normalizeThoroughness(value: unknown): ExploreThoroughness {
  return value === 'quick' || value === 'thorough' ? value : 'medium'
}

/** 写语义名字关键词（对齐 toolRegistry.inferIsReadOnly 的写关键词，另补业务写动词） */
const WRITE_NAME_PATTERN =
  /\b(create|insert|update|modify|write|delete|remove|drop|truncate|disable|destroy|purge|clear|publish|submit|approve|rollback|stop|save|assign|merge|split|import|export|generate)\b/i

/**
 * 纯写/破坏性判定：mixed 保留（如 execute_sql_query 读路径可用，写由无审批闸 fail-close 兜底）。
 * 2026-08-01 硬化（盲猜实验 P1）：不能只信后端元数据——已知存在标错债务（APS 工具
 * operationType 曾全标错）。名字含写语义关键词时不信 'read' 标注；元数据缺失/无法
 * 推断时按写处理（fail-closed，宁可误拦读不可漏放写）。
 * 2026-08-03 导出：general 的 readOnly 评审角色复用同一判定（单一事实源）。
 */
export function isPureWrite(meta: {
  name?: string
  operationType?: string
  isDestructive?: boolean
  riskLevel?: string
}): boolean {
  if (meta.isDestructive === true) return true
  if (meta.operationType === 'write') return true
  if (meta.operationType === 'mixed') return false
  if (meta.name && WRITE_NAME_PATTERN.test(meta.name)) return true
  if (meta.operationType === 'read') return false
  if (meta.riskLevel === 'read_only') return false
  return true
}

/** 继承的已发现工具名只放行只读项（写工具即便曾被父级发现，也不进子 Agent 上下文） */
function filterReadOnlyDiscovered(
  names: Set<string>,
  registry: ReturnType<typeof createToolRegistry>
): Set<string> {
  const allowed = new Set<string>()
  for (const name of names) {
    const tool = registry.get(name)
    if (!tool) continue
    const readOnly = tool.isReadOnly || tool.operationType === 'read'
    if (readOnly && !tool.isDestructive) allowed.add(name)
  }
  return allowed
}

function firstLine(text: string | undefined): string | undefined {
  if (!text) return undefined
  const line = text.split('\n').find((l) => l.trim().length > 0)
  return line?.slice(0, 80)
}

/** 收尾预警提前量（2026-08-02）：剩余轮数 ≤ 此值时注入系统补充让子 Agent 主动收束。
 *  与 generalAgentRun 同款逻辑，修改需两边同步。 */
const WRAP_UP_WARN_REMAINING = 3

export function makeExploreRunId(): string {
  return `explore-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * 跑完一个 explore 子 Agent 的完整生命周期（注册表构建 → 子 loop → 报告组装 → 落盘 → 终态）。
 * signal 语义见模块头注释：同步=父级级联 abort，异步=manager 显式 kill/guard 超时。
 */
export async function runExploreAgentSession(
  input: ExploreAgentInput,
  deps: ExploreAgentDeps,
  signal: AbortSignal | undefined,
  options?: ExploreRunOptions
): Promise<ExploreRunResult> {
  const runStore = useSubAgentRunStore.getState()
  const runId = options?.runId ?? makeExploreRunId()
  const thoroughness = normalizeThoroughness(input.thoroughness)
  const startedAt = Date.now()

  runStore.enqueueRun({
    runId,
    task: input.task,
    thoroughness,
    conversationId: deps.conversationId,
    parentToolCallId: options?.parentToolCallId,
  })

  const release = await acquireSubAgentSlot(signal).catch((err: Error) => {
    runStore.finishRun(runId, { status: 'cancelled', error: err.message })
    throw err
  })

  try {
    runStore.markRunning(runId)

    // 1. 能力目录（命中会话缓存时无网络往返）
    let catalog: ToolCatalogItem[] = []
    if (deps.conversationId != null) {
      try {
        const result = await useSessionToolStore
          .getState()
          .ensureSessionTools(deps.conversationId, getRuntimeMode(), deps.systemCode, deps.fetchCatalog)
        catalog = result.tools
      } catch (err) {
        console.warn('[explore_agent] 加载能力目录失败，退化为仅本地只读原语:', err)
      }
    }

    // 2. 子注册表：只读工具集（写工具结构性缺席；explore_agent 自身不注册=深度守卫）
    const registry = createToolRegistry({ systemCode: deps.systemCode })
    if (catalog.length > 0) {
      // 目录预过滤：纯写/破坏性工具不进入子镜像（第一道），
      // mixed（SQL 等读写混合）保留——写路径由无审批闸 fail-close 兜底（第二道），
      // read_capability 发现通道由 acceptTool 拦截（第三道）。
      const readOnlyCatalog = catalog.filter((item) => !isPureWrite(item))
      registry.loadFromCatalog(readOnlyCatalog)
      applyBackendToolOverrides(registry)
    }
    registry.register(readFileTool)
    registry.register(listFilesTool)
    registry.register(globTool)
    registry.register(grepTool)
    // 子环境不展示 /webbridge 目录：浏览器写原语（click/type 等）本就不注册进子注册表，
    // 列出来只会诱导模型反复 read_capability 空转（盲猜实验 P2）
    registry.register(
      createListCapabilitiesTool({ systemCode: deps.systemCode, registry, includeWebBridge: false })
    )
    registry.register(
      createReadCapabilityTool({
        systemCode: deps.systemCode,
        registry,
        acceptTool: (schema) => !isPureWrite(schema),
      })
    )
    // 技能工具已退役（2026-09-03 文件化）：explore 只读探索，技能正文可由主 Agent 需要时读取转述
    // 环境事实查询（只读件）：探索常需要环境坐标（SVN 检出路径等）；写件留主 loop
    registry.register(recallFactsTool)
    if (webBridgeClient.isConnected) {
      registry.register(webSearchTool)
      registry.register(webFetchTool)
    }

    const initialDiscoveredToolNames = filterReadOnlyDiscovered(
      deps.getInitialDiscoveredNames(),
      registry
    )

    // 3. 独立上下文：只有 [系统提示, 任务]，不携带主对话历史。
    // 提示按实际能力条件化（盲猜实验 P1：静态"假设全集"会在 website-online/空目录时
    // 输出虚构指引——给 SQL Server 域发 SQLite 方言、承诺不存在的业务工具）。
    // SQL 可用性看目录不看模式；方言：local=SQLite demo，其余（含 website-online 默认域）=SQL Server。
    const mode = getRuntimeMode()
    const hasSqlTool = catalog.some(
      (t) => t.name === 'execute_sql_query' || (t.path?.endsWith('/execute_sql_query') ?? false)
    )
    let systemPrompt = buildExploreAgentSystemPrompt({
      thoroughness,
      sql: hasSqlTool
        ? { dialect: mode === 'mescli-local' ? ('sqlite' as const) : ('sqlserver' as const) }
        : undefined,
      hasCapabilityPrimitives: catalog.length > 0,
    })
    // 回答语言注记（仅英文界面注入，中文不加）——调研报告会直接回流对话展示
    const languageNote = buildAnswerLanguageNote()
    if (languageNote) systemPrompt += `\n\n${languageNote}`
    const requestMessages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input.task },
    ]

    const { provider, apiKey, baseUrl } = await deps.getRuntime()

    // 轨迹收集器提出来持有引用：loop 结束后序列化落盘（行为漂移/幻觉排查依据——
    // TrajectoryLogger.persist 已关停，不落盘则 25 轮工具细节只剩 80 字符摘要）
    const traceCollector = createTraceCollector()

    // 4. 无头回调跑子 loop：UI 副作用零注入，运行态沉淀到 subAgentRunStore
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
      // 进度透传：同步路径喂主 loop watchdog（否则 thorough 长跑 30s 无进展被误报
      // "可能已卡住"，诱导用户误中断）；liveLine 直写 runStore——异步模式下父工具节点
      // 秒回、executionLog 不再供料，store 成为"当前在做什么"的唯一稳定数据源
      const reportChildProgress = (message: string) => {
        useSubAgentRunStore.getState().setLiveLine(runId, message)
        options?.onProgress?.({
          toolCallId: '',
          toolName: EXPLORE_AGENT_TOOL_NAME,
          status: 'running',
          message,
        })
      }

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
        // 子 Agent 无审批闸：executionMode 传何值都不会触发用户审批——
        // 缺 approvalGate 时写操作 fail-close 拒绝（结构性只读的第②层）
        executionMode: 'auto',
        conversationId: deps.conversationId,
        systemCode: deps.systemCode,
        requestMessages,
        traceCollector,
        toolRegistry: registry,
        toolExecutor: createToolExecutor(registry),
        maxTurns: TURNS_BY_THOROUGHNESS[thoroughness],
        enableFrontendToolLoop: true,
        initialDiscoveredToolNames,
        // consult_state 门控豁免（同 generalAgentRun）：子 Agent 循环不拦写前对账
        stateConsultExempt: true,
        // 任务原文压后重注入（盲猜实验残留项修复）：任务是首条 user 消息，
        // autoCompact 时会落进被压缩段，保真度全押在摘要模型复述良心上——
        // thorough 25 轮+小窗口模型可能朝着漂移后的目标跑。
        // 任务是调用方手里现成的不变原文，压后逐字重注入=结构性保真
        // （对标 claude-code attachments 槽位，不依赖摘要第 6/9 节的自觉）。
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
            // 上限管"不死"，预警管"死前把报告写完"；只注入一次，续命后不重复打扰。
            turnCount += 1
            if (!wrapUpWarned && turnCount >= TURNS_BY_THOROUGHNESS[thoroughness] - WRAP_UP_WARN_REMAINING) {
              wrapUpWarned = true
              handle.supplement(
                `【系统提示】轮次预算将尽（已用 ${turnCount}/${TURNS_BY_THOROUGHNESS[thoroughness]} 轮）。` +
                '请立即停止开新的调查，用手头已有成果输出最终报告；没查清的部分如实说明，不要硬凑结论。'
              )
            }
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
          // 故意不提供 onApprovalRequested——审批闸缺席即只读强制
          onError: (error) => {
            settle({ text: latestAssistant?.content ?? '', failed: error.message })
          },
          onDone: (assistant) => {
            settle({ text: assistant.content ?? latestAssistant?.content ?? '' })
          },
        },
      })

      // 异步路径接缝：manager 持有句柄后可向运行中的子 Agent 注入用户补充
      // （claude-code SendMessage→pendingMessages 的对应物，子 loop supplement 队列现成）
      options?.onLoopHandle?.(handle)

      // 取消传播+终态兜底：agenticLoop.abort() 不发任何终态回调（只停流/毁调度器），
      // 外层 Promise 必须在 abort 路径自行 settle——否则运行体永久挂起：信号量槽位
      // 泄漏（中止 3 次后 explore_agent 整场不可用）、runStore 永卡 running（盲猜实验 P0）。
      // 已 aborted 的信号不会再触发事件（前置 await 期间可能已被中断），挂监听后立即补检。
      const settleAborted = () => {
        handle.abort()
        const reason = signal?.reason
        const isTimeout = reason instanceof Error && reason.message.startsWith('工具调用超时')
        settle({ text: latestAssistant?.content ?? '', failed: isTimeout ? '执行超时' : '已中断' })
      }
      signal?.addEventListener('abort', settleAborted, { once: true })
      if (signal?.aborted) settleAborted()
    })

    // 5. 汇报组装：失败终态区分（中断/错误/正常），部分结果不丢
    const rec = useSubAgentRunStore.getState().runs[runId]
    const toolCalls = rec?.toolEvents.length ?? 0
    const discoveredCount = rec?.discoveredNames.length ?? 0
    const durationMs = Date.now() - startedAt
    const aborted = signal?.aborted === true

    const marker = aborted
      ? `（子 Agent ${outcome.failed ?? '已被中断'}，以下为已获得的部分结果）`
      : outcome.failed
        ? `（子 Agent 出错：${outcome.failed}，以下为已获得的部分结果）`
        : ''
    const body = outcome.text.trim() || (marker ? '（无）' : '子 Agent 未产出报告。')

    // 报告全文落盘（长程任务信息不丢/可溯源主线，对齐工具结果落盘兜底先例）：
    // 放 outputs 而非 scratch——scratch 72h 清理，长程任务复核需求以 outputs 持久语义为准。
    // 落盘失败退化为纯内存返回，不阻断工具结果（同 applyResultBudget 哲学）。
    let reportPath: string | undefined
    try {
      reportPath = `/workspace/outputs/subagent_reports/${runId}.md`
      const fileBody = `# 探索子 Agent 报告\n\n- 任务：${input.task}\n- 彻底程度：${thoroughness}\n- 状态：${aborted ? '已中断' : outcome.failed ? `出错（${outcome.failed}）` : '完成'}\n\n${body}\n`
      await writeFile(reportPath, fileBody)
    } catch (err) {
      console.warn('[explore_agent] 报告落盘失败，退化为仅内存返回:', err)
      reportPath = undefined
    }

    let tracePath: string | undefined
    try {
      // complete/fail 会清空 currentTrace 为下一条让位，loop 结束后必须读 lastCompleted
      // （此前直读 getCurrentTrace() 恒 undefined，轨迹落盘成为死代码——实证：磁盘只有 .md 没有 .trace.json）
      const trace = traceCollector.getCurrentTrace() ?? traceCollector.getLastCompletedTrace()
      if (trace) {
        // 落盘分层（2026-08-06，第一读者判据）：trace 是排查原料（机器场景）不是交付物，
        // 落 scratch（72h 自清，排查窗口足够）；报告 .md 第一读者是人，留 outputs。
        tracePath = `/workspace/scratch/subagent_traces/${runId}.trace.json`
        await writeFile(tracePath, JSON.stringify(trace, null, 2))
      }
    } catch (err) {
      console.warn('[explore_agent] 轨迹落盘失败（不阻断）:', err)
      tracePath = undefined
    }

    const footer =
      `---\n子 Agent 运行统计：${toolCalls} 次工具调用 · 新发现 ${discoveredCount} 个工具 · 耗时 ${(durationMs / 1000).toFixed(1)}s` +
      (reportPath ? `\n报告全文已落盘：${reportPath}（可用 read_file 复核原文）` : '')
    const report = `${marker ? marker + '\n' : ''}${body}\n\n${footer}`

    const status: ExploreRunResult['status'] = aborted ? 'cancelled' : outcome.failed ? 'error' : 'done'
    const errorText = outcome.failed ?? (aborted ? '已中断' : undefined)

    runStore.finishRun(runId, {
      status,
      report,
      reportPath,
      tracePath,
      error: errorText,
    })

    return {
      content: report,
      runId,
      reportPath,
      // 执行器约定字段：声明全文已落盘，applyResultBudget 截断时引用同一路径
      // 而非另写 tool_results 副本（盲猜实验 P2：双重落盘导致两份指针口径分裂）
      persistedUrl: reportPath,
      stats: { toolCalls, discoveredTools: discoveredCount, durationMs, thoroughness },
      status,
      error: errorText,
    }
  } catch (err) {
    // 异常路径终态兜底：凭据解析失败、loop 构造抛错等任何未预期抛出，
    // 都不能让运行记录永远卡在 running/queued（UI 会显示一张永远跑不完的子任务卡）。
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
