import { historyApi, toolApi } from '@/api/client'
import { enqueuePersist, resolveProviderCredentials, useChatStore } from '@/stores/chatStore'
import { useConversationStore } from '@/stores/conversationStore'
import { useSessionToolStore } from '@/stores/sessionToolStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSubAgentRunStore } from '@/stores/subAgentRunStore'
import { isLocalRuntime } from '@/utils/runtimeMode'
import { launchBackgroundSubAgent, type SubAgentCompletion } from '@/agent/subAgentManager'
import { makeGeneralRunId, runGeneralAgentSession, type GeneralAgentDeps } from '@/agent/tools/generalAgentRun'
import type { ApprovalRequest } from '@/agent/types'
import type { ChatMessage, Conversation } from '@/types/chat'
import { toast } from 'sonner'
import i18n from '@/i18n'

/**
 * backgroundAgent —— 代码侧派遣后台 agent 的公共入口（2026-08-05 pipeline/agent/cron 一体系统）。
 *
 * 定位：agent 作为"增强版 pipeline"被代码触发（对照 claude-code execAgentHook/forkedAgent）。
 * 与 agent 工具（主 agent 决策派遣）同源同运行体（runGeneralAgentSession），差别只在调用方：
 * - 主 agent 派遣：完成经 chatStore 通知注入主对话；
 * - 代码派遣（本入口）：完成走自己的落库通道——整段对话落后端 SQLite 成为一个真实会话，
 *   侧栏自然出现，用户点开能看过程、能接着提问（定时任务的结论接力日常工作，
 *   不发明第二种体验）。默认不唤醒模型、不打扰主对话。
 *
 * 防干扰设计（对照 claude-code 三件套）：
 * - source 归因标签进日志；kind='cron' 进运行注册表（可见/可 kill）；
 * - onComplete 自备回调跳过 chatStore 通知注入；
 * - 任何失败静默——本入口是增强而非主链路，返回 { status:'error' } 不抛出。
 *
 * 边界条件（无人值守审批策略，对照 execAgentHook 的权限收窄）：
 * - 工作区文件写入（write_file/str_replace/delete_file 且路径在 /workspace/ 下）放行——
 *   周报 excel 等产出物靠它；
 * - execute_python_script 放行（后端沙箱兜底，生成产物引擎）；
 * - 其余需审批的写操作（业务库写/MES 业务操作）自动拒绝——拒绝文本进报告，
 *   agent 会在结论里如实说明"哪些没做"。
 */

export interface BackgroundAgentRequest {
  /** 自足任务 prompt（自包含、有完成标准、有边界——cron_create 工具负责引导生成） */
  prompt: string
  /** 会话标题（侧栏显示=任务名） */
  title: string
  /** 归因标签（日志/运行注册表 kind，如 'cron'） */
  source?: string
  /** 业务域（缺省取 localStorage 当前域，与 createConversation 同口径） */
  systemCode?: string
  /** 后台 guard 超时（默认 15min，任务级可配） */
  timeoutMs?: number
}

export interface BackgroundAgentResult {
  status: 'done' | 'error' | 'cancelled'
  /** 落库会话 id（创建失败为 null——执行仍继续，结果只回内存报告） */
  conversationId: number | null
  report: string
  error?: string
  durationMs: number
}

/** 无人值守审批策略：工作区写原语 + 沙箱 python 放行，其余写操作自动拒绝 */
const UNATTENDED_FILE_WRITE_TOOLS = new Set(['write_file', 'str_replace', 'delete_file'])
const UNATTENDED_SANDBOX_TOOLS = new Set(['execute_python_script'])
const UNATTENDED_DENY_REASON =
  '定时任务无人值守：该写操作需要人工审批，已自动跳过。请在结论中如实说明此项未执行；用户如需执行会在对话中手动发起。'

