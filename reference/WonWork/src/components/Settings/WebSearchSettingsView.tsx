import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Save, Check } from 'lucide-react'
import { cn } from '@/utils'
import { getStandaloneConfig, setStandaloneConfig, type StandaloneConfig } from '@/api/standaloneApi'

export function WebSearchSettingsView() {
  const { t } = useTranslation()
  const [config, setConfig] = useState<StandaloneConfig>(getStandaloneConfig)
  const [saved, setSaved] = useState(false)

  const handleChange = useCallback(
    (field: 'searchProvider' | 'searchApiKey' | 'searchApiBaseUrl', value: string) => {
      setConfig((prev) => ({ ...prev, [field]: value }))
      setSaved(false)
    },
    []
  )

  const handleSave = useCallback(() => {
    setStandaloneConfig(config)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [config])

  return (
    <div className="bg-white border border-surface-200 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Search size={16} className="text-surface-500" />
        <h3 className="text-sm font-semibold text-surface-700">{t('settings.standaloneSettings.webSearch')}</h3>
      </div>

      <div className="space-y-4">
        <label className="block text-sm text-surface-600">
          {t('settings.standaloneSettings.searchProvider')}
          <select
            value={config.searchProvider || 'bing'}
            onChange={(e) =>
              handleChange('searchProvider', e.target.value)
            }
            className="mt-1 w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400 bg-white"
          >
            <option value="bing">{t('settings.standaloneSettings.searchProviderBing')}</option>
            <option value="custom">{t('settings.standaloneSettings.searchProviderCustom')}</option>
          </select>
        </label>

        {config.searchProvider === 'custom' && (
          <label className="block text-sm text-surface-600">
            {t('settings.standaloneSettings.searchApiBaseUrl')}
            <input
              type="text"
              value={config.searchApiBaseUrl || ''}
              onChange={(e) => handleChange('searchApiBaseUrl', e.target.value)}
              placeholder="https://api.bing.microsoft.com/v7.0/search"
              className="mt-1 w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400"
            />
          </label>
        )}

        <label className="block text-sm text-surface-600">
          {t('settings.standaloneSettings.searchApiKey')}
          <input
            type="password"
            value={config.searchApiKey || ''}
            onChange={(e) => handleChange('searchApiKey', e.target.value)}
            placeholder={t('settings.standaloneSettings.searchApiKeyPlaceholder')}
            className="mt-1 w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400"
          />
        </label>

        <p className="text-xs text-surface-400 leading-relaxed">
          {t('settings.standaloneSettings.searchHint')}
        </p>

        <div className="flex justify-end">
          <button
            onClick={handleSave}
            className={cn(
              'px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2',
              saved
                ? 'bg-green-500 text-white'
                : 'bg-primary-500 text-white hover:bg-primary-600'
            )}
          >
            {saved ? <Check size={14} /> : <Save size={14} />}
            {saved ? t('settings.standaloneSettings.saved') : t('settings.standaloneSettings.saveSettings')}
          </button>
        </div>
      </div>
    </div>
  )
}
