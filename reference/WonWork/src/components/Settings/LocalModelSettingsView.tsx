import { useEffect } from 'react'
import { cn } from '@/utils'
import { useLocalModelStore } from '@/stores/localModelStore'
import { useTranslation } from 'react-i18next'
import {
  Cpu,
  AlertCircle,
  Loader2,
  RefreshCw,
  Check,
  Server,
  Link,
  Key,
  Bot,
} from 'lucide-react'

const PROVIDER_LABELS: Record<string, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  webllm: 'WebLLM',
}

export function LocalModelSettingsView() {
  const { t } = useTranslation()
  const {
    config,
    models,
    isAvailable,
    isDetecting,
    error,
    setProvider,
    setBaseUrl,
    setModel,
    setApiKey,
    detect,
    clearError,
  } = useLocalModelStore()

  useEffect(() => {
    detect()
  }, [detect])

  return (
    <div className="bg-white border border-surface-200 rounded-xl p-5 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu size={16} className="text-surface-500" />
          <h3 className="text-sm font-semibold text-surface-700">{t('settings.localModel.title')}</h3>
        </div>
        <div className="flex items-center gap-2">
          {isAvailable && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 flex items-center gap-1">
              <Check size={12} />
              {t('settings.localModel.available')}
            </span>
          )}
          <button
            onClick={detect}
            disabled={isDetecting}
            className="p-1.5 rounded-lg text-surface-400 hover:bg-surface-100 transition-colors disabled:opacity-50"
            title={t('settings.localModel.detect')}
          >
            <RefreshCw size={14} className={cn(isDetecting && 'animate-spin')} />
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
          <AlertCircle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm text-red-700">{error}</p>
            <button
              onClick={clearError}
              className="text-xs text-red-600 underline mt-1 hover:text-red-800"
            >
              {t('settings.localModel.dismiss')}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {/* 提供商选择 */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Server size={14} className="text-surface-400" />
            <span className="text-xs font-medium text-surface-500">{t('settings.localModel.provider')}</span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {(['ollama', 'lmstudio', 'webllm'] as const).map((provider) => (
              <button
                key={provider}
                onClick={() => setProvider(provider)}
                className={cn(
                  'p-2 rounded-lg border text-sm font-medium transition-colors',
                  config.provider === provider
                    ? 'border-primary-400 bg-primary-50 text-primary-700'
                    : 'border-surface-200 text-surface-600 hover:border-primary-300'
                )}
              >
                {PROVIDER_LABELS[provider]}
              </button>
            ))}
          </div>
        </div>

        {/* Base URL */}
        <label className="block text-sm text-surface-600">
          <div className="flex items-center gap-1 mb-1">
            <Link size={14} />
            {t('settings.localModel.baseUrl')}
          </div>
          <input
            type="text"
            value={config.baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://localhost:11434"
            className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400"
          />
        </label>

        {/* API Key（LM Studio 可选） */}
        {config.provider === 'lmstudio' && (
          <label className="block text-sm text-surface-600">
            <div className="flex items-center gap-1 mb-1">
              <Key size={14} />
              {t('settings.localModel.apiKey')}
            </div>
            <input
              type="password"
              value={config.apiKey || ''}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t('settings.localModel.apiKeyPlaceholder')}
              className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400"
            />
          </label>
        )}

        {/* 模型选择 */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Bot size={14} className="text-surface-400" />
            <span className="text-xs font-medium text-surface-500">{t('settings.localModel.model')}</span>
          </div>
          {isDetecting && models.length === 0 && (
            <div className="flex items-center gap-2 text-sm text-surface-500">
              <Loader2 size={14} className="animate-spin" />
              {t('settings.localModel.detecting')}
            </div>
          )}
          {models.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {models.map((model) => (
                <button
                  key={model.id}
                  onClick={() => setModel(model.id)}
                  className={cn(
                    'text-left p-2.5 rounded-lg border text-sm transition-colors',
                    config.model === model.id
                      ? 'border-primary-400 bg-primary-50 text-primary-700'
                      : 'border-surface-200 text-surface-600 hover:border-primary-300'
                  )}
                >
                  <span className="font-medium">{model.name}</span>
                  {model.size && (
                    <span className="text-xs text-surface-400 ml-2">
                      {(model.size / 1024 / 1024 / 1024).toFixed(1)} GB
                    </span>
                  )}
                </button>
              ))}
            </div>
          ) : (
            !isDetecting && (
              <input
                type="text"
                value={config.model || ''}
                onChange={(e) => setModel(e.target.value)}
                placeholder={t('settings.localModel.modelPlaceholder')}
                className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400"
              />
            )
          )}
        </div>
      </div>
    </div>
  )
}
