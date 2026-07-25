import { useState, useCallback, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { getStandaloneConfig, setStandaloneConfig, PROVIDERS } from '@/api/standaloneApi'
import { setProviderKeyEntry } from '@/services/providerKeyVault'
import type { StandaloneConfig } from '@/api/standaloneApi'
import type { ProviderConfig } from '@/types/mescli'
import { useSettingsStore } from '@/stores/settingsStore'
import { PERMISSION_MODE_OPTIONS } from '@/components/Chat/InputArea'
import type { ExecutionMode } from '@/agent/types'
import { useChatStore } from '@/stores/chatStore'
import {
  getCapability,
  setUserWindowOverride,
  resolveContextWindow,
  parseWindowInput,
} from '@/services/modelCapabilityRegistry'
import { cn } from '@/utils'
import { WebSearchSettingsView } from './WebSearchSettingsView'
import {
  Settings,
  Key,
  Server,
  Thermometer,
  Hash,
  MessageSquare,
  Save,
  Check,
  AlertCircle,
  Globe,
  ShieldCheck,
} from 'lucide-react'

interface StandaloneSettingsViewProps {
  headerTitle?: string
  headerSubtitle?: string
  topSections?: ReactNode
  bottomSections?: ReactNode
}

function getApiKeyPrefix(provider: string): string {
  switch (provider) {
    case 'kimi':
      return 'sk-'
    case 'kimi-code':
      return 'sk-kimi-'
    case 'claude':
      return 'sk-ant-'
    case 'deepseek':
    case 'qwen':
    case 'baichuan':
    case 'hunyuan':
    case 'openai':
    case 'custom':
      return 'sk-'
    default:
      return ''
  }
}

function formatProviderHost(baseUrl: string): string {
  if (!baseUrl) return ''
  try {
    const url = new URL(baseUrl)
    return url.host
  } catch {
    return baseUrl
  }
}

function getProviderName(t: TFunction, key: string): string {
  return t(`settings.provider.${key.replace(/-/g, '_')}`, { defaultValue: PROVIDERS[key]?.name || key })
}

export function StandaloneSettingsView({
  headerTitle,
  headerSubtitle,
  topSections,
  bottomSections,
}: StandaloneSettingsViewProps) {
  const { t } = useTranslation()
  const { language, setLanguage, permissionMode, setPermissionMode } = useSettingsStore()
  const [config, setConfig] = useState<StandaloneConfig>(getStandaloneConfig())
  // 上下文窗口覆盖存模型能力注册表（打磨任务7），不属于 StandaloneConfig
  const [contextWindow, setContextWindow] = useState<string>(() => {
    const cfg = getStandaloneConfig()
    const cap = cfg.model ? getCapability(cfg.provider, cfg.model) : undefined
    return cap?.userOverride ? String(cap.userOverride) : ''
  })
  const [saved, setSaved] = useState(false)
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [testMessage, setTestMessage] = useState('')

  const handleChange = useCallback(
    (field: keyof StandaloneConfig, value: string | number) => {
      setConfig((prev) => ({ ...prev, [field]: value }))
      setSaved(false)
    },
    []
  )

  const handleSave = useCallback(() => {
    setStandaloneConfig(config)
    // 同步写入本机保险柜（全局作用域）：standalone_config 按 storageScope 分前缀，
    // 换模式会读不到；保险柜保证"一次配置、跨模式可用"（2026-07-24 根因修复）
    setProviderKeyEntry(config.provider, {
      apiKey: config.apiKey,
      baseUrl: config.apiBase,
      model: config.model,
    })

    // 上下文窗口覆盖（打磨任务7）：空=自动（注册表学习/名字猜测）
    if (config.model.trim()) {
      setUserWindowOverride(
        config.provider,
        config.model.trim(),
        parseWindowInput(contextWindow)
      )
    }

    // 保存后立即同步当前活跃 provider，避免用户回到聊天页时仍使用旧模型
    const providerConfig: ProviderConfig = {
      provider: config.provider,
      model: config.model,
      baseUrl: config.apiBase || PROVIDERS[config.provider]?.baseUrl || '',
    }
    useChatStore.getState().setActiveProvider(providerConfig)
    localStorage.setItem('wonclaw_active_provider', JSON.stringify(providerConfig))

    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [config, contextWindow])

  const handleTest = useCallback(async () => {
    if (!config.apiKey) {
      setTestStatus('error')
      setTestMessage(t('settings.standaloneSettings.fillApiKey'))
      return
    }

    setTestStatus('testing')
    setTestMessage('')

    try {
      const provider = PROVIDERS[config.provider]
      const baseUrl = config.apiBase || provider.baseUrl
      const response = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: provider.headers(config.apiKey),
      })

      if (response.ok) {
        setTestStatus('success')
        setTestMessage(t('settings.standaloneSettings.connectionSuccess'))
      } else {
        const text = await response.text()
        setTestStatus('error')
        setTestMessage(t('settings.standaloneSettings.connectionFailed', { status: response.status, text }))
      }
    } catch (err) {
      setTestStatus('error')
      setTestMessage(t('settings.standaloneSettings.connectionError', { error: err instanceof Error ? err.message : 'Unknown error' }))
    }
  }, [config, t])

  // 兜底防御：getStandaloneConfig 已校验 provider 有效性，这里再兜一层，
  // 防止旧缓存/竞态下 undefined 直接白屏（2026-07-24）
  const provider = PROVIDERS[config.provider] ?? PROVIDERS.kimi
  const providerName = getProviderName(t, config.provider)
  const apiKeyLabel =
    config.provider === 'custom'
      ? t('settings.standaloneSettings.apiKey')
      : t('settings.standaloneSettings.apiKeyFor', { provider: providerName })

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-surface-200">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center">
            <Settings size={20} className="text-amber-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-surface-800">{headerTitle || t('settings.standaloneSettings.title')}</h2>
            <p className="text-sm text-surface-400">
              {headerSubtitle || (
                <>
                  {t('settings.standaloneSettings.currentMode')}
                  <span className="font-medium text-amber-600">{t('settings.standaloneSettings.standaloneMode')}</span>
                </>
              )}
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl mx-auto space-y-6">
          {/* 语言切换 */}
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

          {/* 模式说明 */}
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl">
            <div className="flex items-start gap-3">
              <Globe size={18} className="text-blue-500 flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-medium text-blue-800">{t('settings.standaloneSettings.modeDescription')}</h3>
                <p className="text-sm text-blue-600 mt-1">
                  {t('settings.standaloneSettings.modeExplanation')}
                </p>
              </div>
            </div>
          </div>

          {/* 顶部商业化模块 */}
          {topSections}

          {/* AI 提供商 */}
          <div className="bg-white border border-surface-200 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-4">
              <Server size={16} className="text-surface-500" />
              <h3 className="text-sm font-semibold text-surface-700">{t('settings.standaloneSettings.aiProvider')}</h3>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mb-4">
              {(Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>).map((key) => (
                <button
                  key={key}
                  onClick={() => handleChange('provider', key)}
                  className={cn(
                    'p-3 rounded-lg border text-left transition-all',
                    config.provider === key
                      ? 'border-primary-400 bg-primary-50 text-primary-700'
                      : 'border-surface-200 hover:border-primary-300'
                  )}
                >
                  <div className="text-sm font-medium truncate">{getProviderName(t, key)}</div>
                  <div className="text-xs text-surface-400 mt-0.5 truncate">
                    {key === 'custom'
                      ? t('settings.standaloneSettings.customEndpoint')
                      : formatProviderHost(PROVIDERS[key].baseUrl) || t('settings.standaloneSettings.defaultEndpoint')}
                  </div>
                </button>
              ))}
            </div>

            {config.provider === 'custom' && (
              <div className="space-y-3">
                <label className="block text-sm text-surface-600">
                  {t('settings.standaloneSettings.apiBaseUrl')}
                  <input
                    type="text"
                    value={config.apiBase || ''}
                    onChange={(e) => handleChange('apiBase', e.target.value)}
                    placeholder="https://your-api.com/v1"
                    className="mt-1 w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400"
                  />
                </label>
              </div>
            )}
          </div>

          {/* API Key */}
          <div className="bg-white border border-surface-200 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-4">
              <Key size={16} className="text-surface-500" />
              <h3 className="text-sm font-semibold text-surface-700">{t('settings.standaloneSettings.apiKey')}</h3>
            </div>

            <div className="space-y-3">
              <label className="block text-sm text-surface-600">
                {apiKeyLabel}
                <input
                  type="password"
                  value={config.apiKey}
                  onChange={(e) => handleChange('apiKey', e.target.value)}
                  placeholder={t('settings.standaloneSettings.apiKeyPlaceholder', { prefix: getApiKeyPrefix(config.provider) })}
                  className="mt-1 w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400"
                />
              </label>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleTest}
                  disabled={testStatus === 'testing'}
                  className={cn(
                    'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                    testStatus === 'testing'
                      ? 'bg-surface-200 text-surface-400 cursor-not-allowed'
                      : 'bg-primary-500 text-white hover:bg-primary-600'
                  )}
                >
                  {testStatus === 'testing' ? t('settings.standaloneSettings.testing') : t('settings.standaloneSettings.testConnection')}
                </button>

                {testStatus === 'success' && (
                  <span className="text-sm text-green-600 flex items-center gap-1">
                    <Check size={14} /> {testMessage}
                  </span>
                )}
                {testStatus === 'error' && (
                  <span className="text-sm text-red-600 flex items-center gap-1">
                    <AlertCircle size={14} /> {testMessage}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* 模型参数 */}
          <div className="bg-white border border-surface-200 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-4">
              <Hash size={16} className="text-surface-500" />
              <h3 className="text-sm font-semibold text-surface-700">{t('settings.standaloneSettings.modelParams')}</h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="block text-sm text-surface-600">
                {t('settings.standaloneSettings.modelName')}
                <input
                  type="text"
                  value={config.model}
                  onChange={(e) => handleChange('model', e.target.value)}
                  placeholder={provider.defaultModel}
                  className="mt-1 w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400"
                />
              </label>

              <label className="block text-sm text-surface-600">
                <div className="flex items-center gap-1">
                  <Thermometer size={14} />
                  {t('settings.standaloneSettings.temperature', { value: config.temperature })}
                </div>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={config.temperature}
                  onChange={(e) => handleChange('temperature', parseFloat(e.target.value))}
                  className="mt-2 w-full"
                />
              </label>

              <label className="block text-sm text-surface-600">
                <div className="flex items-center gap-1">
                  <Hash size={14} />
                  {t('settings.standaloneSettings.maxTokens')}
                </div>
                <input
                  type="number"
                  min={256}
                  max={8192}
                  step={256}
                  value={config.maxTokens}
                  onChange={(e) => handleChange('maxTokens', parseInt(e.target.value))}
                  className="mt-1 w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400"
                />
              </label>

              <label className="block text-sm text-surface-600">
                <div className="flex items-center gap-1">
                  <Server size={14} />
                  {t('settings.settingsView.contextWindow', { defaultValue: '上下文窗口（可选）' })}
                </div>
                <input
                  type="text"
                  value={contextWindow}
                  onChange={(e) => {
                    setContextWindow(e.target.value)
                    setSaved(false)
                  }}
                  placeholder={(() => {
                    const resolved = config.model.trim()
                      ? resolveContextWindow(config.provider, config.model.trim())
                      : null
                    return resolved
                      ? t('settings.settingsView.contextWindowAuto', {
                          defaultValue: `自动（${resolved.value.toLocaleString()}）`,
                          value: resolved.value.toLocaleString(),
                        })
                      : '128000 / 128k / 1m'
                  })()}
                  className="mt-1 w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400"
                />
                <p className="text-xs text-surface-400 mt-1">
                  {t('settings.settingsView.contextWindowHint', {
                    defaultValue: '留空则自动学习；设置过高会在首次 400 时自动校正',
                  })}
                </p>
              </label>
            </div>
          </div>

          {/* 系统提示词 */}
          <div className="bg-white border border-surface-200 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-4">
              <MessageSquare size={16} className="text-surface-500" />
              <h3 className="text-sm font-semibold text-surface-700">{t('settings.standaloneSettings.systemPrompt')}</h3>
            </div>

            <textarea
              value={config.systemPrompt || ''}
              onChange={(e) => handleChange('systemPrompt', e.target.value)}
              rows={4}
              placeholder={t('settings.standaloneSettings.systemPromptPlaceholder')}
              className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400 resize-none"
            />
          </div>

          {/* 联网搜索配置 */}
          <WebSearchSettingsView />

          {/* 底部附加模块 */}
          {bottomSections}

          {/* 保存按钮 */}
          <div className="flex justify-end">
            <button
              onClick={handleSave}
              className={cn(
                'px-6 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-2',
                saved
                  ? 'bg-green-500 text-white'
                  : 'bg-primary-500 text-white hover:bg-primary-600'
              )}
            >
              {saved ? <Check size={16} /> : <Save size={16} />}
              {saved ? t('settings.standaloneSettings.saved') : t('settings.standaloneSettings.saveSettings')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
