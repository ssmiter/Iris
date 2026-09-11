import { useState, useEffect } from 'react'
import { cn } from '@/utils'
import { useLicenseStore } from '@/stores/licenseStore'
import { useTranslation } from 'react-i18next'
import {
  Shield,
  Key,
  Check,
  AlertCircle,
  Loader2,
  Copy,
  Fingerprint,
  Calendar,
  Tag,
  Users,
  Crown,
} from 'lucide-react'

export function LicenseSettingsView() {
  const { t } = useTranslation()
  const {
    license,
    fingerprint,
    isLoading,
    isActivating,
    error,
    activate,
    deactivate,
    initialize,
    clearError,
  } = useLicenseStore()

  const [licenseKey, setLicenseKey] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    initialize()
  }, [initialize])

  const handleActivate = async () => {
    if (!licenseKey.trim()) return
    const success = await activate(licenseKey)
    if (success) {
      setLicenseKey('')
    }
  }

  const handleDeactivate = async () => {
    await deactivate()
  }

  const handleCopyFingerprint = () => {
    if (fingerprint?.hardwareId) {
      navigator.clipboard.writeText(fingerprint.hardwareId)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  const statusConfig = license
    ? {
        active: { color: 'green', label: t('settings.license.active') },
        trial: { color: 'amber', label: t('settings.license.trial') },
        expired: { color: 'red', label: t('settings.license.expired') },
        inactive: { color: 'gray', label: t('settings.license.inactive') },
        revoked: { color: 'red', label: t('settings.license.revoked') },
      }[license.status] || { color: 'gray', label: license.status }
    : { color: 'gray', label: t('settings.license.notActivated') }

  return (
    <div className="bg-[var(--wf-card-bg)] border border-[var(--wf-line)] rounded-xl p-5 space-y-5">
      <div className="flex items-center gap-2">
        <Shield size={16} className="text-[var(--wf-mut)]" />
        <h3 className="text-sm font-semibold text-[var(--wf-sub)]">{t('settings.license.title')}</h3>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-[var(--wf-mut)]">
          <Loader2 size={16} className="animate-spin" />
          {t('settings.license.loading')}
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
              {t('settings.license.dismiss')}
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <span
          className={cn(
            'text-xs px-2 py-0.5 rounded-full font-medium',
            statusConfig.color === 'green' && 'bg-[var(--wf-ok-bg)] text-[var(--wf-ok-ink)]',
            statusConfig.color === 'amber' && 'bg-[var(--wf-warn-bg)] text-[var(--wf-warn-ink)]',
            statusConfig.color === 'red' && 'bg-[var(--wf-err-bg)] text-[var(--wf-err-ink)]',
            statusConfig.color === 'gray' && 'bg-[var(--wf-mono-bg)] text-[var(--wf-sub)]'
          )}
        >
          {statusConfig.label}
        </span>
        {license && (
          <span className="text-xs text-[var(--wf-faint)] truncate">
            {license.licenseKey}
          </span>
        )}
      </div>

      {license && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-[var(--wf-sub)]">
            <Tag size={14} className="text-[var(--wf-faint)]" />
            <span>{license.productName}</span>
          </div>
          {license.tier && (
            <div className="flex items-center gap-2 text-sm text-[var(--wf-sub)]">
              <Crown size={14} className="text-[var(--wf-faint)]" />
              <span className="capitalize">{license.tier}</span>
              {license.planId && (
                <span className="text-xs text-[var(--wf-faint)]">({license.planId})</span>
              )}
            </div>
          )}
          {typeof license.seats === 'number' && (
            <div className="flex items-center gap-2 text-sm text-[var(--wf-sub)]">
              <Users size={14} className="text-[var(--wf-faint)]" />
              <span>
                {t('settings.license.seats', { count: license.seats })}
                {license.activatedMachines !== undefined && (
                  <span className="text-[var(--wf-faint)] text-xs ml-1">
                    {t('settings.license.activatedMachines', { count: license.activatedMachines })}
                  </span>
                )}
              </span>
            </div>
          )}
          {license.expiresAt && (
            <div className="flex items-center gap-2 text-sm text-[var(--wf-sub)]">
              <Calendar size={14} className="text-[var(--wf-faint)]" />
              <span>
                {t('settings.license.expiresAt', {
                  date: new Date(license.expiresAt).toLocaleDateString(),
                })}
              </span>
            </div>
          )}
          {license.features && license.features.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {license.features.map((feature) => (
                <span
                  key={feature}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--wf-mono-bg)] text-[var(--wf-mut)]"
                >
                  {feature}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {!license && (
        <div className="space-y-3">
          <label className="block text-sm text-[var(--wf-sub)]">
            <div className="flex items-center gap-1 mb-1">
              <Key size={14} />
              {t('settings.license.licenseKey')}
            </div>
            <input
              type="text"
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value)}
              placeholder={t('settings.license.licenseKeyPlaceholder')}
              className="w-full px-3 py-2 border border-[var(--wf-line)] rounded-lg text-sm focus:outline-none focus:border-primary-400"
            />
          </label>
          <button
            onClick={handleActivate}
            disabled={isActivating || !licenseKey.trim()}
            className={cn(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
              isActivating || !licenseKey.trim()
                ? 'bg-[var(--wf-mono-bg)] text-[var(--wf-faint)] cursor-not-allowed'
                : 'bg-primary-500 text-white hover:bg-primary-600'
            )}
          >
            {isActivating && <Loader2 size={14} className="animate-spin" />}
            {isActivating ? t('settings.license.activating') : t('settings.license.activate')}
          </button>
        </div>
      )}

      {license && (
        <button
          onClick={handleDeactivate}
          disabled={isLoading}
          className="px-4 py-2 rounded-lg text-sm text-[var(--wf-err-ink)] border border-[var(--wf-err-line)] hover:bg-[var(--wf-err-bg)] transition-colors"
        >
          {t('settings.license.deactivate')}
        </button>
      )}

      <div className="pt-4 border-t border-[var(--wf-hair)]">
        <div className="flex items-center gap-2 mb-2">
          <Fingerprint size={14} className="text-[var(--wf-faint)]" />
          <span className="text-xs font-medium text-[var(--wf-mut)]">{t('settings.license.machineFingerprint')}</span>
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs bg-[var(--wf-bg)] border border-[var(--wf-line)] rounded px-2 py-1.5 text-[var(--wf-sub)] truncate">
            {fingerprint?.hardwareId || t('settings.license.unknown')}
          </code>
          <button
            onClick={handleCopyFingerprint}
            className="p-1.5 rounded-lg text-[var(--wf-mut)] hover:bg-[var(--wf-hover)] transition-colors"
            title={t('settings.license.copyFingerprint')}
          >
            {copied ? <Check size={14} className="text-[var(--wf-ok-ink)]" /> : <Copy size={14} />}
          </button>
        </div>
      </div>
    </div>
  )
}
