import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { cn } from '@/utils'
import { configApi, userConfigApi } from '@/api/client'
import { setProviderKeyEntry } from '@/services/providerKeyVault'
import { useSettingsStore } from '@/stores/settingsStore'
import { isPreview, isMescli, isOnline, productDisplayName, supportsLocalModel } from '@/config/product'
import { getRuntimeMode } from '@/utils/runtimeMode'
import { useRuntimeConfigStore, isPaymentVisible } from '@/stores/runtimeConfigStore'
import { StandaloneSettingsView } from './StandaloneSettingsView'
import { LicenseSettingsView } from './LicenseSettingsView'
import { QuotaSettingsView } from './QuotaSettingsView'
import { PaymentSettingsView } from './PaymentSettingsView'
import { ApiKeySettingsView } from './ApiKeySettingsView'
import { LocalModelSettingsView } from './LocalModelSettingsView'
import { WebSearchSettingsView } from './WebSearchSettingsView'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { ProviderConfig, UserConfigDto } from '@/types/mescli'
import { useChatStore } from '@/stores/chatStore'
import { PERMISSION_MODE_OPTIONS } from '@/components/Chat/InputArea'
import type { ExecutionMode } from '@/agent/types'
import {
  getCapability,
  setUserWindowOverride,
  resolveContextWindow,
  parseWindowInput,
} from '@/services/modelCapabilityRegistry'
import {
  Settings,
  Server,
  Key,
  Globe,
  Save,
  Check,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  Bot,
  ShieldCheck,
} from 'lucide-react'

function formatProviderHost(baseUrl: string): string {
  if (!baseUrl) return ''
  try {
    const url = new URL(baseUrl)
    return url.host
  } catch {
    return baseUrl
  }
}

function getProviderLabel(t: TFunction, provider: string): string {
  return t(`settings.provider.${provider.replace(/-/g, '_')}`, { defaultValue: provider })
}

export function SettingsView() {
  const { t } = useTranslation()

  // ═══════════════════════════════════════════════════════════════
  // MESCLI 构建（企业内网版）：始终使用完整 Provider 配置页。
  // 每个 Provider 一张可展开卡片，model / baseUrl / apiKey / contextWindow
  // 逐项可编辑，数据走 MESCLI 后端 /api/config/providers + /api/userconfig。
  // ═══════════════════════════════════════════════════════════════
  if (isMescli) {
    return <MescliConfigView />
  }

  // ═══════════════════════════════════════════════════════════════
  // Online 构建 — 同一份安装包从公网下载，运行时按身份走三条路径。
  //
  // 判断 key：运行时模式（getRuntimeMode）决定当前身份，
  //          运行时 BYOK 配置（/api/auth/runtime-config → byokEnabled）
  //          决定是否开放 Provider 自配能力。
  //
  // 路径 A — 外部客户（website-online，byokEnabled=false）：
  //   TokenHub 订阅付费，不可自配 API Key。
  //   设置页：TokenHub 状态 + 额度 + 升级入口。
  //   未来可能：连 VPN 后也能访问内网能力（路径 B 降级），
  //            或自定义连接串 / Provider 实现全本地部署。
  //
  // 路径 B — 公司内部人员（mescli-online，已登 MES）：
  //   企业模型 + SQL Server 数据 + 业务工具全部可用。
  //   设置页：完整 Provider 配置 + License。
  //   后续可能：企业自带数据库（ConnectionStrings 开放配置），
  //            不统一用公司 DB。
  //
  // 路径 C — 公司内部测试（website-online，byokEnabled=true）：
  //   调试公网版行为但需自配 Key。
  //   设置页：完整 Provider 配置 + TokenHub。
  // ═══════════════════════════════════════════════════════════════
  if (isOnline) {
    const mode = getRuntimeMode()
    const runtimeCfg = useRuntimeConfigStore.getState().config
    const byok = runtimeCfg.byokEnabled
    // 公网 v1.0：BYOK 发布版（paymentEnabled=false）隐藏一切付费信息，
    // TokenHub/额度/升级卡片全部不渲染（代码保留，月底付费版恢复可见）。
    const showPayment = isPaymentVisible(runtimeCfg)

    // 路径 B 或 C：完整 Provider 配置，叠加商业化模块
    if (mode === 'mescli-online' || byok) {
      return (
        <MescliConfigView
          extraSections={
            <>
              <ApiKeySettingsView />
              {showPayment && <QuotaSettingsView />}
              {showPayment && <PaymentSettingsView />}
              <LicenseSettingsView />
            </>
          }
        />
      )
    }

    // 路径 A：外部客户，TokenHub + 简化设置
    return (
      <StandaloneSettingsView
        headerTitle={productDisplayName}
        headerSubtitle={t('settings.onlineSettings.subtitle')}
        topSections={
          <>
            {showPayment && <QuotaSettingsView />}
            {showPayment && <PaymentSettingsView />}
            <ApiKeySettingsView />
            <LicenseSettingsView />
          </>
        }
        bottomSections={
          <>
            {supportsLocalModel && <LocalModelSettingsView />}
          </>
        }
      />
    )
  }

  // ═══════════════════════════════════════════════════════════════
  // Preview 构建（开发/演示，无后端，浏览器直连 AI API）。
  // 保持原有 Standalone 设置页不变。
  // ═══════════════════════════════════════════════════════════════
  return (
    <StandaloneSettingsView
      headerTitle={productDisplayName}
      headerSubtitle={t('settings.previewSettings.subtitle')}
      topSections={
        <>
          <LicenseSettingsView />
          <ApiKeySettingsView />
        </>
      }
      bottomSections={
        <>
          {supportsLocalModel && <LocalModelSettingsView />}
        </>
      }
    />
  )
}

