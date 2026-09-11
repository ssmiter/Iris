import { useEffect, useState } from 'react'
import { cn } from '@/utils'
import { useApiKeyStore } from '@/stores/apiKeyStore'
import { useTokenHubStore } from '@/stores/tokenHubStore'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { websiteCloudApi } from '@/api/websiteCloudApi'
import { supportsByok } from '@/config/product'
import { useRuntimeConfigStore } from '@/stores/runtimeConfigStore'
import { isWebsiteOnline } from '@/utils/runtimeMode'
import { credentialAutofillGuard, plainTextAutofillGuard } from '@/utils/autofillGuard'
import type { TokenHubKeyMeta } from '@/types/tokenhub'
import {
  Key,
  Plus,
  Trash2,
  Check,
  AlertCircle,
  Loader2,
  Star,
  Eye,
  EyeOff,
  Cloud,
  KeyRound,
} from 'lucide-react'
import type { ApiKeyProvider, ApiKeyScope } from '@/types/mescli'

// 2026-08-05 用户拍板：只开放 DeepSeek + 私有化部署（custom=OpenAI 兼容端点）。
// 其余选项仅前端隐藏、代码不删；存量已保存的其他 provider Key 仍正常显示与可用。
// 2026-08-25：BYOK 补 Anthropic 兼容格式（复用已实现的 anthropic 协议链：
// 前端 anthropicModelClient / 后端 AnthropicProvider，baseUrl/key/model 全由请求侧提供）。
const PROVIDER_OPTIONS: { value: ApiKeyProvider; label: string }[] = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'custom', label: '私有化部署 (OpenAI 兼容)' },
  { value: 'anthropic', label: 'Anthropic 兼容 (Claude)' },
]

// 需要自建端点信息的 provider：baseUrl + 模型名都要随 Key 记录（无内置默认值）。
// custom 的 baseUrl 必填（端点即全部语义）；anthropic 可留空走官方 api.anthropic.com。
const ENDPOINT_PROVIDERS = new Set<ApiKeyProvider>(['custom', 'anthropic'])

const SCOPE_OPTIONS: { value: ApiKeyScope; label: string }[] = [
  { value: 'chat', label: '聊天' },
  { value: 'swarm', label: 'Agent Swarm' },
  { value: 'all', label: '全部' },
]

