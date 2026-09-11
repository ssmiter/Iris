/**
 * StandaloneModelSection
 * 2026-08-11 从 StandaloneSettingsView.tsx 迁移外部客户路径的模型配置逻辑。
 * 逻辑逐字保留，仅 UI 皮肤改为分组卡片。
 */

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { cn } from '@/utils'
import {
  getStandaloneConfig,
  setStandaloneConfig,
  PROVIDERS,
  type StandaloneConfig,
} from '@/api/standaloneApi'
import { setProviderKeyEntry } from '@/services/providerKeyVault'
import { testProviderConnection } from '@/services/providerConnectionTest'
import { useChatStore } from '@/stores/chatStore'
import {
  getCapability,
  setUserWindowOverride,
  resolveContextWindow,
  parseWindowInput,
} from '@/services/modelCapabilityRegistry'
import { credentialAutofillGuard, plainTextAutofillGuard } from '@/utils/autofillGuard'
import { Server, Key, Hash, Thermometer, MessageSquare, Save, Check, AlertCircle } from 'lucide-react'

// 2026-08-05 用户拍板：API 配置只开放 DeepSeek + 私有化部署（custom）。
// 其余提供商仅前端隐藏——PROVIDERS 表、存量配置、provider 实现全部保留不删；
// 财务系统整体上线后，这两个提供商的配置再迁入管理员权限（届时此处应改为提权门槛而非白名单）。
const VISIBLE_PROVIDERS = new Set(['deepseek', 'custom'])

