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

const PROVIDER_OPTIONS: { value: ApiKeyProvider; label: string }[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'kimi', label: 'Kimi' },
  { value: 'claude', label: 'Claude (Anthropic)' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'custom', label: '自定义 OpenAI 兼容 API' },
]

const SCOPE_OPTIONS: { value: ApiKeyScope; label: string }[] = [
  { value: 'chat', label: '聊天' },
  { value: 'workflow', label: '工作流' },
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
    provider: 'openai' as ApiKeyProvider,
    baseUrl: '',
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
        monthlyTokenQuota: info.monthlyTokenQuota,
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
    if (!form.name.trim() || !form.key.trim()) return
    const success = await createApiKey({
      name: form.name.trim(),
      provider: form.provider,
      baseUrl: form.baseUrl.trim() || undefined,
      key: form.key.trim(),
      scope: form.scope,
      isDefault: form.isDefault,
    })
    if (success) {
      setForm({
        name: '',
        provider: 'openai',
        baseUrl: '',
        key: '',
        scope: 'all',
        isDefault: false,
      })
      setShowForm(false)
    }
  }

  return (
    <div className="bg-white border border-surface-200 rounded-xl p-5 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Key size={16} className="text-surface-500" />
          <h3 className="text-sm font-semibold text-surface-700">
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
        <div className="p-4 bg-surface-50 border border-surface-200 rounded-lg space-y-3">
          <div className="flex items-center gap-2">
            <Cloud size={16} className="text-primary-500" />
            <span className="text-sm font-medium text-surface-700">
              {t('settings.apiKey.tokenhubStatus')}
            </span>
            <span
              className={cn(
                'text-[10px] px-1.5 py-0.5 rounded-full',
                tokenHubMeta
                  ? 'bg-green-100 text-green-700'
                  : 'bg-surface-100 text-surface-500'
              )}
            >
              {tokenHubMeta ? t('settings.apiKey.tokenhubActive') : t('settings.apiKey.tokenhubEmpty')}
            </span>
          </div>

          {tokenHubMeta && (
            <div className="space-y-1 text-sm text-surface-600">
              <div className="flex items-center gap-2">
                <KeyRound size={14} className="text-surface-400" />
                <code className="font-mono text-xs">{tokenHubMeta.keyHint}</code>
              </div>
              <p className="text-xs text-surface-500">
                {t('settings.apiKey.tokenhubModel', { model: tokenHubMeta.model })}
              </p>
              {tokenHubMeta.activatedAt && (
                <p className="text-xs text-surface-500">
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
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary-600 bg-white border border-primary-200 hover:bg-primary-50 rounded-lg transition-colors disabled:opacity-50"
          >
            {tokenHubLoading && <Loader2 size={13} className="animate-spin" />}
            {t('settings.apiKey.tokenhubReveal')}
          </button>
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
          <AlertCircle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm text-red-700">{error}</p>
            <button
              onClick={clearError}
              className="text-xs text-red-600 underline mt-1 hover:text-red-800"
            >
              {t('settings.apiKey.dismiss')}
            </button>
          </div>
        </div>
      )}

      {showForm && showByok && (
        <div className="p-4 bg-surface-50 border border-surface-200 rounded-lg space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block text-sm text-surface-600">
              {t('settings.apiKey.name')}
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder={t('settings.apiKey.namePlaceholder')}
                className="mt-1 w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400"
              />
            </label>
            <label className="block text-sm text-surface-600">
              {t('settings.apiKey.provider')}
              <select
                value={form.provider}
                onChange={(e) => setForm((p) => ({ ...p, provider: e.target.value as ApiKeyProvider }))}
                className="mt-1 w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400 bg-white"
              >
                {PROVIDER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="block text-sm text-surface-600">
            {t('settings.apiKey.key')}
            <input
              type="password"
              value={form.key}
              onChange={(e) => setForm((p) => ({ ...p, key: e.target.value }))}
              placeholder={t('settings.apiKey.keyPlaceholder')}
              className="mt-1 w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400"
            />
          </label>

          {form.provider === 'custom' && (
            <label className="block text-sm text-surface-600">
              {t('settings.apiKey.baseUrl')}
              <input
                type="text"
                value={form.baseUrl}
                onChange={(e) => setForm((p) => ({ ...p, baseUrl: e.target.value }))}
                placeholder="https://api.example.com/v1"
                className="mt-1 w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400"
              />
            </label>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block text-sm text-surface-600">
              {t('settings.apiKey.scope')}
              <select
                value={form.scope}
                onChange={(e) => setForm((p) => ({ ...p, scope: e.target.value as ApiKeyScope }))}
                className="mt-1 w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400 bg-white"
              >
                {SCOPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 text-sm text-surface-600">
              <input
                type="checkbox"
                checked={form.isDefault}
                onChange={(e) => setForm((p) => ({ ...p, isDefault: e.target.checked }))}
                className="rounded border-surface-300 text-primary-500 focus:ring-primary-400"
              />
              {t('settings.apiKey.setAsDefault')}
            </label>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleCreate}
              disabled={isCreating || !form.name.trim() || !form.key.trim()}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                isCreating || !form.name.trim() || !form.key.trim()
                  ? 'bg-surface-200 text-surface-400 cursor-not-allowed'
                  : 'bg-primary-500 text-white hover:bg-primary-600'
              )}
            >
              {isCreating && <Loader2 size={14} className="animate-spin" />}
              {t('settings.apiKey.create')}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-4 py-2 text-sm text-surface-600 hover:text-surface-800 transition-colors"
            >
              {t('settings.apiKey.cancel')}
            </button>
          </div>
        </div>
      )}

      {showByok && isLoading && apiKeys.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-surface-500">
          <Loader2 size={16} className="animate-spin" />
          {t('settings.apiKey.loading')}
        </div>
      )}

      {showByok && apiKeys.length === 0 && !isLoading && !showForm && (
        <div className="text-center py-6 text-sm text-surface-400">
          {t('settings.apiKey.empty')}
        </div>
      )}

      {!showByok && !isWebsiteOnline() && (
        <div className="text-center py-6 text-sm text-surface-400">
          {t('settings.apiKey.byokDisabled')}
        </div>
      )}

      <div className="space-y-2">
        {showByok && apiKeys.map((k) => (
          <div
            key={k.id}
            className={cn(
              'flex items-center gap-3 p-3 border rounded-lg transition-colors',
              k.isDefault ? 'border-primary-300 bg-primary-50' : 'border-surface-200 bg-white'
            )}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-surface-800 truncate">{k.name}</span>
                {k.isDefault && (
                  <span className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-primary-100 text-primary-700">
                    <Star size={9} />
                    {t('settings.apiKey.default')}
                  </span>
                )}
                {k.isPlatformManaged && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-100 text-surface-500">
                    {t('settings.apiKey.platformManaged')}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-surface-500 mt-0.5">
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
                  className="p-1.5 rounded-lg text-surface-400 hover:bg-surface-100 transition-colors"
                  title={showKeyMap[k.id] ? t('settings.apiKey.hide') : t('settings.apiKey.show')}
                >
                  {showKeyMap[k.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              )}
              {!k.isDefault && !k.isPlatformManaged && (
                <button
                  onClick={() => setDefaultApiKey(k.id)}
                  className="p-1.5 rounded-lg text-surface-400 hover:bg-surface-100 transition-colors"
                  title={t('settings.apiKey.setAsDefault')}
                >
                  <Star size={14} />
                </button>
              )}
              {!k.isPlatformManaged && (
                <button
                  onClick={() => deleteApiKey(k.id)}
                  className="p-1.5 rounded-lg text-surface-400 hover:bg-red-50 hover:text-red-500 transition-colors"
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
