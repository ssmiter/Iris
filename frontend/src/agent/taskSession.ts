import { historyApi } from '@/api/client'
import { enqueuePersist, deliverSubAgentCompletion, useChatStore } from '@/stores/chatStore'
import { useConversationStore } from '@/stores/conversationStore'
import { useSessionToolStore } from '@/stores/sessionToolStore'
import { useSubAgentRunStore } from '@/stores/subAgentRunStore'
import { launchBackgroundSubAgent, type SubAgentCompletion } from '@/agent/subAgentManager'
import { runGeneralAgentSession, type GeneralAgentDeps } from '@/agent/tools/generalAgentRun'
import { registerTaskSessionFamily } from '@/agent/permissionRules'
import type { ChatMessage, Conversation } from '@/types/chat'
import type { Message } from '@/types/mescli'
import type { StructuredOutputSpec } from '@/agent/structuredOutput'

/**
 * taskSession —— 任务会话承载形态（2026-09-01 二阶段切片1，§16 设计拍板）。
 *
 * 定位：长程编码/多步骤执行任务的承载单元 = 落库会话 + ParentConversationId + TaskState
 * 状态机，零新机制。与 cron 派遣（backgroundAgent）的差别只在归属与回传方向：
 * - cron：会话独立出现在侧栏，结果不打扰主对话；
 * - 任务会话：归属父会话（不进侧栏主列表，入口=父会话任务卡），完成通知回传父会话——
 *   用户可在任务会话里看全过程、直接补充，结论回到派出它的对话里继续讨论。
 *
 * 复用清单（全部是既有机制，本模块只做编排）：
 * - createDetachedConversation 同款建会话（不劫持视图不切当前）；
 * - launchBackgroundSubAgent：后台 loop 自持 abort（主 loop ESC 不级联）+ guard 超时 +
 *   运行注册表可见/可 kill（cancel_subagent / message_subagent 直通）；
 * - completionOutbox 完成通知链：onComplete 自备做落库 + TaskState 回写，
 *   随后手动转发进全局通知出口（deliverSubAgentCompletion），通知落父会话；
 * - TaskState 状态机：running/done/error/cancelled 与 SubAgentCompletion.status 同构，
 *   创建即 running，完成回写（不触碰 UpdatedAt，状态流转不搅动列表排序）。
 *
 * 审批 = 与主对话同一权限面（2026-09-02 实测拍板，替代原预授权三档硬拒）：
 * 派遣工具的审批桥原样透传——任务会话里的审批照常冒泡进全局审批卡
 * （带"来自子 Agent"来源标签，用户在哪都能批）；用户暂不在场时 5 分钟超时
 * 自动拒绝、loop 继续跑其余工作（无人值守不死锁）。权限规则按家族共用：
 * 本对话档以父会话为键（registerTaskSessionFamily），主对话批准的直接继承，
 * 任务会话里批准的落回主对话键下——双向不重复询问。
 * 原三档硬拒（白名单外一律拒绝）实测反噬：run_command 整体不可用，子 Agent
 * 被迫绕道沙箱 Python 执行同一条命令——更不透明也没有更安全。
 *
 * 2026-09-02 拍板：plan 闭环（先计划后批准三段式）已退役——计划形态=二次确认，
 * 用户默认批准、极少取消，反复确认的学习成本高收益不明显；任务卡片机制保留。
 */