function unattendedApproval(
  request: ApprovalRequest,
  resolve: (approved: boolean, reason?: string) => void
): void {
  const path = typeof request.rawParams?.path === 'string' ? request.rawParams.path : ''
  if (UNATTENDED_FILE_WRITE_TOOLS.has(request.toolName) && path.trim().startsWith('/workspace/')) {
    resolve(true)
    return
  }
  if (UNATTENDED_SANDBOX_TOOLS.has(request.toolName)) {
    resolve(true)
    return
  }
  resolve(false, UNATTENDED_DENY_REASON)
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** 建会话但不劫持当前视图（conversationStore.createConversation 会切 currentConversationId，不能用） */
async function createDetachedConversation(title: string, systemCode: string): Promise<number | null> {
  try {
    const result = await historyApi.createConversation({ title })
    const userId = Number(localStorage.getItem('wonclaw_user_id')) || 0
    const conv: Conversation = {
      id: result.id,
      userId,
      title: result.title,
      systemCode,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    useConversationStore.setState((s) => ({ conversations: [conv, ...s.conversations] }))
    return result.id
  } catch (err) {
    console.warn('[backgroundAgent] 创建落库会话失败，本次执行结果将只回内存报告:', err)
    return null
  }
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

export async function launchBackgroundAgent(req: BackgroundAgentRequest): Promise<BackgroundAgentResult> {
  const startedAt = Date.now()
  const source = req.source ?? 'cron'
  const systemCode =
    req.systemCode ?? localStorage.getItem('wonclaw_system_code')?.trim() ?? 'local'

  // 1. 先建落库会话（真实 id）：能力目录会话缓存/发现工具名都挂这个 id——
  //    用户之后打开该会话接着提问时，工具缓存是热的，连续性一致。
  const conversationId = await createDetachedConversation(req.title, systemCode)

  // 2. 任务 prompt 落库为会话首条用户消息（异步不阻断执行）
  if (conversationId != null) {
    const userMessage: ChatMessage = {
      id: makeId(),
      role: 'user',
      content: req.prompt,
      timestamp: Date.now(),
    }
    enqueuePersist(() => historyApi.saveMessage(conversationId, userMessage)).catch((err) =>
      console.warn('[backgroundAgent] 任务消息落库失败（不阻断）:', err)
    )
  }

  // 3. 装配 deps：与主对话同源（凭据/目录/发现工具名），审批走无人值守策略
  const deps: GeneralAgentDeps = {
    systemCode,
    conversationId: conversationId ?? undefined,
    getRuntime: async () => {
      const provider = useChatStore.getState().activeProvider
      if (!provider) {
        throw new Error('当前没有可用的模型配置（activeProvider 为空），请先完成模型设置')
      }
      const creds = await resolveProviderCredentials(provider, { silent: true })
      return {
        provider: { ...provider, model: creds.model, baseUrl: creds.baseUrl },
        apiKey: creds.apiKey,
        baseUrl: creds.baseUrl,
      }
    },
    fetchCatalog: async () => {
      const capabilities = await toolApi.capabilitiesFull(isLocalRuntime() ? 'local' : systemCode)
      return {
        tools: capabilities.tools || [],
        features: capabilities.features || [],
        domainInsight: capabilities.domainInsight,
      }
    },
    getInitialDiscoveredNames: () =>
      useSessionToolStore.getState().getDiscoveredNames(conversationId ?? -1),
    onToolsDiscovered: (names) => {
      if (conversationId != null) {
        const now = Date.now()
        useSessionToolStore.getState().addDiscoveredLeases(
          conversationId,
          names.map((name) => ({ name, lastUsedAt: now }))
        )
      }
    },
    requestApproval: unattendedApproval,
    getExecutionMode: () => useSettingsStore.getState().permissionMode,
  }

  // 4. 经 manager 派遣（运行注册表可见/可 kill + guard 超时）；onComplete 自备回调
  //    跳过 chatStore 通知注入——结果落库为独立会话，不打扰主对话
  const runId = makeGeneralRunId()
  const completion = await new Promise<SubAgentCompletion>((resolve) => {
    launchBackgroundSubAgent({
      runId,
      kind: source,
      conversationId: conversationId ?? undefined,
      task: req.prompt,
      timeoutMs: req.timeoutMs ?? 15 * 60 * 1000,
      onComplete: resolve,
      run: (signal, onLoopHandle) =>
        runGeneralAgentSession({ task: req.prompt }, deps, signal, { onLoopHandle, runId }).then(
          (out) => ({
            status: out.status,
            report: out.content,
            reportPath: out.reportPath,
            error: out.error,
            touchedFiles: out.touchedFiles,
            conflictNote: out.conflictNote,
          })
        ),
    })
  })

  // 5. 结果落库为会话的助手消息（content=结论报告，thinkingProcess=执行过程）
  if (conversationId != null) {
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
    try {
      await enqueuePersist(() => historyApi.saveMessage(conversationId, assistantMessage))
    } catch (err) {
      console.warn('[backgroundAgent] 结果消息落库失败:', err)
    }
  }

  const ok = completion.status === 'done'
  // 轻量通知：toast 一行，不唤醒模型不切视图（更重的呈现形态=前端页面阶段单独设计）
  if (ok) {
    toast.success(i18n.t('chat.toast.cronDone', { title: req.title }))
  } else {
    toast.error(
      i18n.t('chat.toast.cronFailed', {
        status:
          completion.status === 'cancelled'
            ? i18n.t('chat.toast.cronStatusCancelled')
            : i18n.t('chat.toast.cronStatusFailed'),
        title: req.title,
      })
    )
  }

  return {
    status: completion.status,
    conversationId,
    report: completion.report,
    error: completion.error,
    durationMs: Date.now() - startedAt,
  }
}
