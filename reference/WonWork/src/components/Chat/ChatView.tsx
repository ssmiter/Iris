import { useEffect, useState, useCallback, useRef } from 'react'
import { cn } from '@/utils'
import { useChatStore } from '@/stores/chatStore'
import { useConversationStore } from '@/stores/conversationStore'
import { useConversationTitleStore } from '@/stores/conversationTitleStore'
import { useAuthStore } from '@/stores/authStore'
import { useContextPanelStore } from '@/stores/contextPanelStore'
import { useArtifactDockStore } from '@/stores/artifactDockStore'
import { useFileStore } from '@/stores/fileStore'
import { useSkillStore } from '@/stores/skillStore'
import { useLocalModelStore } from '@/stores/localModelStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSelectionQuote } from '@/hooks/useSelectionQuote'
import { supportsLocalModel } from '@/config/product'
import { configApi, IS_STANDALONE, normalizeBackendProviderConfig, workspaceItemsApi } from '@/api/client'
import { workspaceItemToArtifact } from '@/types/artifactDock'
import { getStandaloneConfig, setStandaloneConfig, PROVIDERS } from '@/api/standaloneApi'
import { useApiKeyStore } from '@/stores/apiKeyStore'
import { MessageList } from './MessageList'
import { InputArea } from './InputArea'
import { RightPanel } from './RightPanel'
import { ContextCapacityBar } from './ContextCapacityBar'
import { Portal } from '@/components/common/Portal'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { exportConversation } from '@/utils/exportConversation'
import {
  ChevronDown,
  Bot,
  PanelRight,
  Wrench,
  X,
} from 'lucide-react'

interface ChatViewProps {
  onNavigate?: (view: string) => void
}

function getDefaultProviderFromStandaloneConfig(
  available: { provider: string; model: string; baseUrl?: string }[]
): { provider: string; model: string; baseUrl: string } | null {
  const config = getStandaloneConfig()
  const baseUrl = config.apiBase || PROVIDERS[config.provider]?.baseUrl || ''
  const candidate = {
    provider: config.provider,
    model: config.model,
    baseUrl,
  }
  const exists = available.some(
    (p) => p.provider === candidate.provider && p.model === candidate.model
  )
  return exists ? candidate : null
}