export interface TaskSessionLaunchInput {
  /** 自足任务描述（agent 工具 task 参数原文，含完成判据追加） */
  task: string
  /** 短描述（会话标题/任务卡展示用） */
  label: string
  /** 外部登记的 runId（派遣工具生成，注册表/运行记录/通知同一 id） */
  runId: string
  /** 父会话 id（归属+通知路由；缺省=当前会话之外，理论上派遣工具必传） */
  parentConversationId?: number
  /** 发起它的父瀑布工具调用 id（SubAgentFlow 挂靠链） */
  parentToolCallId?: string
  /** 结构化状态契约（透传 general 运行体，与普通派遣同语义） */
  structuredOutput?: StructuredOutputSpec
  /** 续跑（2026-09-02 §16.7 追问即续跑）：已存在任务会话的 id——不建新会话，
   *  该会话历史注入 loop 前缀，追问作为新 user 消息续进同一会话 */
  resumeTaskConversationId?: number
  /** 主对话侧装配的依赖（凭据/能力目录/发现工具名），本模块只替换审批策略与会话归属 */
  deps: GeneralAgentDeps
}

export interface TaskSessionLaunchResult {
  /** 任务会话 id（创建/校验失败=null——派遣工具据此拒派，不空烧轮次） */
  taskConversationId: number | null
  runId: string
  /** 失败原因码（派遣工具映射为模型的指引文案）：running=运行中 / not-task-session=目标非任务会话或不存在 / history-failed=历史读取失败或为空 */
  error?: 'running' | 'not-task-session' | 'history-failed'
}

/** 任务会话后台 guard 超时：长程编码任务以小时计（普通后台子 Agent 是 20min） */
const TASK_SESSION_TIMEOUT_MS = 60 * 60 * 1000
/** 任务会话轮数上限（§16.7 拍板放宽）：长程编码"改仓库+跑命令+反复验证"40 轮不够；
 *  上下文由 autoCompact 内核兜底，轮数是预算不是上下文 */
const TASK_SESSION_MAX_TURNS = 120

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** 建任务会话（落库 + 进 conversationStore 供任务卡/过滤消费），不劫持当前视图 */
async function createTaskConversation(
  title: string,
  parentConversationId: number | undefined,
  systemCode: string
): Promise<number | null> {
  try {
    const result = await historyApi.createConversation(
      parentConversationId != null ? { title, parentConversationId } : { title }
    )
    const userId = Number(localStorage.getItem('wonclaw_user_id')) || 0
    const conv: Conversation = {
      id: result.id,
      userId,
      title: result.title,
      systemCode,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // facade 返回类型不含该字段（mescli 实现有），归属以请求值为准
      parentConversationId: parentConversationId ?? null,
      taskState: 'running',
    }
    useConversationStore.setState((s) => ({ conversations: [conv, ...s.conversations] }))
    return result.id
  } catch (err) {
    console.warn('[taskSession] 创建任务会话失败:', err)
    return null
  }
}

/** TaskState 回写：后端列 + conversationStore 内存态同步（不触碰 UpdatedAt 由后端保证） */
function writeTaskState(
  taskConversationId: number,
  state: 'running' | 'done' | 'error' | 'cancelled'
): void {
  useConversationStore.setState((s) => ({
    conversations: s.conversations.map((c) =>
      c.id === taskConversationId ? { ...c, taskState: state } : c
    ),
  }))
  historyApi.updateTaskState(taskConversationId, state).catch((err) =>
    console.warn('[taskSession] TaskState 回写失败（内存态已更新，重启后回退 running）:', err)
  )
}

function buildExecutionLog(runId: string): string {
  const rec = useSubAgentRunStore.getState().runs[runId]
  if (!rec) return ''
  const lines = rec.toolEvents.map((ev) => {
    const mark = ev.status === 'done' ? '✓' : ev.status === 'error' ? '✗' : '…'
    return `${mark} ${ev.name}${ev.summary ? ` — ${ev.summary}` : ''}`
  })
  return [`任务：${rec.task}`, ...lines].join('\n')
}

/**
 * 派遣任务会话：建会话 → 任务落库首条 user 消息 → 后台 loop（会话归属=任务会话，
 * 通知归属=父会话）→ onComplete 做结果落库 + TaskState 回写 + 转发通知到父会话。
 * resumeTaskConversationId 存在=续跑（§16.7）：不建新会话，校验目标确为任务会话、
 * 历史注入 loop 前缀（requestMessages 状态数组语义），追问落库后续进同一会话——
 * 追问即续跑，任务会话历史=接力棒，主对话零新增概念。
 */
