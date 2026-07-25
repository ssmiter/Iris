import { useTranslation } from 'react-i18next'
import { useWebBridgeStore } from '@/stores/webbridgeStore'
import { WEBBRIDGE_PRESETS } from '@/types/webbridge'
import { Shield, ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react'

const SECURITY_LEVELS = ['read_only', 'standard', 'elevated', 'full'] as const

const LEVEL_ICONS: Record<typeof SECURITY_LEVELS[number], React.ReactNode> = {
  read_only: <ShieldX size={18} />,
  standard: <Shield size={18} />,
  elevated: <ShieldCheck size={18} />,
  full: <ShieldAlert size={18} />,
}

export function SecurityPanel() {
  const { t } = useTranslation()
  const { securityPolicy, config, loadPreset, setSecurityPolicy } = useWebBridgeStore()

  const domainsToString = (domains?: string[]) => (domains || []).join('\n')
  const stringToDomains = (value: string) =>
    value
      .split(/\n|,/)
      .map((d) => d.trim())
      .filter(Boolean)

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-primary-100 rounded-lg">
            <ShieldCheck className="text-primary-600" size={24} />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-surface-900">{t('webbridge.securityPanel.title')}</h2>
            <p className="text-sm text-surface-500">{t('webbridge.securityPanel.subtitle')}</p>
          </div>
        </div>

        <div className="mb-6">
          <label className="block text-sm font-medium text-surface-700 mb-2">{t('webbridge.securityPanel.preset')}</label>
          <select
            value={config.name || 'default-webbridge'}
            onChange={(e) => loadPreset(e.target.value)}
            className="w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            {Object.keys(WEBBRIDGE_PRESETS).map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>

        <div className="mb-6">
          <label className="block text-sm font-medium text-surface-700 mb-2">{t('webbridge.securityPanel.securityLevel')}</label>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {SECURITY_LEVELS.map((level) => (
              <button
                key={level}
                onClick={() => setSecurityPolicy({ security_level: level })}
                className={`flex flex-col items-center gap-2 p-3 rounded-lg border text-sm font-medium transition-colors ${
                  securityPolicy.security_level === level
                    ? 'border-primary-500 bg-primary-50 text-primary-700'
                    : 'border-surface-200 bg-surface-50 text-surface-600 hover:bg-surface-100'
                }`}
              >
                <span className={securityPolicy.security_level === level ? 'text-primary-600' : 'text-surface-400'}>
                  {LEVEL_ICONS[level]}
                </span>
                {t(`webbridge.securityLevels.${level}`, level)}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {[
            { key: 'allow_file_download', label: t('webbridge.securityPanel.allowFileDownload') },
            { key: 'allow_file_upload', label: t('webbridge.securityPanel.allowFileUpload') },
            { key: 'allow_javascript', label: t('webbridge.securityPanel.allowJavascript') },
            { key: 'allow_form_submission', label: t('webbridge.securityPanel.allowFormSubmission') },
            { key: 'require_domain_approval', label: t('webbridge.securityPanel.requireDomainApproval') },
            { key: 'block_financial_sites', label: t('webbridge.securityPanel.blockFinancialSites') },
            { key: 'block_government_sites', label: t('webbridge.securityPanel.blockGovernmentSites') },
            { key: 'warn_on_password_fields', label: t('webbridge.securityPanel.warnOnPasswordFields') },
            { key: 'screenshot_sensitive_pages', label: t('webbridge.securityPanel.screenshotSensitivePages') },
            { key: 'allow_cookie_access', label: t('webbridge.securityPanel.allowCookieAccess') },
            { key: 'allow_localstorage_access', label: t('webbridge.securityPanel.allowLocalstorageAccess') },
          ].map((item) => {
            const key = item.key as keyof typeof securityPolicy
            const checked = !!securityPolicy[key]
            return (
              <label key={item.key} className="flex items-center gap-3 p-3 bg-surface-50 rounded-lg cursor-pointer">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => setSecurityPolicy({ [key]: e.target.checked } as Partial<typeof securityPolicy>)}
                  className="w-4 h-4 text-primary-600 rounded border-surface-300 focus:ring-primary-500"
                />
                <span className="text-sm text-surface-700">{item.label}</span>
              </label>
            )
          })}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div>
            <label className="block text-sm font-medium text-surface-700 mb-1">{t('webbridge.securityPanel.allowedDomains')}</label>
            <textarea
              value={domainsToString(securityPolicy.allowed_domains)}
              onChange={(e) => setSecurityPolicy({ allowed_domains: stringToDomains(e.target.value) })}
              rows={4}
              className="w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              placeholder="example.com\napp.example.com"
            />
            <p className="text-xs text-surface-400 mt-1">{t('webbridge.securityPanel.domainsHint')}</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-surface-700 mb-1">{t('webbridge.securityPanel.blockedDomains')}</label>
            <textarea
              value={domainsToString(securityPolicy.blocked_domains)}
              onChange={(e) => setSecurityPolicy({ blocked_domains: stringToDomains(e.target.value) })}
              rows={4}
              className="w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              placeholder="bad-site.com"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-surface-700 mb-1">{t('webbridge.securityPanel.maxActionsPerMinute')}</label>
            <input
              type="number"
              value={securityPolicy.max_actions_per_minute || 60}
              onChange={(e) => setSecurityPolicy({ max_actions_per_minute: parseInt(e.target.value, 10) || 0 })}
              className="w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-surface-700 mb-1">{t('webbridge.securityPanel.delayBetweenActionsMs')}</label>
            <input
              type="number"
              value={securityPolicy.delay_between_actions_ms || 500}
              onChange={(e) => setSecurityPolicy({ delay_between_actions_ms: parseInt(e.target.value, 10) || 0 })}
              className="w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
