import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { cn } from '@/utils'
import { useChatStore } from '@/stores/chatStore'
import { useConversationStore } from '@/stores/conversationStore'
import { markManuallyEdited } from '@/stores/conversationTitleStore'
import { useAuthStore } from '@/stores/authStore'
import { useContextPanelStore } from '@/stores/contextPanelStore'
import { useArtifactDockStore } from '@/stores/artifactDockStore'
import { useRuntimeConfigStore } from '@/stores/runtimeConfigStore'
import { useFileStore } from '@/stores/fileStore'
import { useChartAskStore } from '@/stores/chartAskStore'
import { useLocalModelStore } from '@/stores/localModelStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSelectionQuote } from '@/hooks/useSelectionQuote'
import { configApi, normalizeBackendProviderConfig, userConfigApi, workspaceItemsApi } from '@/api/client'
import { workspaceItemToArtifact } from '@/types/artifactDock'
import { PROVIDERS } from '@/api/providerPresets'
import { getProviderKeyEntry } from '@/services/providerKeyVault'
import { useProviderProfileStore } from '@/stores/providerProfileStore'
import { deriveProfileRuntime, isProfileProviderId, profileIdFromProviderId } from '@/types/providerProfile'
import { MessageList } from './MessageList'
import { TurnRail } from './TurnRail'
import { InputArea } from './InputArea'
import { FloatingActionBar } from './FloatingActionBar'
import { SubAgentView } from './SubAgentView'
import { RightPanel } from './RightPanel'
import { Portal } from '@/components/common/Portal'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { toast } from 'sonner'
import { showMemoryToast, dismissMemoryToast } from '@/components/Memory/MemoryToast'
import { MemoryMote } from '@/components/Memory/MemoryMote'
import { exportConversation } from '@/utils/exportConversation'
import { mergeProviderCatalog } from '@/utils/providerCatalog'
import { credentialAutofillGuard } from '@/utils/autofillGuard'
import {
  ChevronDown,
  ChevronLeft,
  Bot,
  ShieldCheck,
  Check,
  ListTree,
} from 'lucide-react'
import { openTaskConversation } from './TaskSessionCard'

interface ChatViewProps {
  onNavigate?: (view: string) => void
}

function providerDisplayName(t: TFunction, providerId: string): string {
  // 供应商预设库（2026-09-07）：profile:<id> 显示 profile 名
  if (isProfileProviderId(providerId)) {
    const profileId = profileIdFromProviderId(providerId)
    const profile = useProviderProfileStore.getState().profiles.find((p) => p.id === profileId)
    if (profile) return profile.name
  }
  const i18nKey = providerId.replace(/-([a-z])/g, (_, char) => char.toUpperCase())
  const chatVal = t(`chat.providers.${i18nKey}`)
  if (chatVal !== `chat.providers.${i18nKey}`) return chatVal
  const settingsVal = t(`settings.provider.${i18nKey}`)
  if (settingsVal !== `settings.provider.${i18nKey}`) return settingsVal
  return providerId
}

// 2026-08-05 收窄内置补齐目录：与设置页同白名单（DeepSeek + 私有化 custom）。
// 【Iris 2026-09】tokenhub 付费通道已删除。本白名单只影响"内置补齐"——后端已
// 配置项（含企业模型）、本地模型照常进入下拉，不受此白名单影响。
const CHAT_BUILTIN_VISIBLE = new Set(['deepseek', 'custom'])
const BUILT_IN_PROVIDER_CONFIGS = Object.entries(PROVIDERS)
  .filter(([providerId, provider]) => CHAT_BUILTIN_VISIBLE.has(providerId) && !!provider.defaultModel)
  .map(([providerId, provider]) => ({
    provider: providerId,
    model: provider.defaultModel,
    baseUrl: provider.baseUrl,
  }))

// 未保存过选择时的兜底：优先 DeepSeek（2026-08-05 用户拍板主力默认），没有再取首项
function pickFallbackProvider<T extends { provider: string }>(list: T[]): T | undefined {
  return list.find((p) => p.provider === 'deepseek') ?? list[0]
}

const LOCAL_MODEL_PROVIDERS = new Set(['ollama', 'lmstudio', 'webllm'])

