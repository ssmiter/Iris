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
    <div className="bg-white border border-surface-200 rounded-xl p-5 space-y-5">
      <div className="flex items-center gap-2">
        <Shield size={16} className="text-surface-500" />
        <h3 className="text-sm font-semibold text-surface-700">{t('settings.license.title')}</h3>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-surface-500">
          <Loader2 size={16} className="animate-spin" />
          {t('settings.license.loading')}
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
              {t('settings.license.dismiss')}
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <span
          className={cn(
            'text-xs px-2 py-0.5 rounded-full font-medium',
            statusConfig.color === 'green' && 'bg-green-100 text-green-700',
            statusConfig.color === 'amber' && 'bg-amber-100 text-amber-700',
            statusConfig.color === 'red' && 'bg-red-100 text-red-700',
            statusConfig.color === 'gray' && 'bg-surface-100 text-surface-600'
          )}
        >
          {statusConfig.label}
        </span>
        {license && (
          <span className="text-xs text-surface-400 truncate">
            {license.licenseKey}
          </span>
        )}
      </div>

      {license && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-surface-600">
            <Tag size={14} className="text-surface-400" />
            <span>{license.productName}</span>
          </div>
          {license.tier && (
            <div className="flex items-center gap-2 text-sm text-surface-600">
              <Crown size={14} className="text-surface-400" />
              <span className="capitalize">{license.tier}</span>
              {license.planId && (
                <span className="text-xs text-surface-400">({license.planId})</span>
              )}
            </div>
          )}
          {typeof license.seats === 'number' && (
            <div className="flex items-center gap-2 text-sm text-surface-600">
              <Users size={14} className="text-surface-400" />
              <span>
                {license.seats} 席位
                {license.activatedMachines !== undefined && (
                  <span className="text-surface-400 text-xs ml-1">
                    · 已激活 {license.activatedMachines} 台设备
                  </span>
                )}
              </span>
            </div>
          )}
          {license.expiresAt && (
            <div className="flex items-center gap-2 text-sm text-surface-600">
              <Calendar size={14} className="text-surface-400" />
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
                  className="text-[10px] px-1.5 py-0.5 rounded bg-surface-100 text-surface-500"
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
          <label className="block text-sm text-surface-600">
            <div className="flex items-center gap-1 mb-1">
              <Key size={14} />
              {t('settings.license.licenseKey')}
            </div>
            <input
              type="text"
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value)}
              placeholder={t('settings.license.licenseKeyPlaceholder')}
              className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400"
            />
          </label>
          <button
            onClick={handleActivate}
            disabled={isActivating || !licenseKey.trim()}
            className={cn(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
              isActivating || !licenseKey.trim()
                ? 'bg-surface-200 text-surface-400 cursor-not-allowed'
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
          className="px-4 py-2 rounded-lg text-sm text-red-600 border border-red-200 hover:bg-red-50 transition-colors"
        >
          {t('settings.license.deactivate')}
        </button>
      )}

      <div className="pt-4 border-t border-surface-100">
        <div className="flex items-center gap-2 mb-2">
          <Fingerprint size={14} className="text-surface-400" />
          <span className="text-xs font-medium text-surface-500">{t('settings.license.machineFingerprint')}</span>
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs bg-surface-50 border border-surface-200 rounded px-2 py-1.5 text-surface-600 truncate">
            {fingerprint?.hardwareId || t('settings.license.unknown')}
          </code>
          <button
            onClick={handleCopyFingerprint}
            className="p-1.5 rounded-lg text-surface-500 hover:bg-surface-100 transition-colors"
            title={t('settings.license.copyFingerprint')}
          >
            {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
          </button>
        </div>
      </div>
    </div>
  )
}