export async function launchTaskSession(input: TaskSessionLaunchInput): Promise<TaskSessionLaunchResult> {
  const { task, label, runId, parentConversationId, parentToolCallId, structuredOutput, resumeTaskConversationId, deps } = input
  const systemCode = deps.systemCode ?? localStorage.getItem('wonclaw_system_code')?.trim() ?? 'local'

  // 1. 会话就位：新建 or 续跑校验（承载形态是本体，落不了不派遣——空跑没处看过程=最坏形态）
  let taskConversationId: number | null
  let priorMessages: Message[] | undefined
  if (resumeTaskConversationId != null) {
    // 运行中闸：同一会话双运行互踩——运行中的补充走 message_subagent（派遣工具给指引）
    const runsState = useSubAgentRunStore.getState()
    const hasActiveRun = runsState.order.some((id) => {
      const r = runsState.runs[id]
      return r?.taskConversationId === resumeTaskConversationId && (r.status === 'queued' || r.status === 'running')
    })
    if (hasActiveRun) return { taskConversationId: null, runId, error: 'running' }
    // 归属校验：目标必须是任务会话（有父会话归属），防止把普通会话错挂成任务轨
    const conv = useConversationStore.getState().conversations.find((c) => c.id === resumeTaskConversationId)
    if (!conv || conv.parentConversationId == null) {
      return { taskConversationId: null, runId, error: 'not-task-session' }
    }
    // 历史=接力棒：user/assistant 正文序列注入 loop 前缀（tool 过程不进——报告已是综合结论）
    let history: Message[]
    try {
      history = await historyApi.getMessages(resumeTaskConversationId)
    } catch (err) {
      console.warn('[taskSession] 续跑历史读取失败:', err)
      return { taskConversationId: null, runId, error: 'history-failed' }
    }
    priorMessages = history
      .filter(
        (m) =>
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string' &&
          m.content.trim().length > 0
      )
      .map((m) => ({ role: m.role, content: m.content }) as Message)
    if (priorMessages.length === 0) {
      return { taskConversationId: null, runId, error: 'history-failed' }
    }
    taskConversationId = resumeTaskConversationId
    // 复活：终态 → running（任务卡/侧栏过滤即时反映，不触碰 UpdatedAt）
    writeTaskState(taskConversationId, 'running')
  } else {
    taskConversationId = await createTaskConversation(label, parentConversationId, systemCode)
    if (taskConversationId == null) {
      return { taskConversationId: null, runId }
    }
  }

  // 权限规则家族登记：本对话档规则以父会话为键（审批权限主对话/任务会话双向共用）。
  // 归属真相在会话记录（续跑时派遣方可能不是原父会话），输入参数兜底。
  {
    const conv = useConversationStore.getState().conversations.find((c) => c.id === taskConversationId)
    const familyParent = conv?.parentConversationId ?? parentConversationId
    if (familyParent != null) {
      registerTaskSessionFamily(String(taskConversationId), String(familyParent))
    }
  }

  // 2. 任务/追问落库为任务会话 user 消息（异步不阻断执行）；正在查看则即时上屏
  const userMessage: ChatMessage = {
    id: makeId(),
    role: 'user',
    content: task,
    timestamp: Date.now(),
  }
  if (useConversationStore.getState().currentConversationId === taskConversationId) {
    useChatStore.setState((s) => ({ messages: [...s.messages, userMessage] }))
  }
  enqueuePersist(() => historyApi.saveMessage(taskConversationId, userMessage)).catch((err) =>
    console.warn('[taskSession] 任务消息落库失败（不阻断）:', err)
  )

  // 3. 装配任务 deps：会话归属=任务会话 + 发现租约挂任务会话。
  //    审批不覆盖——派遣工具的审批桥原样透传（与主对话同一权限面，冒泡进全局审批卡）；
  //    本对话档规则共享由 registerTaskSessionFamily 家族键保证（见步骤 2 后登记）。
  const taskDeps: GeneralAgentDeps = {
    ...deps,
    conversationId: taskConversationId,
    getInitialDiscoveredNames: deps.getInitialDiscoveredNames,
    onToolsDiscovered: (names) => {
      // 发现租约挂任务会话（不从父会话冒泡——任务会话是独立工作空间）
      const now = Date.now()
      useSessionToolStore.getState().addDiscoveredLeases(
        taskConversationId,
        names.map((name) => ({ name, lastUsedAt: now }))
      )
    },
  }

  // 4. 经 manager 派遣：运行注册表归属=父会话（通知路由+运行胶囊过滤），
  //    taskConversationId 随运行记录/完成通知透传（任务会话内实况渲染与入口定位用）。
  //    续跑的运行任务带【续跑】语境行（落库的用户消息保持追问原文，包装只进 loop）。
  const runTask =
    resumeTaskConversationId != null
      ? `${task}\n\n【续跑】你在一个已存在的任务会话中继续工作：上方历史是此前的任务与你的结论，在此基础上接续，不要从零重来。`
      : task
  launchBackgroundSubAgent({
    runId,
    kind: 'task',
    conversationId: parentConversationId,
    taskConversationId,
    task,
    timeoutMs: TASK_SESSION_TIMEOUT_MS,
    onComplete: (completion) => {
      void handleTaskSessionCompletion(completion, taskConversationId!, runId)
    },
    run: (signal, onLoopHandle) =>
      runGeneralAgentSession({ task: runTask }, taskDeps, signal, {
        parentToolCallId,
        onLoopHandle,
        runId,
        taskConversationId,
        structuredOutput,
        priorMessages,
        maxTurns: TASK_SESSION_MAX_TURNS,
      }).then((out) => ({
        status: out.status,
        report: out.content,
        reportPath: out.reportPath,
        error: out.error,
        touchedFiles: out.touchedFiles,
        conflictNote: out.conflictNote,
        structuredOutput: out.structuredOutput,
      })),
  })

  return { taskConversationId, runId }
}