export function ChatView({ onNavigate }: ChatViewProps) {
  const { t } = useTranslation()
  // R4: 按字段选择器订阅，避免整 store 变化触发 ChatView 重渲染
  const messages = useChatStore((s) => s.messages)
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
  const { isOpen: rightPanelOpen, togglePanel: toggleRightPanel, setContextFiles, setOpen: setRightPanelOpen } = useContextPanelStore()
  const dockOpen = useArtifactDockStore((s) => s.isOpen)
  const dockToggle = useArtifactDockStore((s) => s.toggle)
  const dockUnseen = useArtifactDockStore((s) => s.unseenIds.size > 0)
  const { skills, activeSkillIds, loadSkill, unloadSkill } = useSkillStore()
  const { loadConversationAttachments, clearPendingFiles, attachments } = useFileStore()

  // 当 Dock 打开时自动关闭 RightPanel（避免布局冲突）
  useEffect(() => {
    if (dockOpen && rightPanelOpen) {
      setRightPanelOpen(false)
    }
  }, [dockOpen, rightPanelOpen, setRightPanelOpen])

  const [showProviders, setShowProviders] = useState(false)
  const [showSkillDropdown, setShowSkillDropdown] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)

  // v9：对话列宽档位 → --wf-col-max（turn 容器与输入框共用同一变量，保证对齐）
  const chatWidth = useSettingsStore((s) => s.chatWidth)
  useEffect(() => {
    document.documentElement.style.setProperty('--wf-col-max', `${chatWidth}px`)
  }, [chatWidth])

  // v9：选中正文 → 引用到输入框（quote chip）
  const [quote, setQuote] = useState<string | null>(null)
  const quotePopover = useSelectionQuote((text) => setQuote(text))

  // 下拉菜单按钮 ref（用于 Portal 定位）
  const skillButtonRef = useRef<HTMLButtonElement>(null)
  const providerButtonRef = useRef<HTMLButtonElement>(null)

  // Standalone 模式下检测是否需要显示 Provider/API Key Onboarding
  useEffect(() => {
    if (!IS_STANDALONE) return
    if (messages.length > 0) {
      setShowOnboarding(false)
      return
    }
    const config = getStandaloneConfig()
    const hasKey = !!config.apiKey || !!useApiKeyStore.getState().getDefaultApiKey('chat')
    setShowOnboarding(!hasKey)
  }, [messages.length])

  // 初始化加载 provider 列表
  useEffect(() => {
    if (providers.length === 0) {
      configApi
        .getProviders()
        .then((backendProviders) => {
          let list = backendProviders.length > 0 ? backendProviders : []

          // Standalone 模式下追加本地模型（Ollama / LM Studio）选项
          if (supportsLocalModel) {
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

          const saved = localStorage.getItem('wonclaw_active_provider')
          if (saved) {
            try {
              const parsed = normalizeBackendProviderConfig(JSON.parse(saved))
              const exists = list.some(
                (p) => p.provider === parsed.provider && p.model === parsed.model
              )
              if (exists) {
                setActiveProvider(parsed)
              } else if (IS_STANDALONE) {
                // Standalone 模式下没有显式保存的 provider 时，以 standalone_config 为准
                const fallback = getDefaultProviderFromStandaloneConfig(list)
                if (fallback) setActiveProvider(fallback)
                else if (list.length > 0) setActiveProvider(list[0])
              } else if (list.length > 0) {
                setActiveProvider(list[0])
              }
            } catch {
              if (IS_STANDALONE) {
                const fallback = getDefaultProviderFromStandaloneConfig(list)
                if (fallback) setActiveProvider(fallback)
                else if (list.length > 0) setActiveProvider(list[0])
              } else if (list.length > 0) {
                setActiveProvider(list[0])
              }
            }
          } else if (IS_STANDALONE) {
            const fallback = getDefaultProviderFromStandaloneConfig(list)
            if (fallback) setActiveProvider(fallback)
            else if (list.length > 0) setActiveProvider(list[0])
          } else if (list.length > 0) {
            setActiveProvider(list[0])
          }
        })
        .catch(() => {
          // 如果后端不可用，保持空列表，由用户手动选择
        })
    }
  }, [setProviders, setActiveProvider, providers.length])

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

  // 同步附件和系统生成文件到右侧面板
  useEffect(() => {
    const userFiles = attachments.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      size: a.size,
    }))

    const sysFiles = messages
      .filter((m) => m.role === 'tool' && m.structuredData && typeof m.structuredData === 'object')
      .map((m) => m.structuredData as Record<string, unknown>)
      .filter((data) => 'downloadUrl' in data && typeof data.downloadUrl === 'string')
      .map((data, idx) => ({
        id: `sys-${idx}-${String(data.downloadUrl).slice(-8)}`,
        name: String(data.fileName || t('chat.messageBubble.downloadFile')),
        type: 'document',
        size: 0,
        downloadUrl: String(data.downloadUrl),
      }))

    setContextFiles([...userFiles, ...sysFiles])
  }, [attachments, messages, currentConversationId, setContextFiles])

  const handleSend = useCallback(
    (content: string, attachmentIds?: string[]) => {
      sendMessage(content, attachmentIds)
    },
    [sendMessage]
  )

  const currentConv = conversations.find((c) => c.id === currentConversationId)

  // 顶部标题内联编辑
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [editTitleValue, setEditTitleValue] = useState('')
  const markManuallyEdited = useConversationTitleStore((s) => s.markManuallyEdited)

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
      <div className="h-full flex flex-col bg-[#fafafa]">
        {/* Top Bar */}
        <div className="wf-topbar">
          <div className="wf-topbar-inner">
          <div className="flex items-center gap-3">
            <div>
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
                  className="text-sm font-semibold text-surface-800 bg-surface-50 border border-primary-300 rounded px-2 py-0.5 w-64 focus:outline-none focus:ring-2 focus:ring-primary-200"
                />
              ) : (
                <h2
                  onClick={startEditingTitle}
                  className="text-sm font-semibold text-surface-800 cursor-pointer hover:text-primary-600 select-text rounded px-1 -ml-1 hover:bg-surface-100 transition-colors"
                  title={t('chat.chatView.clickToEditTitle')}
                >
                  {currentConv?.title || t('chat.chatView.newConversation')}
                </h2>
              )}
              <p className="text-xs text-surface-400">
                {t('chat.chatView.messageCount', { count: messages.length })}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <ContextCapacityBar />

            {/* Skill Indicator */}
            <div className="relative">
              <button
                ref={skillButtonRef}
                onClick={() => setShowSkillDropdown(!showSkillDropdown)}
                className={cn(
                  'relative p-1.5 rounded-lg transition-colors',
                  activeSkillIds.length > 0
                    ? 'bg-primary-100 text-primary-600'
                    : 'hover:bg-surface-100 text-surface-500'
                )}
                title={t('chat.chatView.loadedSkills')}
              >
                <Wrench size={18} />
                {activeSkillIds.length > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 bg-primary-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                    {activeSkillIds.length}
                  </span>
                )}
              </button>

              {showSkillDropdown && (
                <Portal>
                  <div
                    className="fixed w-56 bg-white border border-surface-200 rounded-lg shadow-lg z-[100] py-1"
                    style={{
                      top: skillButtonRef.current ? skillButtonRef.current.getBoundingClientRect().bottom + 4 : 0,
                      right: skillButtonRef.current ? window.innerWidth - skillButtonRef.current.getBoundingClientRect().right : 0,
                    }}
                  >
                    {activeSkillIds.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-surface-400">
                        {t('chat.chatView.noSkillLoaded')}
                      </div>
                    ) : (
                      <>
                        <div className="px-3 py-1 text-[10px] font-semibold text-surface-400 uppercase">
                          {t('chat.chatView.loaded')}
                        </div>
                        {activeSkillIds.map((id) => {
                          const skill = skills.find((s) => s.id === id)
                          if (!skill) return null
                          return (
                            <div
                              key={id}
                              className="flex items-center justify-between px-3 py-1.5 hover:bg-surface-50"
                            >
                              <span className="text-xs text-surface-700 truncate flex-1">
                                {skill.name}
                              </span>
                              <button
                                onClick={() => unloadSkill(id)}
                                className="p-0.5 rounded hover:bg-red-100 text-surface-400 hover:text-red-500 transition-colors"
                              >
                                <X size={10} />
                              </button>
                            </div>
                          )
                        })}
                      </>
                    )}
                    <div className="border-t border-surface-100 mt-1 pt-1">
                      <div className="px-3 py-1 text-[10px] font-semibold text-surface-400 uppercase">
                        {t('chat.chatView.manualLoad')}
                      </div>
                      {skills
                        .filter((s) => s.enabled && s.trigger.mode === 'manual' && !activeSkillIds.includes(s.id))
                        .map((skill) => (
                          <button
                            key={skill.id}
                            onClick={() => loadSkill(skill.id)}
                            className="w-full text-left px-3 py-1.5 text-xs text-surface-600 hover:bg-surface-50 transition-colors"
                          >
                            {skill.name}
                          </button>
                        ))}
                      {skills.filter((s) => s.enabled && s.trigger.mode === 'manual' && !activeSkillIds.includes(s.id)).length === 0 && (
                        <div className="px-3 py-1 text-xs text-surface-400">
                          {t('chat.chatView.noManualSkill')}
                        </div>
                      )}
                    </div>
                  </div>
                </Portal>
              )}
            </div>

            <button
              onClick={toggleRightPanel}
              className={cn(
                'p-1.5 rounded-lg transition-colors',
                rightPanelOpen
                  ? 'bg-primary-100 text-primary-600'
                  : 'hover:bg-surface-100 text-surface-500'
              )}
              title={rightPanelOpen ? t('chat.chatView.hidePanel') : t('chat.chatView.showPanel')}
            >
              <PanelRight size={18} />
            </button>

            {/* 预览坞开关（v7 prototype: § 预览面板 + unseen dot） */}
            <button
              onClick={dockToggle}
              className={cn(
                'relative p-1.5 rounded-lg transition-colors',
                dockOpen
                  ? 'bg-primary-100 text-primary-600'
                  : 'hover:bg-surface-100 text-surface-500'
              )}
              title={dockOpen ? '关闭预览坞' : '打开预览坞'}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M3 9h18" />
                <path d="M9 21V9" />
              </svg>
              {dockUnseen && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-500 border-2 border-white" />
              )}
            </button>

            {/* Provider Selector */}
            <div className="relative">
              <button
                ref={providerButtonRef}
                onClick={() => setShowProviders(!showProviders)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-surface-200 bg-surface-50 hover:bg-surface-100 transition-colors text-sm"
                title={activeKeySource ? `${activeProvider?.provider} · ${activeProvider?.model}\nKey 来源：${activeKeySource}` : undefined}
              >
                <Bot size={14} className="text-primary-500" />
                <span className="text-surface-700">
                  {activeProvider?.provider || t('chat.chatView.selectModel')}
                </span>
                {activeKeySource && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-200/70 text-surface-500 max-w-[120px] truncate">
                    {activeKeySource}
                  </span>
                )}
                <ChevronDown size={14} className="text-surface-400" />
              </button>

              {showProviders && (
                <Portal>
                  <div
                    className="fixed w-56 bg-white border border-surface-200 rounded-lg shadow-lg z-[100] py-1"
                    style={{
                      top: providerButtonRef.current ? providerButtonRef.current.getBoundingClientRect().bottom + 4 : 0,
                      right: providerButtonRef.current ? window.innerWidth - providerButtonRef.current.getBoundingClientRect().right : 0,
                    }}
                  >
                    {providers.map((p) => (
                      <button
                        key={`${p.provider}-${p.model}`}
                        onClick={() => {
                          setActiveProvider(p)
                          localStorage.setItem('wonclaw_active_provider', JSON.stringify(p))
                          setShowProviders(false)
                        }}
                        className={cn(
                          'w-full text-left px-3 py-2 text-sm hover:bg-surface-50 transition-colors',
                          activeProvider?.provider === p.provider && activeProvider?.model === p.model && 'bg-primary-50 text-primary-700'
                        )}
                      >
                        <div className="font-medium">{p.provider}</div>
                        <div className="text-xs text-surface-400">{p.model}</div>
                      </button>
                    ))}
                  </div>
                </Portal>
              )}
            </div>
          </div>
          </div>{/* wf-topbar-inner */}
        </div>{/* wf-topbar */}

        {/* Messages / Onboarding */}
        {showOnboarding ? (
          <StandaloneOnboarding
            onComplete={() => {
              setShowOnboarding(false)
              // 重新加载 provider 列表
              configApi.getProviders().then((backendProviders) => {
                let list = backendProviders.length > 0 ? backendProviders : []
                if (supportsLocalModel) {
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
                const saved = localStorage.getItem('wonclaw_active_provider')
                if (saved) {
                  try {
                    const parsed = normalizeBackendProviderConfig(JSON.parse(saved))
                    const exists = list.some(
                      (p) => p.provider === parsed.provider && p.model === parsed.model
                    )
                    if (exists) {
                      setActiveProvider(parsed)
                    } else if (list.length > 0) {
                      setActiveProvider(list[0])
                    }
                  } catch {
                    if (list.length > 0) setActiveProvider(list[0])
                  }
                } else if (list.length > 0) {
                  setActiveProvider(list[0])
                }
              })
            }}
          />
        ) : (
          <MessageList messages={messages} />
        )}

        {/* 底部渐隐遮罩：防止对话文本与浮动输入框重叠 */}
        <div className="wf-message-fade" />

        {/* Input */}
        <InputArea
          onSend={handleSend}
          onStop={stopStreaming}
          isLoading={isLoading}
          isStreaming={isStreaming}
          disabled={!isLoggedIn}
          onNavigate={onNavigate}
          onSendSupplement={sendSupplement}
          quote={quote}
          onClearQuote={() => setQuote(null)}
        />

        {/* 选中引用浮条（position:fixed） */}
        {quotePopover}
      </div>

      {/* Right Panel */}
      <RightPanel />
    </div>
  )
}