export function ApiKeySettingsView() {
  const { t } = useTranslation()
  const {
    apiKeys,
    isLoading,
    isCreating,
    error,
    loadApiKeys,
    createApiKey,
    deleteApiKey,
    setDefaultApiKey,
    clearError,
  } = useApiKeyStore()

  const [showForm, setShowForm] = useState(false)
  const { config: runtimeConfig } = useRuntimeConfigStore()
  const [tokenHubMeta, setTokenHubMeta] = useState<TokenHubKeyMeta | null>(null)
  const [tokenHubLoading, setTokenHubLoading] = useState(false)
  const showByok = supportsByok || runtimeConfig.byokEnabled === true
  const [showKeyMap, setShowKeyMap] = useState<Record<string, boolean>>({})
  const [form, setForm] = useState({
    name: '',
    provider: 'deepseek' as ApiKeyProvider,
    baseUrl: '',
    model: '',
    key: '',
    scope: 'all' as ApiKeyScope,
    isDefault: false,
  })

  useEffect(() => {
    loadApiKeys()
    if (isWebsiteOnline()) {
      useTokenHubStore.getState().loadCachedKey().then(setTokenHubMeta)
    }
  }, [loadApiKeys])

  const toggleShowKey = (id: string) => {
    setShowKeyMap((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const handleRevealTokenHub = async () => {
    setTokenHubLoading(true)
    try {
      const [planRes, revealRes] = await Promise.all([
        websiteCloudApi.getCurrentPlan(),
        websiteCloudApi.revealTokenHubKey(),
      ])
      const info = planRes.plan?.tokenHub
      if (!info || !revealRes.key) {
        throw new Error(t('settings.apiKey.tokenhubRevealFailed'))
      }
      const meta: TokenHubKeyMeta = {
        apiKeyId: revealRes.apiKeyId,
        keyHint: `sk-tp-•••${revealRes.key.slice(-4)}`,
        model: info.model,
        endpointId: info.endpointId,
        baseUrl: info.baseUrl,
        monthlyTokenQuota: info.monthlyTokenQuota ?? -1,
        status: 'active',
        activatedAt: new Date().toISOString(),
      }
      await useTokenHubStore.getState().saveKey({ ...meta, key: revealRes.key })
      setTokenHubMeta(meta)
      toast.success(t('settings.apiKey.tokenhubRevealed'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.apiKey.tokenhubRevealFailed'))
    } finally {
      setTokenHubLoading(false)
    }
  }

  const handleCreate = async () => {
    // 自建端点 provider（custom/anthropic）无内置默认模型，模型是发起对话的必填项；
    // custom 的 baseUrl 同必填（端点即全部语义）
    if (!form.name.trim() || !form.key.trim()) return
    if (ENDPOINT_PROVIDERS.has(form.provider) && !form.model.trim()) return
    if (form.provider === 'custom' && !form.baseUrl.trim()) return
    const success = await createApiKey({
      name: form.name.trim(),
      provider: form.provider,
      baseUrl: form.baseUrl.trim() || undefined,
      model: ENDPOINT_PROVIDERS.has(form.provider) ? form.model.trim() : undefined,
      key: form.key.trim(),
      scope: form.scope,
      isDefault: form.isDefault,
    })
    if (success) {
      setForm({
        name: '',
        provider: 'deepseek',
        baseUrl: '',
        model: '',
        key: '',
        scope: 'all',
        isDefault: false,
      })
      setShowForm(false)
    }
  }

  return (
    <div className="bg-[var(--wf-card-bg)] border border-[var(--wf-line)] rounded-xl p-5 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Key size={16} className="text-[var(--wf-mut)]" />
          <h3 className="text-sm font-semibold text-[var(--wf-sub)]">
            {isWebsiteOnline() ? t('settings.apiKey.tokenhubTitle') : t('settings.apiKey.title')}
          </h3>
        </div>
        {showByok && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-primary-600 bg-primary-50 hover:bg-primary-100 rounded-lg transition-colors"
          >
            <Plus size={13} />
            {t('settings.apiKey.addByok')}
          </button>
        )}
      </div>

      {isWebsiteOnline() && (
        <div className="p-4 bg-[var(--wf-bg)] border border-[var(--wf-line)] rounded-lg space-y-3">
          <div className="flex items-center gap-2">
            <Cloud size={16} className="text-primary-500" />
            <span className="text-sm font-medium text-[var(--wf-sub)]">
              {t('settings.apiKey.tokenhubStatus')}
            </span>
            <span
              className={cn(
                'text-[10px] px-1.5 py-0.5 rounded-full',
                tokenHubMeta
                  ? 'bg-[var(--wf-ok-bg)] text-[var(--wf-ok-ink)]'
                  : 'bg-[var(--wf-mono-bg)] text-[var(--wf-mut)]'
              )}
            >
              {tokenHubMeta ? t('settings.apiKey.tokenhubActive') : t('settings.apiKey.tokenhubEmpty')}
            </span>
          </div>

          {tokenHubMeta && (
            <div className="space-y-1 text-sm text-[var(--wf-sub)]">
              <div className="flex items-center gap-2">
                <KeyRound size={14} className="text-[var(--wf-faint)]" />
                <code className="font-mono text-xs">{tokenHubMeta.keyHint}</code>
              </div>
              <p className="text-xs text-[var(--wf-mut)]">
                {t('settings.apiKey.tokenhubModel', { model: tokenHubMeta.model })}
              </p>
              {tokenHubMeta.activatedAt && (
                <p className="text-xs text-[var(--wf-mut)]">
                  {t('settings.apiKey.tokenhubActivatedAt', {
                    date: new Date(tokenHubMeta.activatedAt).toLocaleString(),
                  })}
                </p>
              )}
            </div>
          )}

          <button
            onClick={handleRevealTokenHub}
            disabled={tokenHubLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary-600 bg-[var(--wf-card-bg)] border border-primary-200 hover:bg-primary-50 rounded-lg transition-colors disabled:opacity-50"
          >
            {tokenHubLoading && <Loader2 size={13} className="animate-spin" />}
            {t('settings.apiKey.tokenhubReveal')}
          </button>
        </div>
      )}

      {error && (
        <div className="p-3 bg-[var(--wf-err-bg)] border border-[var(--wf-err-line)] rounded-lg flex items-start gap-2">
          <AlertCircle size={16} className="text-[var(--wf-err-ink)] flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm text-[var(--wf-err-ink)]">{error}</p>
            <button
              onClick={clearError}
              className="text-xs text-[var(--wf-err-ink)] underline mt-1 hover:text-[var(--wf-err-ink)]"
            >
              {t('settings.apiKey.dismiss')}
            </button>
          </div>
        </div>
      )}

      {showForm && showByok && (
        <div className="p-4 bg-[var(--wf-bg)] border border-[var(--wf-line)] rounded-lg space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block text-sm text-[var(--wf-sub)]">
              {t('settings.apiKey.name')}
              <input
                type="text"
                {...plainTextAutofillGuard}
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder={t('settings.apiKey.namePlaceholder')}
                className="mt-1 w-full px-3 py-2 border border-[var(--wf-line)] rounded-lg text-sm focus:outline-none focus:border-primary-400"
              />
            </label>
            <label className="block text-sm text-[var(--wf-sub)]">
              {t('settings.apiKey.provider')}
              <select
                value={form.provider}
                onChange={(e) => setForm((p) => ({ ...p, provider: e.target.value as ApiKeyProvider }))}
                className="mt-1 w-full px-3 py-2 border border-[var(--wf-line)] rounded-lg text-sm focus:outline-none focus:border-primary-400 bg-[var(--wf-card-bg)]"
              >
                {PROVIDER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{t(`settings.apiKeys.providers.${opt.value}`, { defaultValue: opt.label })}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="block text-sm text-[var(--wf-sub)]">
            {t('settings.apiKey.key')}
            <input
              type="password"
              {...credentialAutofillGuard}
              value={form.key}
              onChange={(e) => setForm((p) => ({ ...p, key: e.target.value }))}
              placeholder={t('settings.apiKey.keyPlaceholder')}
              className="mt-1 w-full px-3 py-2 border border-[var(--wf-line)] rounded-lg text-sm focus:outline-none focus:border-primary-400"
            />
          </label>

          {ENDPOINT_PROVIDERS.has(form.provider) && (
            <>
              <label className="block text-sm text-[var(--wf-sub)]">
                {form.provider === 'anthropic'
                  ? t('settings.apiKey.baseUrl')
                  : t('settings.apiKey.baseUrlRequired')}
                <input
                  type="text"
                  {...plainTextAutofillGuard}
                  value={form.baseUrl}
                  onChange={(e) => setForm((p) => ({ ...p, baseUrl: e.target.value }))}
                  placeholder={
                    form.provider === 'anthropic'
                      ? 'https://api.anthropic.com'
                      : 'https://api.example.com/v1'
                  }
                  className="mt-1 w-full px-3 py-2 border border-[var(--wf-line)] rounded-lg text-sm focus:outline-none focus:border-primary-400"
                />
              </label>
              <label className="block text-sm text-[var(--wf-sub)]">
                {t('settings.settingsView.modelName')}
                <input
                  type="text"
                  {...plainTextAutofillGuard}
                  value={form.model}
                  onChange={(e) => setForm((p) => ({ ...p, model: e.target.value }))}
                  placeholder={
                    form.provider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o / qwen-max / ...'
                  }
                  className="mt-1 w-full px-3 py-2 border border-[var(--wf-line)] rounded-lg text-sm focus:outline-none focus:border-primary-400"
                />
              </label>
            </>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block text-sm text-[var(--wf-sub)]">
              {t('settings.apiKey.scope')}
              <select
                value={form.scope}
                onChange={(e) => setForm((p) => ({ ...p, scope: e.target.value as ApiKeyScope }))}
                className="mt-1 w-full px-3 py-2 border border-[var(--wf-line)] rounded-lg text-sm focus:outline-none focus:border-primary-400 bg-[var(--wf-card-bg)]"
              >
                {SCOPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{t(`settings.apiKeys.scopes.${opt.value}`, { defaultValue: opt.label })}</option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 text-sm text-[var(--wf-sub)]">
              <input
                type="checkbox"
                checked={form.isDefault}
                onChange={(e) => setForm((p) => ({ ...p, isDefault: e.target.checked }))}
                className="rounded border-[var(--wf-line)] text-primary-500 focus:ring-primary-400"
              />
              {t('settings.apiKey.setAsDefault')}
            </label>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleCreate}
              disabled={
                isCreating ||
                !form.name.trim() ||
                !form.key.trim() ||
                (ENDPOINT_PROVIDERS.has(form.provider) && !form.model.trim()) ||
                (form.provider === 'custom' && !form.baseUrl.trim())
              }
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                isCreating ||
                  !form.name.trim() ||
                  !form.key.trim() ||
                  (ENDPOINT_PROVIDERS.has(form.provider) && !form.model.trim()) ||
                  (form.provider === 'custom' && !form.baseUrl.trim())
                  ? 'bg-[var(--wf-mono-bg)] text-[var(--wf-faint)] cursor-not-allowed'
                  : 'bg-primary-500 text-white hover:bg-primary-600'
              )}
            >
              {isCreating && <Loader2 size={14} className="animate-spin" />}
              {t('settings.apiKey.create')}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-4 py-2 text-sm text-[var(--wf-sub)] hover:text-[var(--wf-ink)] transition-colors"
            >
              {t('settings.apiKey.cancel')}
            </button>
          </div>
        </div>
      )}

      {showByok && isLoading && apiKeys.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-[var(--wf-mut)]">
          <Loader2 size={16} className="animate-spin" />
          {t('settings.apiKey.loading')}
        </div>
      )}

      {showByok && apiKeys.length === 0 && !isLoading && !showForm && (
        <div className="text-center py-6 text-sm text-[var(--wf-faint)]">
          {t('settings.apiKey.empty')}
        </div>
      )}

      {!showByok && !isWebsiteOnline() && (
        <div className="text-center py-6 text-sm text-[var(--wf-faint)]">
          {t('settings.apiKey.byokDisabled')}
        </div>
      )}

      <div className="space-y-2">
        {showByok && apiKeys.map((k) => (
          <div
            key={k.id}
            className={cn(
              'flex items-center gap-3 p-3 border rounded-lg transition-colors',
              k.isDefault ? 'border-primary-300 bg-primary-50' : 'border-[var(--wf-line)] bg-[var(--wf-card-bg)]'
            )}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-[var(--wf-ink)] truncate">{k.name}</span>
                {k.isDefault && (
                  <span className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-primary-100 text-primary-700">
                    <Star size={9} />
                    {t('settings.apiKey.default')}
                  </span>
                )}
                {k.isPlatformManaged && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--wf-mono-bg)] text-[var(--wf-mut)]">
                    {t('settings.apiKey.platformManaged')}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-[var(--wf-mut)] mt-0.5">
                <span className="capitalize">{k.provider}</span>
                <span>·</span>
                <span className="uppercase">{k.scope}</span>
                {k.keyHint && (
                  <>
                    <span>·</span>
                    <code className="font-mono">
                      {showKeyMap[k.id] ? k.key : k.keyHint}
                    </code>
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-1">
              {k.key && (
                <button
                  onClick={() => toggleShowKey(k.id)}
                  className="p-1.5 rounded-lg text-[var(--wf-faint)] hover:bg-[var(--wf-hover)] transition-colors"
                  title={showKeyMap[k.id] ? t('settings.apiKey.hide') : t('settings.apiKey.show')}
                >
                  {showKeyMap[k.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              )}
              {!k.isDefault && !k.isPlatformManaged && (
                <button
                  onClick={() => setDefaultApiKey(k.id)}
                  className="p-1.5 rounded-lg text-[var(--wf-faint)] hover:bg-[var(--wf-hover)] transition-colors"
                  title={t('settings.apiKey.setAsDefault')}
                >
                  <Star size={14} />
                </button>
              )}
              {!k.isPlatformManaged && (
                <button
                  onClick={() => deleteApiKey(k.id)}
                  className="p-1.5 rounded-lg text-[var(--wf-faint)] hover:bg-[var(--wf-err-bg)] hover:text-[var(--wf-err-ink)] transition-colors"
                  title={t('settings.apiKey.delete')}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