/** 完成编排：结果落库任务会话 → 正在查看则即时上屏 → TaskState 回写 → 通知转发父会话 */
async function handleTaskSessionCompletion(
  completion: SubAgentCompletion,
  taskConversationId: number,
  runId: string
): Promise<void> {
  // 结果落库为任务会话的助手消息（content=结论报告，thinkingProcess=执行过程）——
  // 用户打开任务会话时结论与过程都在（cron 同款形态）
  const assistantMessage: ChatMessage = {
    id: makeId(),
    role: 'assistant',
    content: completion.report || completion.error || '（任务未产出结论）',
    timestamp: Date.now(),
    thinkingProcess: {
      status: completion.status === 'done' ? 'completed' : 'error',
      executionLog: buildExecutionLog(runId),
      isExpanded: false,
    },
  }
  // 正在查看该任务会话：即时上屏（等下次 loadMessages 才有=用户盯着空白看结果已落库）
  if (useConversationStore.getState().currentConversationId === taskConversationId) {
    useChatStore.setState((s) => ({ messages: [...s.messages, assistantMessage] }))
  }
  try {
    await enqueuePersist(() => historyApi.saveMessage(taskConversationId, assistantMessage))
  } catch (err) {
    console.warn('[taskSession] 结果消息落库失败:', err)
  }

  writeTaskState(taskConversationId, completion.status)

  // 转发全局通知出口：completion.conversationId=父会话 → 忙时 supplement / 闲时 outbox 唤醒，
  // 与模型派遣的普通后台子 Agent 同通道（用户可立即继续讨论结论）
  deliverSubAgentCompletion(completion)
}