interface MescliConfigViewProps {
  /**
   * 注入到 Provider 列表上方的额外模块。
   * Online 构建使用此 prop 叠加 TokenHub / Quota / License 等商业化卡片；
   * MESCLI 构建不需要，留空即可。
   */
  extraSections?: ReactNode
}

function MescliConfigView({ extraSections }: MescliConfigViewProps) {
  const { t } = useTranslation()
  const { language, setLanguage, permissionMode, setPermissionMode } = useSettingsStore()
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [userConfigs, setUserConfigs] = useState<UserConfigDto[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingProvider, setEditingProvider] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle')

  const [editForm, setEditForm] = useState<{
    model: string
    baseUrl: string
    apiKey: string
    contextWindow: string
  }>({ model: '', baseUrl: '', apiKey: '', contextWindow: '' })

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const [pList, cList] = await Promise.all([
        configApi.getProviders(),
        userConfigApi.getConfigs(),
      ])
      setProviders(pList)
      setUserConfigs(cList)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.settingsView.loadError'))
    } finally {
      setIsLoading(false)
    }
  }, [t])

  useEffect(() => {
    loadData()
  }, [loadData])

  const handleEdit = useCallback(async (provider: string) => {
    const config = userConfigs.find((c) => c.provider === provider)
    const defaultProvider = providers.find((p) => p.provider === provider)
    let apiKey = config?.apiKey || ''
    if (!apiKey && config) {
      try {
        const keyResult = await userConfigApi.getApiKey(provider)
        apiKey = keyResult.apiKey
      } catch {
        // 忽略，可能未配置 API Key
      }
    }
    const model = config?.model || defaultProvider?.model || ''
    const cap = model ? getCapability(provider, model) : undefined
    setEditForm({
      model,
      baseUrl: config?.baseUrl || defaultProvider?.baseUrl || '',
      apiKey,
      contextWindow: cap?.userOverride ? String(cap.userOverride) : '',
    })
    setEditingProvider(provider)
    setSaveStatus('idle')
  }, [userConfigs, providers])

  const handleSave = useCallback(async () => {
    if (!editingProvider) return
    setSaveStatus('saving')
    try {
      await userConfigApi.upsertConfig(editingProvider, {
        provider: editingProvider,
        model: editForm.model.trim(),
        baseUrl: editForm.baseUrl.trim(),
        apiKey: editForm.apiKey.trim().replace(/[\s​‌‍﻿ ]/g, ''),
      })
      // 同步写入本机保险柜（全局作用域）：Key 与"登录哪个后端"解耦，
      // 避免 website-online 配置后切到 mescli-online 时 Key 不可见（2026-07-24 根因修复）
      setProviderKeyEntry(editingProvider, {
        apiKey: editForm.apiKey.trim().replace(/[\s​‌‍﻿ ]/g, ''),
        baseUrl: editForm.baseUrl.trim(),
        model: editForm.model.trim(),
      })
      setSaveStatus('success')
      // 刷新列表
      const cList = await userConfigApi.getConfigs()
      setUserConfigs(cList)

      // 上下文窗口覆盖（打磨任务7）：空=自动（注册表学习/名字猜测）
      const modelName = editForm.model.trim()
      if (modelName) {
        setUserWindowOverride(
          editingProvider,
          modelName,
          parseWindowInput(editForm.contextWindow)
        )
      }

      // 如果当前 activeProvider 就是正在编辑的 provider，自动更新它
      const chatStore = useChatStore.getState()
      const currentActive = chatStore.activeProvider
      if (currentActive && currentActive.provider === editingProvider) {
        const defaultProvider = providers.find((p) => p.provider === editingProvider)
        const updatedConfig = cList.find((c) => c.provider === editingProvider)
        const updatedProvider: ProviderConfig = {
          ...currentActive,
          ...defaultProvider,
          model: updatedConfig?.model || editForm.model.trim() || currentActive.model,
          baseUrl: updatedConfig?.baseUrl || editForm.baseUrl.trim() || currentActive.baseUrl,
        }
        chatStore.setActiveProvider(updatedProvider)
        localStorage.setItem('wonclaw_active_provider', JSON.stringify(updatedProvider))
      }

      setTimeout(() => {
        setEditingProvider(null)
        setSaveStatus('idle')
      }, 1200)
    } catch (err) {
      setSaveStatus('error')
      setError(err instanceof Error ? err.message : t('settings.settingsView.saveFailed'))
    }
  }, [editingProvider, editForm, t, providers])

  const getConfigFor = (provider: string) => {
    return userConfigs.find((c) => c.provider === provider)
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-surface-200">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary-100 flex items-center justify-center">
            <Settings size={20} className="text-primary-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-surface-800">{t('settings.settingsView.title')}</h2>
            <p className="text-sm text-surface-400">{t('settings.settingsView.subtitle')}</p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* Language Switcher */}
          <div className="bg-white border border-surface-200 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <Globe size={16} className="text-surface-500" />
              <h3 className="text-sm font-semibold text-surface-700">{t('settings.settingsView.language')}</h3>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setLanguage('zh-CN')}
                className={cn(
                  'px-4 py-2 rounded-lg text-sm font-medium transition-colors border',
                  language === 'zh-CN'
                    ? 'border-primary-400 bg-primary-50 text-primary-700'
                    : 'border-surface-200 text-surface-600 hover:border-primary-300'
                )}
              >
                {t('settings.settingsView.chinese')}
              </button>
              <button
                onClick={() => setLanguage('en-US')}
                className={cn(
                  'px-4 py-2 rounded-lg text-sm font-medium transition-colors border',
                  language === 'en-US'
                    ? 'border-primary-400 bg-primary-50 text-primary-700'
                    : 'border-surface-200 text-surface-600 hover:border-primary-300'
                )}
              >
                {t('settings.settingsView.english')}
              </button>
            </div>
          </div>

          {/* 权限模式默认值（打磨任务2 S1）：对话栏下拉可会话级覆盖 */}
          <div className="bg-white border border-surface-200 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <ShieldCheck size={16} className="text-surface-500" />
              <h3 className="text-sm font-semibold text-surface-700">
                {t('settings.settingsView.permissionModeDefault', { defaultValue: '权限模式默认值' })}
              </h3>
            </div>
            <div className="flex flex-wrap gap-2">
              {PERMISSION_MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setPermissionMode(opt.value as ExecutionMode)}
                  className={cn(
                    'px-4 py-2 rounded-lg text-sm font-medium transition-colors border',
                    permissionMode === opt.value
                      ? 'border-primary-400 bg-primary-50 text-primary-700'
                      : 'border-surface-200 text-surface-600 hover:border-primary-300'
                  )}
                >
                  {t(opt.labelKey, { defaultValue: opt.fallback })}
                </button>
              ))}
            </div>
            <p className="text-xs text-surface-400 mt-2">
              {t('settings.settingsView.permissionModeHint', {
                defaultValue: '全部自动模式下破坏性操作（删文件/删表）仍会请求确认；对话栏下拉可为单个会话临时覆盖',
              })}
            </p>
          </div>

          {/* 额外注入模块：Online 构建的 TokenHub / Quota / License 等商业化卡片 */}
          {extraSections}

          {isLoading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="animate-spin text-surface-400" />
              <span className="ml-2 text-sm text-surface-500">{t('settings.settingsView.loading')}</span>
            </div>
          )}

          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3">
              <AlertCircle size={18} className="text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-red-700">{error}</p>
                <button
                  onClick={loadData}
                  className="text-xs text-red-600 underline mt-1 hover:text-red-800"
                >
                  {t('settings.settingsView.retry')}
                </button>
              </div>
            </div>
          )}

          {!isLoading && providers.length === 0 && (
            <div className="text-center py-12">
              <Server size={48} className="mx-auto text-surface-300 mb-3" />
              <p className="text-surface-500">{t('settings.settingsView.noProviders')}</p>
            </div>
          )}

          {!isLoading && providers.map((p) => {
            const config = getConfigFor(p.provider)
            const isEditing = editingProvider === p.provider

            return (
              <div
                key={p.provider}
                className="bg-white border border-surface-200 rounded-xl overflow-hidden"
              >
                {/* Provider Header */}
                <div
                  className={cn(
                    'flex items-center gap-3 px-5 py-4 cursor-pointer transition-colors',
                    isEditing ? 'bg-primary-50' : 'hover:bg-surface-50'
                  )}
                  onClick={() => !isEditing && handleEdit(p.provider)}
                >
                  <div className="w-9 h-9 rounded-lg bg-surface-100 flex items-center justify-center">
                    <Bot size={18} className="text-surface-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-surface-800">{getProviderLabel(t, p.provider)}</h3>
                      {p.isEnabled !== false && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">
                          {t('settings.settingsView.enabled')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-surface-400 truncate">
                      {config?.model || p.model} · {formatProviderHost(config?.baseUrl || p.baseUrl)}
                    </p>
                  </div>
                  {isEditing ? (
                    <ChevronDown size={16} className="text-surface-400" />
                  ) : (
                    <ChevronRight size={16} className="text-surface-400" />
                  )}
                </div>

                {/* Edit Form */}
                {isEditing && (
                  <div className="px-5 py-4 border-t border-surface-100 bg-surface-50/50 space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <label className="block text-sm text-surface-600">
                        <div className="flex items-center gap-1 mb-1">
                          <Bot size={14} />
                          {t('settings.settingsView.modelName')}
                        </div>
                        <input
                          type="text"
                          value={editForm.model}
                          onChange={(e) => setEditForm((prev) => ({ ...prev, model: e.target.value }))}
                          placeholder="gpt-4o"
                          className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400"
                        />
                      </label>

                      <label className="block text-sm text-surface-600">
                        <div className="flex items-center gap-1 mb-1">
                          <Globe size={14} />
                          {t('settings.settingsView.baseUrl')}
                        </div>
                        <input
                          type="text"
                          value={editForm.baseUrl}
                          onChange={(e) => setEditForm((prev) => ({ ...prev, baseUrl: e.target.value }))}
                          placeholder="https://api.openai.com/v1"
                          className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400"
                        />
                      </label>
                    </div>

                    <label className="block text-sm text-surface-600">
                      <div className="flex items-center gap-1 mb-1">
                        <Server size={14} />
                        {t('settings.settingsView.contextWindow', { defaultValue: '上下文窗口（可选）' })}
                      </div>
                      <input
                        type="text"
                        value={editForm.contextWindow}
                        onChange={(e) => setEditForm((prev) => ({ ...prev, contextWindow: e.target.value }))}
                        placeholder={(() => {
                          const resolved = editForm.model.trim()
                            ? resolveContextWindow(editingProvider ?? '', editForm.model.trim())
                            : null
                          return resolved
                            ? t('settings.settingsView.contextWindowAuto', {
                                defaultValue: `自动（${resolved.value.toLocaleString()}）`,
                                value: resolved.value.toLocaleString(),
                              })
                            : '128000 / 128k / 1m'
                        })()}
                        className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400"
                      />
                      {(() => {
                        const cap = editForm.model.trim()
                          ? getCapability(editingProvider ?? '', editForm.model.trim())
                          : undefined
                        const hints: string[] = []
                        if (cap?.windowUpperBound) {
                          hints.push(
                            t('settings.settingsView.contextWindowLearnedUpper', {
                              defaultValue: `已学习上限 ${cap.windowUpperBound.toLocaleString()}`,
                              value: cap.windowUpperBound.toLocaleString(),
                            })
                          )
                        } else if (cap?.windowLowerBound) {
                          hints.push(
                            t('settings.settingsView.contextWindowLearnedLower', {
                              defaultValue: `已观测 ≥ ${cap.windowLowerBound.toLocaleString()}`,
                              value: cap.windowLowerBound.toLocaleString(),
                            })
                          )
                        }
                        hints.push(
                          t('settings.settingsView.contextWindowHint', {
                            defaultValue: '留空则自动学习；设置过高会在首次 400 时自动校正',
                          })
                        )
                        return (
                          <p className="text-xs text-surface-400 mt-1">{hints.join(' · ')}</p>
                        )
                      })()}
                    </label>

                    <label className="block text-sm text-surface-600">
                      <div className="flex items-center gap-1 mb-1">
                        <Key size={14} />
                        {t('settings.settingsView.apiKey')}
                      </div>
                      <input
                        type="password"
                        value={editForm.apiKey}
                        onChange={(e) => setEditForm((prev) => ({ ...prev, apiKey: e.target.value }))}
                        placeholder="sk-..."
                        className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400"
                      />
                      <p className="text-xs text-surface-400 mt-1">
                        {t('settings.settingsView.leaveEmpty')}
                      </p>
                    </label>

                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={handleSave}
                        disabled={saveStatus === 'saving'}
                        className={cn(
                          'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                          saveStatus === 'saving'
                            ? 'bg-surface-200 text-surface-400 cursor-not-allowed'
                            : saveStatus === 'success'
                              ? 'bg-green-500 text-white'
                              : 'bg-primary-500 text-white hover:bg-primary-600'
                        )}
                      >
                        {saveStatus === 'saving' && <Loader2 size={14} className="animate-spin" />}
                        {saveStatus === 'success' && <Check size={14} />}
                        {saveStatus === 'saving' ? t('settings.settingsView.saving') : saveStatus === 'success' ? t('settings.settingsView.saved') : t('settings.settingsView.saveConfig')}
                      </button>
                      <button
                        onClick={() => {
                          setEditingProvider(null)
                          setSaveStatus('idle')
                        }}
                        className="px-4 py-2 rounded-lg text-sm text-surface-600 hover:bg-surface-100 transition-colors"
                      >
                        {t('settings.settingsView.cancel')}
                      </button>
                      {saveStatus === 'error' && (
                        <span className="text-sm text-red-600 flex items-center gap-1">
                          <AlertCircle size={14} /> {t('settings.settingsView.saveFailed')}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {/* Web Search Config */}
          <WebSearchSettingsView />

          {/* Local Model Settings */}
          {supportsLocalModel && <LocalModelSettingsView />}
        </div>
      </div>
    </div>
  )
}