// 下拉项 Key 状态探测（2026-08-05 修正语义）：只认真实存在的 Key——
// 本地模型 / 供应商预设库 / 本机保险柜 / 设置页存到后端的 Key。
// "后端有 provider 配置行"≠有 Key（AiProviderConfig 表不含 Key），不能据此亮绿灯。
async function probeProviderKey(provider: string): Promise<boolean> {
  if (LOCAL_MODEL_PROVIDERS.has(provider)) return true
  // 供应商预设库：凭证即 profile env 派生值
  if (isProfileProviderId(provider)) {
    const profileId = profileIdFromProviderId(provider)
    const profile = useProviderProfileStore.getState().profiles.find((p) => p.id === profileId)
    const derived = profile ? deriveProfileRuntime(profile) : null
    return !!derived?.apiKey
  }
  if (getProviderKeyEntry(provider)?.apiKey) return true
  try {
    const r = await userConfigApi.getApiKey(provider)
    return !!r.apiKey
  } catch {
    return false
  }
}

export function ChatView({ onNavigate }: ChatViewProps) {
  const { t } = useTranslation()
  // R4: 按字段选择器订阅，避免整 store 变化触发 ChatView 重渲染
  const messages = useChatStore((s) => s.messages)
  // 轮迹目录入口门槛：与 TurnRail 的 MIN_TURNS 一致（安静：短对话不出入口按钮）
  const turnCount = useMemo(
    () => messages.filter((m) => m.role === 'user' && !m.isSupplement).length,
    [messages]
  )
  const isLoading = useChatStore((s) => s.isLoading)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const providers = useChatStore((s) => s.providers)
  const activeProvider = useChatStore((s) => s.activeProvider)
  const activeKeySource = useChatStore((s) => s.activeKeySource)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const stopStreaming = useChatStore((s) => s.stopStreaming)
  const sendSupplement = useChatStore((s) => s.sendSupplement)
  const setActiveProvider = useChatStore((s) => s.setActiveProvider)
  const setProviders = useChatStore((s) => s.setProviders)

  const {
    conversations,
    currentConversationId,
    updateConversationTitle,
  } = useConversationStore()

  const { isLoggedIn } = useAuthStore()
  const { isOpen: rightPanelOpen, setOpen: setRightPanelOpen } = useContextPanelStore()
  const dockOpen = useArtifactDockStore((s) => s.isOpen)
  const dockToggle = useArtifactDockStore((s) => s.toggle)
  const dockUnseen = useArtifactDockStore((s) => s.unseenIds.size)
  // 管理员模式：部署级开关（runtime-config.adminEnabled）开启即显示小圆点入口，
  // 与个人提权无关——只读管理工具的数据安全由后端工具自身脱敏保证；会话级开关不持久化
  // 2026-08-07 拍板：管理员对话用处小、干扰体验，前端入口暂时隐藏下线（不删代码，
  // 恢复=把下面常量的 false 改回 true；后端部署级开关 runtime-config.adminEnabled 保持不变）
  const ADMIN_ENTRY_HIDDEN = true
  const adminEnabled =
    useRuntimeConfigStore((s) => s.config.adminEnabled) === true && !ADMIN_ENTRY_HIDDEN
  const adminMode = useChatStore((s) => s.adminMode)
  const setAdminMode = useChatStore((s) => s.setAdminMode)
  const { loadConversationAttachments, clearPendingFiles, attachments } = useFileStore()

  // 当 Dock 打开时自动关闭 RightPanel（避免布局冲突）
  useEffect(() => {
    if (dockOpen && rightPanelOpen) {
      setRightPanelOpen(false)
    }
  }, [dockOpen, rightPanelOpen, setRightPanelOpen])

  const [showProviders, setShowProviders] = useState(false)

  // 触顶状态条 v13：平时全隐，触顶热区 / 滚回顶上拉唤出；开关来自设置 topbarAutoHide（默认 true）
  const topbarAutoHide = useSettingsStore((s) => s.topbarAutoHide)
  const [topbarOn, setTopbarOn] = useState(false)
  const [turnNavOpen, setTurnNavOpen] = useState(false)
  const stripHideTimer = useRef<number | null>(null)
  const showProvidersRef = useRef(false)

  useEffect(() => {
    showProvidersRef.current = showProviders
  }, [showProviders])

  const showTopbar = useCallback(() => {
    if (stripHideTimer.current) {
      clearTimeout(stripHideTimer.current)
      stripHideTimer.current = null
    }
    setTopbarOn(true)
  }, [])

  const hideTopbarSoon = useCallback((ms: number) => {
    if (stripHideTimer.current) {
      clearTimeout(stripHideTimer.current)
      stripHideTimer.current = null
    }
    stripHideTimer.current = window.setTimeout(() => {
      // 下拉开着时保持条展示，避免固定下拉悬空
      if (showProvidersRef.current) return
      setTopbarOn(false)
      setShowProviders(false)
    }, ms)
  }, [])

  // 滚到顶后继续上拉 → 唤出状态条（只读 .wf-chat-scroll scroller，不动 MessageList）
  useEffect(() => {
    if (!topbarAutoHide) return
    const onWheel = (e: WheelEvent) => {
      const el = e.currentTarget as HTMLElement
      if (el.scrollTop <= 0 && e.deltaY < 0) {
        showTopbar()
        // 兜底：鼠标没落到条上也会自动收回，避免卡在顶上
        hideTopbarSoon(1600)
      }
    }
    const scroller = document.querySelector<HTMLElement>('.wf-chat-scroll')
    if (!scroller) return
    scroller.addEventListener('wheel', onWheel, { passive: true })
    return () => scroller.removeEventListener('wheel', onWheel)
  }, [topbarAutoHide, showTopbar, hideTopbarSoon, messages.length])

  // 关闭自动隐藏 → 回退常驻粘性：清空收起态，避免残留
  useEffect(() => {
    if (!topbarAutoHide) {
      if (stripHideTimer.current) {
        clearTimeout(stripHideTimer.current)
        stripHideTimer.current = null
      }
      setTopbarOn(false)
      setShowProviders(false)
    }
  }, [topbarAutoHide])

  // 卸载清理定时器
  useEffect(() => {
    return () => {
      if (stripHideTimer.current) clearTimeout(stripHideTimer.current)
    }
  }, [])

  // v9：对话列宽档位 → --wf-col-max（turn 容器与输入框共用同一变量，保证对齐）
  const chatWidth = useSettingsStore((s) => s.chatWidth)
  useEffect(() => {
    document.documentElement.style.setProperty('--wf-col-max', `${chatWidth}px`)
  }, [chatWidth])

  // v9：选中正文 → 引用到输入框（quote chip）
  // 记忆之野：同一浮条第二动作 ✦ 收入记忆——显式点击才触发 LLM 誊写 pipeline
  const [quote, setQuote] = useState<string | null>(null)
  const rememberText = useChatStore((s) => s.rememberText)
  const quotePopover = useSelectionQuote(
    (text) => setQuote(text),
    (text) => {
      // 收入记忆（可回旋）：模型可婉拒（declined + 理由），用户点"仍要收入"则 force 重试
      const run = (force: boolean): void => {
        const workingId = showMemoryToast({ kind: 'working', title: t('memory.toast.working') })
        void rememberText(text, force ? { force: true } : undefined).then((r) => {
          dismissMemoryToast(workingId)
          const bucketLabel = r.bucket ? t(`memory.fileTypes.${r.bucket}`) : undefined
          if (r.ok && r.declined) {
            showMemoryToast({
              kind: 'declined',
              title: t('memory.toast.declined'),
              sub: r.reason,
              action: { label: t('memory.toast.rememberAnyway'), onAction: () => run(true) },
            })
          } else if (r.ok && r.skipped) {
            showMemoryToast({ kind: 'duplicate', title: t('memory.toast.duplicate') })
          } else if (r.ok && r.merged) {
            showMemoryToast({ kind: 'merged', title: t('memory.toast.merged'), bucketLabel, summary: r.summary })
          } else if (r.ok) {
            showMemoryToast({ kind: 'saved', title: t('memory.toast.saved'), sub: t('memory.toast.savedSub'), bucketLabel, summary: r.summary })
          } else {
            showMemoryToast({ kind: 'failed', title: t('memory.selbar.failed') })
          }
        }).catch(() => {
          // 链上任何 reject（动态 import chunk 失败等）都必须有终态反馈——
          // 否则 working toast 30s 自然消失、零反馈（2026-08-04 安装包实测）
          dismissMemoryToast(workingId)
          showMemoryToast({ kind: 'failed', title: t('memory.selbar.failed') })
        })
      }
      run(false)
    }
  )

  // 图表框选追问（蓝图 v13 askchip）：ChartRenderer 框选后 set 一条 pending，
  // 非空时灌进 quote chip（复用 v9 选中引用管线）；suggestion 字段本期不用
  const chartPending = useChartAskStore((s) => s.pending)
  useEffect(() => {
    if (chartPending) {
      setQuote(chartPending.quote)
      useChartAskStore.getState().clear()
    }
  }, [chartPending])

  // 下拉菜单按钮 ref（用于 Portal 定位）
  const providerButtonRef = useRef<HTMLButtonElement>(null)

  // 下拉项 Key 状态（provider → 是否有可用 Key），加载后+每次展开下拉时异步探测
  const [providerKeyStatus, setProviderKeyStatus] = useState<Record<string, boolean>>({})

  const refreshKeyStatus = useCallback(async (list: { provider: string }[]) => {
    const entries = await Promise.all(
      list.map(async (p) => [p.provider, await probeProviderKey(p.provider)] as const)
    )
    setProviderKeyStatus(Object.fromEntries(entries))
  }, [])

  // 初始化/Onboarding 完成共用：加载 provider 列表并选定当前激活项（2026-08-05 去重，原为两份重复逻辑）
  const reloadProviders = useCallback(async () => {
    try {
      const backendProviders = await configApi.getProviders()
      let list = mergeProviderCatalog(backendProviders, BUILT_IN_PROVIDER_CONFIGS)

      // 供应商预设库（2026-09-07）：有可派生运行视图的 profile 进下拉，
      // provider id 用 profile:<id> 命名空间，与内置项不冲突
      await useProviderProfileStore.getState().ensureLoaded()
      const profileEntries = useProviderProfileStore.getState().profiles
        .map((profile) => {
          const derived = deriveProfileRuntime(profile)
          return derived
            ? { provider: derived.providerId, model: derived.model, baseUrl: derived.baseUrl }
            : null
        })
        .filter((e): e is { provider: string; model: string; baseUrl: string } => e !== null)
      if (profileEntries.length > 0) list = [...profileEntries, ...list]

      // 追加本地模型（Ollama / LM Studio）选项
      {
        const localProviders = useLocalModelStore.getState().getProviderConfigs()
        const merged = [...list]
        for (const lp of localProviders) {
          const exists = merged.some(
            (p) => p.provider === lp.provider && p.model === lp.model
          )
          if (!exists) merged.push(lp)
        }
        list = merged
      }

      setProviders(list)
      void refreshKeyStatus(list)

      // 选定激活项：localStorage 保存的优先（须仍在目录中）→ DeepSeek 兜底
      const saved = localStorage.getItem('wonclaw_active_provider')
      if (saved) {
        try {
          const parsed = normalizeBackendProviderConfig(JSON.parse(saved))
          if (list.some((p) => p.provider === parsed.provider && p.model === parsed.model)) {
            setActiveProvider(parsed)
            return
          }
        } catch {
          // 存档损坏则继续走兜底
        }
      }
      const dflt = pickFallbackProvider(list)
      if (dflt) setActiveProvider(dflt)
    } catch {
      // 如果后端不可用，保持空列表，由用户手动选择
    }
  }, [setProviders, setActiveProvider, refreshKeyStatus])

  // 初始化加载 provider 列表
  useEffect(() => {
    if (providers.length === 0) {
      void reloadProviders()
    }
  }, [providers.length, reloadProviders])

  // 供应商预设库增删/改模型后即时刷新下拉
  const providerProfiles = useProviderProfileStore((s) => s.profiles)
  useEffect(() => {
    if (providers.length > 0) void reloadProviders()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerProfiles])

  // 切换对话时加载附件并清理待发送文件，同时清空预览坞产物状态并从后端索引水合还原
  useEffect(() => {
    if (currentConversationId) {
      loadConversationAttachments(currentConversationId)
      clearPendingFiles()
      // 清空预览坞产物状态（会话隔离），再从会话-文件索引水合该会话的历史产物
      const dock = useArtifactDockStore.getState()
      dock.clearConversation()
      const convId = currentConversationId
      workspaceItemsApi
        .list(convId)
        .then((items) => {
          // 竞态防护：响应回来时若已切到别的会话，丢弃
          if (useConversationStore.getState().currentConversationId !== convId) return
          if (items.length > 0) {
            useArtifactDockStore.getState().hydrateArtifacts(items.map(workspaceItemToArtifact))
          }
        })
        .catch((err) => {
          console.warn('[ChatView] 会话产物水合失败（忽略）:', err)
        })
    }
  }, [currentConversationId, loadConversationAttachments, clearPendingFiles])

  // 2026-07-31：上下文文件列表改为 ContextFilesPanel 内 useMemo 派生（原 effect 同步进 store 已删除）

  const handleSend = useCallback(
    (content: string, attachmentIds?: string[]) => {
      sendMessage(content, attachmentIds)
    },
    [sendMessage]
  )

  const currentConv = conversations.find((c) => c.id === currentConversationId)

  // 当前激活模型是否有可用 Key（调试展示：缺 Key 时按钮上琥珀点提醒；未探测到时按有处理避免误报）
  const activeKeyReady = activeProvider ? (providerKeyStatus[activeProvider.provider] ?? true) : true

  // 顶部标题内联编辑
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [editTitleValue, setEditTitleValue] = useState('')

  const startEditingTitle = () => {
    if (!currentConv) return
    setEditTitleValue(currentConv.title)
    setIsEditingTitle(true)
  }

  const commitTitleEdit = async () => {
    if (!currentConv) return
    const trimmed = editTitleValue.trim()
    if (trimmed && trimmed !== currentConv.title) {
      await updateConversationTitle(currentConv.id, trimmed)
      markManuallyEdited(currentConv.id)
    }
    setIsEditingTitle(false)
  }

  const cancelTitleEdit = () => {
    setIsEditingTitle(false)
  }

  return (
    <div className="relative flex-1 h-full overflow-hidden">
      {/* Main Chat Area */}
      <div className="h-full flex flex-col wf-chat-bg">
        {/* 触顶状态条 v13（macOS menu bar 式，平时全隐；topbarAutoHide=false 回退常驻粘性） */}
        {topbarAutoHide && (
          <div
            className="wf-topbar-hotzone"
            onMouseEnter={showTopbar}
            onMouseLeave={() => hideTopbarSoon(900)}
          />
        )}
        <div
          className={cn(
            'wf-topbar',
            !topbarAutoHide && 'wf-topbar-sticky',
            topbarAutoHide && topbarOn && 'on'
          )}
          onMouseEnter={topbarAutoHide ? showTopbar : undefined}
          onMouseLeave={topbarAutoHide ? () => hideTopbarSoon(500) : undefined}
        >
          <div className="wf-topbar-inner">
            <div className="wf-topbar-l">
              <img src="/iris-logo.png" alt="Iris" className="wf-topbar-logo" />
              {/* 任务会话（parentConversationId 存在）顶栏给返回主对话入口——
                  任务会话不进侧栏主列表，顶栏是唯一的明确回跳点 */}
              {currentConv?.parentConversationId != null && (
                <button
                  type="button"
                  className="wf-text-btn"
                  onClick={() => openTaskConversation(currentConv.parentConversationId!)}
                  title={t('chat.taskSession.backToParent')}
                >
                  <ChevronLeft size={14} />
                  {t('chat.taskSession.backToParent')}
                </button>
              )}
              {isEditingTitle ? (
                <input
                  type="text"
                  value={editTitleValue}
                  onChange={(e) => setEditTitleValue(e.target.value)}
                  onBlur={commitTitleEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitTitleEdit()
                    } else if (e.key === 'Escape') {
                      cancelTitleEdit()
                    }
                  }}
                  autoFocus
                  className="text-sm font-semibold text-[var(--wf-ink)] bg-[var(--wf-bg)] border border-primary-300 rounded px-2 py-0.5 w-64 focus:outline-none focus:ring-2 focus:ring-primary-200"
                />
              ) : (
                <button
                  type="button"
                  onClick={startEditingTitle}
                  className="wf-topbar-title"
                  title={t('chat.chatView.clickToEditTitle')}
                >
                  {currentConv?.title || t('chat.chatView.newConversation')}
                </button>
              )}
              <span className="wf-topbar-meta">
                {t('chat.chatView.messageCount', { count: messages.length })}
              </span>
            </div>

          <div className="wf-topbar-r">

            {/* 管理员模式入口（小圆点）：仅提权用户可见；激活时圆点常亮 */}
            {adminEnabled && (
              <button
                onClick={() => void setAdminMode(!adminMode)}
                className={cn(
                  'relative p-1.5 rounded-lg transition-colors',
                  adminMode
                    ? 'bg-[var(--wf-warn-bg)] text-[var(--wf-warn-ink)]'
                    : 'hover:bg-[var(--wf-hover)] text-[var(--wf-faint)]'
                )}
                title={adminMode ? t('chat.chatView.exitAdminMode') : t('chat.chatView.enterAdminMode')}
              >
                <ShieldCheck size={18} />
                {adminMode && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[var(--wf-warn-ink)] border-2 border-white" />
                )}
              </button>
            )}

            {/* 轮迹目录入口（≥8 轮才出现；点开矩形提问目录卡，页面上零常驻元素） */}
            {turnCount >= 8 && (
              <button
                onClick={() => setTurnNavOpen((v) => !v)}
                className={cn('wf-sicon wf-turnnav-btn', turnNavOpen && 'on')}
                title={t('chat.turnRail.railLabel')}
                aria-label={t('chat.turnRail.railLabel')}
              >
                <ListTree size={18} />
              </button>
            )}

            {/* 预览坞开关（.sicon 方钮 + 蓝图式角标 = unseen 数；dock 关闭且有 unseen 才显示） */}
            <button
              onClick={dockToggle}
              className={cn('wf-sicon', dockOpen && 'on')}
              title={dockOpen ? t('chat.chatView.closeDock') : t('chat.chatView.openDock')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M3 9h18" />
                <path d="M9 21V9" />
              </svg>
              {!dockOpen && dockUnseen > 0 && (
                <span className="wf-sicon-bdg">{dockUnseen}</span>
              )}
            </button>

            {/* 记忆微尘（记忆之野 v11 顶栏入口） */}
            <MemoryMote />

            {/* Provider Selector */}
            <div className="relative">
              <button
                ref={providerButtonRef}
                onClick={() => {
                  const next = !showProviders
                  setShowProviders(next)
                  // 展开时重探 Key 状态（设置页刚存完 Key 回来能立刻变绿）
                  if (next) void refreshKeyStatus(providers)
                }}
                className="wf-modelchip"
                title={[
                  activeProvider ? `${activeProvider.provider} · ${activeProvider.model}` : '',
                  activeKeySource ? t('chat.chatView.keySource', { source: activeKeySource }) : '',
                  !activeKeyReady ? t('chat.chatView.keyMissing') : '',
                ].filter(Boolean).join('\n') || undefined}
              >
                {!activeKeyReady && (
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--wf-warn-ink)] flex-shrink-0" />
                )}
                <Bot size={14} className="text-primary-500" />
                <span>
                  {activeProvider
                    ? providerDisplayName(t, activeProvider.provider)
                    : t('chat.chatView.selectModel')}
                </span>
                {activeKeySource && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--wf-mono-bg)]/70 text-[var(--wf-mut)] max-w-[120px] truncate">
                    {activeKeySource}
                  </span>
                )}
                <ChevronDown size={14} className="text-[var(--wf-faint)]" />
              </button>

              {showProviders && (
                <Portal>
                  <div
                    className="fixed w-56 bg-[var(--wf-card-bg)] border border-[var(--wf-line)] rounded-lg shadow-lg z-[100] py-1 max-h-80 overflow-y-auto"
                    style={{
                      top: providerButtonRef.current ? providerButtonRef.current.getBoundingClientRect().bottom + 4 : 0,
                      right: providerButtonRef.current ? window.innerWidth - providerButtonRef.current.getBoundingClientRect().right : 0,
                    }}
                  >
                    {/* 思考强度入口已迁到输入坞右缘芽轨（2026-09-07 拍板：下行=可配置项，
                        点击弹选项窗；此处下拉只留渠道切换） */}
                    {providers.map((p, idx) => {
                      const keyReady = providerKeyStatus[p.provider] === true
                      const isActive = activeProvider?.provider === p.provider && activeProvider?.model === p.model
                      // 2026-09-07 排版修复：预设与内置渠道混排时同名供应商（如两个 DeepSeek 预设
                      // + 内置 DeepSeek）三行无法区分来源。分组标题标明归属；预设行附协议徽标
                      // （deepseek/deepseek1 这类同名不同协议的卡靠它区分）。
                      const isProfile = isProfileProviderId(p.provider)
                      const prevIsProfile = idx > 0 && isProfileProviderId(providers[idx - 1].provider)
                      const showGroupLabel = idx === 0 || isProfile !== prevIsProfile
                      const profileFormat = isProfile
                        ? useProviderProfileStore.getState().profiles.find(
                            (pr) => pr.id === profileIdFromProviderId(p.provider)
                          )?.meta.apiFormat
                        : undefined
                      return (
                        <div key={`${p.provider}-${p.model}`}>
                          {showGroupLabel && (
                            <div className="px-3 pt-1.5 pb-0.5 text-[10px] text-[var(--wf-faint)] select-none">
                              {isProfile
                                ? t('chat.chatView.groupProfiles')
                                : t('chat.chatView.groupBuiltin')}
                            </div>
                          )}
                        <button
                          onClick={() => {
                            setActiveProvider(p)
                            localStorage.setItem('wonclaw_active_provider', JSON.stringify(p))
                            // 供应商预设库：下拉直选 profile 时同步 store.activeId，
                            // 设置页"在用"徽标与这里是同一事实
                            const pid = isProfileProviderId(p.provider) ? profileIdFromProviderId(p.provider) : null
                            if (pid) void useProviderProfileStore.getState().setActive(pid)
                            setShowProviders(false)
                          }}
                          className={cn(
                            'w-full text-left px-3 py-2 text-sm hover:bg-[var(--wf-hover)] transition-colors flex items-center gap-2',
                            isActive && 'bg-primary-50 text-primary-700'
                          )}
                          title={keyReady
                            ? t('chat.chatView.keyReady')
                            : t('chat.chatView.keyMissing')}
                        >
                          <span
                            className={cn(
                              'w-1.5 h-1.5 rounded-full flex-shrink-0',
                              keyReady ? 'bg-[var(--wf-ok-ink)]' : 'bg-[var(--wf-mut)]'
                            )}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="font-medium truncate flex items-center gap-1.5">
                              <span className="truncate">{providerDisplayName(t, p.provider)}</span>
                              {profileFormat && (
                                <span className="flex-shrink-0 text-[9px] px-1 py-px rounded border border-[var(--wf-hair)] text-[var(--wf-faint)]">
                                  {profileFormat === 'anthropic' ? 'Anthropic' : 'OpenAI'}
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-[var(--wf-faint)] truncate">{p.model}</div>
                          </div>
                          {isActive && <Check size={14} className="flex-shrink-0 text-primary-500" />}
                        </button>
                        </div>
                      )
                    })}
                    {onNavigate && (
                      <div className="border-t border-[var(--wf-hair)] mt-1 pt-1">
                        <button
                          onClick={() => {
                            setShowProviders(false)
                            onNavigate('settings')
                          }}
                          className="w-full text-left px-3 py-2 text-xs text-[var(--wf-mut)] hover:bg-[var(--wf-hover)] hover:text-primary-600 transition-colors"
                        >
                          {t('chat.chatView.manageApiConfig')}
                        </button>
                      </div>
                    )}
                  </div>
                </Portal>
              )}
            </div>
          </div>
          </div>{/* wf-topbar-inner */}
        </div>{/* wf-topbar */}

        {/* Messages */}
        {/* key=会话 id：切换会话时重建 Virtuoso，借 initialTopMostItemIndex 归位底部，
            避免沿用旧会话的 scrollTop 落在新会话任意位置 */}
        <MessageList key={currentConversationId ?? 'new'} messages={messages} />

        {/* 轮迹目录（v3）：零常驻元素，顶栏图标唤出矩形目录 + 回到最新；只读滚动器，不碰消息流 */}
        <TurnRail open={turnNavOpen && turnCount >= 8} onClose={() => setTurnNavOpen(false)} />

        {/* 坞下硬边界蒙版：正文滚到坞中线被一刀切（"吸入"体感，实现=不透明板） */}
        <div className="wf-dock-mask" />

        {/* Input */}
        <InputArea
          onSend={handleSend}
          onStop={stopStreaming}
          isLoading={isLoading}
          isStreaming={isStreaming}
          disabled={!isLoggedIn}
          onSendSupplement={sendSupplement}
          quote={quote}
          onClearQuote={() => setQuote(null)}
        />

        {/* 浮动操作栏（审批 + ask_user 反问）：与 .wf-input-bar 同一包含块，
            absolute 定位天然同中线——不做任何视口补偿 */}
        <FloatingActionBar messages={messages} />

        {/* 选中引用浮条（position:fixed） */}
        {quotePopover}

        {/* 子 Agent 对话页（胶囊点开，整屏覆层） */}
        <SubAgentView />
      </div>

      {/* Right Panel */}
      <RightPanel />
    </div>
  )
}

export default ChatView