function getApiKeyPrefix(provider: string): string {
  switch (provider) {
    case 'kimi':
      return 'sk-'
    case 'kimi-code':
      return 'sk-kimi-'
    case 'claude':
      return 'sk-ant-'
    case 'ark-code-latest':
      return 'ark-'
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
  const i18nKey = key.replace(/-([a-z])/g, (_, char) => char.toUpperCase())
  return t(`settings.provider.${i18nKey}`, { defaultValue: PROVIDERS[key]?.name || key })
}

export function StandaloneModelSection(): JSX.Element {
  const { t } = useTranslation()
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
    const trimmedConfig: StandaloneConfig = {
      ...config,
      provider: config.provider,
      apiKey: config.apiKey.trim().replace(/[\s​‌‍﻿ ]/g, ''),
      model: config.model.trim(),
      apiBase: config.apiBase?.trim().replace(/\/$/, ''),
      systemPrompt: config.systemPrompt?.trim(),
    }
    setStandaloneConfig(trimmedConfig)
    // 同步写入本机保险柜（全局作用域）：standalone_config 按 storageScope 分前缀，
    // 换模式会读不到；保险柜保证"一次配置、跨模式可用"（2026-07-24 根因修复）
    setProviderKeyEntry(trimmedConfig.provider, {
      apiKey: trimmedConfig.apiKey,
      baseUrl: trimmedConfig.apiBase,
      model: trimmedConfig.model,
    })

    // 上下文窗口覆盖（打磨任务7）：空=自动（注册表学习/名字猜测）
    if (trimmedConfig.model) {
      setUserWindowOverride(
        trimmedConfig.provider,
        trimmedConfig.model,
        parseWindowInput(contextWindow)
      )
    }

    // 保存后立即同步当前活跃 provider，避免用户回到聊天页时仍使用旧模型
    const providerConfig = {
      provider: trimmedConfig.provider,
      model: trimmedConfig.model,
      baseUrl: trimmedConfig.apiBase || PROVIDERS[trimmedConfig.provider]?.baseUrl || '',
    }
    useChatStore.getState().setActiveProvider(providerConfig)
    localStorage.setItem('wonclaw_active_provider', JSON.stringify(providerConfig))

    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [config, contextWindow])

  const handleTest = useCallback(async () => {
    const trimmedApiKey = config.apiKey.trim().replace(/[\s​‌‍﻿ ]/g, '')
    if (!trimmedApiKey) {
      setTestStatus('error')
      setTestMessage(t('settings.standaloneSettings.fillApiKey'))
      return
    }

    setTestStatus('testing')
    setTestMessage('')

    try {
      const provider = PROVIDERS[config.provider] ?? PROVIDERS.deepseek
      const baseUrl = config.apiBase?.trim().replace(/\/$/, '') || provider.baseUrl
      await testProviderConnection({
        provider: config.provider,
        model: config.model.trim() || provider.defaultModel,
        apiKey: trimmedApiKey,
        baseUrl,
      })
      setTestStatus('success')
      setTestMessage(t('settings.standaloneSettings.connectionSuccess'))
    } catch (err) {
      setTestStatus('error')
      setTestMessage(
        t('settings.standaloneSettings.connectionError', {
          error: err instanceof Error ? err.message : 'Unknown error',
        })
      )
    }
  }, [config, t])

  // 兜底防御：getStandaloneConfig 已校验 provider 有效性，这里再兜一层，
  // 防止旧缓存/竞态下 undefined 直接白屏（2026-07-24）
  const provider = PROVIDERS[config.provider] ?? PROVIDERS.deepseek
  const providerName = getProviderName(t, config.provider)
  const apiKeyLabel =
    config.provider === 'custom'
      ? t('settings.standaloneSettings.apiKey')
      : t('settings.standaloneSettings.apiKeyFor', { provider: providerName })

  return (
    <div className="wf-set-gcard p-5 space-y-5">
      {/* AI 提供商 */}
      <div>
        <div className="wf-set-group-t">{t('settings.standaloneSettings.aiProvider')}</div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mb-4">
          {(Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>)
            .filter((key) => VISIBLE_PROVIDERS.has(key))
            .map((key) => (
              <button
                key={key}
                onClick={() => handleChange('provider', key)}
                className={cn(
                  'p-3 rounded-lg border text-left transition-all',
                  config.provider === key
                    ? 'border-primary-400 bg-primary-50 text-primary-700'
                    : 'border-[var(--wf-line)] hover:border-primary-300'
                )}
              >
                <div className="text-sm font-medium truncate">{getProviderName(t, key)}</div>
                <div className="text-xs text-[var(--wf-faint)] mt-0.5 truncate">
                  {key === 'custom'
                    ? t('settings.standaloneSettings.customEndpoint')
                    : formatProviderHost(PROVIDERS[key].baseUrl) || t('settings.standaloneSettings.defaultEndpoint')}
                </div>
              </button>
            ))}
        </div>

        {config.provider === 'custom' && (
          <label className="block text-sm text-[var(--wf-sub)]">
            {t('settings.standaloneSettings.apiBaseUrl')}
            <input
              type="text"
              {...plainTextAutofillGuard}
              value={config.apiBase || ''}
              onChange={(e) => handleChange('apiBase', e.target.value)}
              placeholder="https://your-api.com/v1"
              className="wf-ink-input mt-1"
            />
          </label>
        )}
      </div>

      {/* API Key */}
      <div>
        <div className="wf-set-group-t">{t('settings.standaloneSettings.apiKey')}</div>
        <div className="space-y-3">
          <label className="block text-sm text-[var(--wf-sub)]">
            {apiKeyLabel}
            <input
              type="password"
              {...credentialAutofillGuard}
              value={config.apiKey}
              onChange={(e) => handleChange('apiKey', e.target.value)}
              placeholder={t('settings.standaloneSettings.apiKeyPlaceholder', {
                prefix: getApiKeyPrefix(config.provider),
              })}
              className="wf-ink-input mt-1"
            />
          </label>

          <div className="flex items-center gap-2">
            <button
              onClick={handleTest}
              disabled={testStatus === 'testing'}
              className={cn(
                'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                testStatus === 'testing'
                  ? 'bg-[var(--wf-mono-bg)] text-[var(--wf-faint)] cursor-not-allowed'
                  : 'bg-primary-500 text-white hover:bg-primary-600'
              )}
            >
              {testStatus === 'testing'
                ? t('settings.standaloneSettings.testing')
                : t('settings.standaloneSettings.testConnection')}
            </button>

            {testStatus === 'success' && (
              <span className="text-sm text-[var(--wf-ok-ink)] flex items-center gap-1">
                <Check size={14} /> {testMessage}
              </span>
            )}
            {testStatus === 'error' && (
              <span className="text-sm text-[var(--wf-err-ink)] flex items-center gap-1">
                <AlertCircle size={14} /> {testMessage}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 模型参数 */}
      <div>
        <div className="wf-set-group-t">{t('settings.standaloneSettings.modelParams')}</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block text-sm text-[var(--wf-sub)]">
            {t('settings.standaloneSettings.modelName')}
            <input
              type="text"
              {...plainTextAutofillGuard}
              value={config.model}
              onChange={(e) => handleChange('model', e.target.value)}
              placeholder={provider.defaultModel}
              className="wf-ink-input mt-1"
            />
          </label>

          <label className="block text-sm text-[var(--wf-sub)]">
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

          <label className="block text-sm text-[var(--wf-sub)]">
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
              className="wf-ink-input mt-1"
            />
          </label>

          <label className="block text-sm text-[var(--wf-sub)]">
            <div className="flex items-center gap-1">
              <Server size={14} />
              {t('settings.settingsView.contextWindow', { defaultValue: '上下文窗口（可选）' })}
            </div>
            <input
              type="text"
              {...plainTextAutofillGuard}
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
              className="wf-ink-input mt-1"
            />
            <p className="text-xs text-[var(--wf-faint)] mt-1">
              {t('settings.settingsView.contextWindowHint', {
                defaultValue: '留空则自动学习；设置过高会在首次 400 时自动校正',
              })}
            </p>
          </label>
        </div>
      </div>

      {/* 系统提示词 */}
      <div>
        <div className="wf-set-group-t">{t('settings.standaloneSettings.systemPrompt')}</div>
        <textarea
          value={config.systemPrompt || ''}
          onChange={(e) => handleChange('systemPrompt', e.target.value)}
          rows={4}
          placeholder={t('settings.standaloneSettings.systemPromptPlaceholder')}
          className="wf-ink-input resize-none"
        />
      </div>

      {/* 保存按钮 */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          className={cn(
            'px-6 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-2',
            saved
              ? 'bg-[var(--wf-ok-bg)] text-[var(--wf-ok-ink)]'
              : 'bg-primary-500 text-white hover:bg-primary-600'
          )}
        >
          {saved ? <Check size={16} /> : <Save size={16} />}
          {saved
            ? t('settings.standaloneSettings.saved')
            : t('settings.standaloneSettings.saveSettings')}
        </button>
      </div>
    </div>
  )
}