/**
 * Standalone 模式 Provider/API Key Onboarding 卡片
 */
interface StandaloneOnboardingProps {
  onComplete: () => void
}

function StandaloneOnboarding({ onComplete }: StandaloneOnboardingProps) {
  const { t } = useTranslation()
  type StandaloneProvider = keyof typeof PROVIDERS
  const [provider, setProvider] = useState<StandaloneProvider>('kimi')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  const providerOptions: { value: StandaloneProvider; label: string }[] = [
    { value: 'kimi', label: 'Kimi (Moonshot)' },
    { value: 'openai', label: 'OpenAI' },
    { value: 'claude', label: 'Claude (Anthropic)' },
    { value: 'deepseek', label: 'DeepSeek' },
    { value: 'qwen', label: '通义千问' },
    { value: 'zhipu', label: '智谱 AI' },
    { value: 'baichuan', label: '百川' },
    { value: 'spark', label: '讯飞星火' },
    { value: 'hunyuan', label: '腾讯混元' },
    { value: 'doubao', label: '火山豆包' },
    { value: 'ernie', label: '百度文心' },
    { value: 'custom', label: '自定义 OpenAI 兼容接口' },
  ]

  const selectedProvider = PROVIDERS[provider]
  const showBaseUrl = provider === 'custom'

  const handleSave = async () => {
    const trimmedKey = apiKey.trim()
    if (!trimmedKey) {
      toast.error(t('chat.onboarding.apiKeyRequired'))
      return
    }

    setIsSaving(true)
    try {
      const config = getStandaloneConfig()
      const newConfig: import('@/api/standaloneApi').StandaloneConfig = {
        ...config,
        provider: provider as import('@/api/standaloneApi').StandaloneConfig['provider'],
        apiKey: trimmedKey,
        model: selectedProvider?.defaultModel || config.model,
        apiBase: showBaseUrl ? baseUrl.trim() : selectedProvider?.baseUrl || config.apiBase,
      }
      setStandaloneConfig(newConfig)

      // 同时保存到 apiKeyStore，保持与现有设置页一致
      await useApiKeyStore.getState().createApiKey({
        name: `${selectedProvider?.name || provider} Key`,
        provider: provider as import('@/types/mescli').ApiKeyProvider,
        key: trimmedKey,
        baseUrl: showBaseUrl ? baseUrl.trim() : selectedProvider?.baseUrl,
        scope: 'all',
        isDefault: true,
      })

      localStorage.setItem(
        'wonclaw_active_provider',
        JSON.stringify({
          provider,
          model: newConfig.model,
          baseUrl: newConfig.apiBase,
        })
      )

      toast.success(t('chat.onboarding.saved'))
      onComplete()
    } catch (err) {
      toast.error(t('chat.onboarding.saveFailed'))
      console.error('Onboarding 保存失败:', err)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="flex-1 flex items-center justify-center bg-surface-50 px-4">
      <div className="w-full max-w-md bg-white border border-surface-200 rounded-2xl shadow-sm p-6 space-y-5">
        <div className="text-center space-y-2">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-primary-100 flex items-center justify-center">
            <Bot size={28} className="text-primary-600" />
          </div>
          <h2 className="text-lg font-semibold text-surface-800">{t('chat.onboarding.title')}</h2>
          <p className="text-sm text-surface-500">{t('chat.onboarding.description')}</p>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-surface-600 mb-1.5">{t('chat.onboarding.provider')}</label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as StandaloneProvider)}
              className="w-full px-3 py-2 text-sm bg-surface-50 border border-surface-200 rounded-lg focus:outline-none focus:border-primary-400"
            >
              {providerOptions.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          {showBaseUrl && (
            <div>
              <label className="block text-xs font-medium text-surface-600 mb-1.5">{t('chat.onboarding.baseUrl')}</label>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
                className="w-full px-3 py-2 text-sm bg-surface-50 border border-surface-200 rounded-lg focus:outline-none focus:border-primary-400"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-surface-600 mb-1.5">{t('chat.onboarding.apiKey')}</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t('chat.onboarding.apiKeyPlaceholder')}
              className="w-full px-3 py-2 text-sm bg-surface-50 border border-surface-200 rounded-lg focus:outline-none focus:border-primary-400"
            />
            <p className="text-[11px] text-surface-400 mt-1.5">{t('chat.onboarding.apiKeyHint')}</p>
          </div>
        </div>

        <button
          onClick={handleSave}
          disabled={isSaving || !apiKey.trim()}
          className={cn(
            'w-full py-2.5 rounded-lg text-sm font-medium transition-colors',
            apiKey.trim() && !isSaving
              ? 'bg-primary-500 text-white hover:bg-primary-600'
              : 'bg-surface-200 text-surface-400 cursor-not-allowed'
          )}
        >
          {isSaving ? t('chat.onboarding.saving') : t('chat.onboarding.startChat')}
        </button>
      </div>
    </div>
  )
}

/**
 * 保留空导出，避免文件被识别为模块时出错
 */
export default ChatView
