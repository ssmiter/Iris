import { useEffect, useState } from 'react'
import { cn } from '@/utils'
import { useQuotaStore } from '@/stores/quotaStore'
import { isUnlimitedQuota } from '@/api/quotaApi'
import { useTranslation } from 'react-i18next'
import { PlanUpgradeDialog } from '@/components/License'
import { isWebsiteOnline } from '@/utils/runtimeMode'
import {
  Coins,
  AlertCircle,
  Loader2,
  RefreshCw,
  Calendar,
  Package,
  ArrowUpCircle,
  ExternalLink,
} from 'lucide-react'

const WEBSITE_BASE_URL = 'https://wonwork.wongoing.com'

export function QuotaSettingsView() {
  const { t } = useTranslation()
  const { usage, plans, isLoading, error, loadQuota, loadPlans, refresh, clearError } = useQuotaStore()
  const [showUpgradeDialog, setShowUpgradeDialog] = useState(false)

  useEffect(() => {
    loadQuota()
    loadPlans()
  }, [loadQuota, loadPlans])

  const unlimited = isUnlimitedQuota(usage)
  const used = usage?.usedTokens ?? 0
  const total = unlimited ? Math.max(used, 1) : (usage?.totalTokens ?? 0)
  const remaining = unlimited ? Infinity : Math.max((usage?.remainingTokens ?? 0), 0)
  const percentage = total > 0 ? Math.min((used / total) * 100, 100) : 0

  return (
    <div className="bg-white border border-surface-200 rounded-xl p-5 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Coins size={16} className="text-surface-500" />
          <h3 className="text-sm font-semibold text-surface-700">{t('settings.quota.title')}</h3>
        </div>
        <div className="flex items-center gap-2">
          {isWebsiteOnline() ? (
            <a
              href={`${WEBSITE_BASE_URL}/pricing.html`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-primary-600 bg-primary-50 hover:bg-primary-100 rounded-lg transition-colors"
            >
              <ExternalLink size={13} />
              {t('settings.quota.upgradeWebsite')}
            </a>
          ) : (
            <button
              onClick={() => setShowUpgradeDialog(true)}
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-primary-600 bg-primary-50 hover:bg-primary-100 rounded-lg transition-colors"
            >
              <ArrowUpCircle size={13} />
              {t('settings.quota.upgrade')}
            </button>
          )}
          <button
            onClick={refresh}
            disabled={isLoading}
            className="p-1.5 rounded-lg text-surface-400 hover:bg-surface-100 transition-colors disabled:opacity-50"
            title={t('settings.quota.refresh')}
          >
            <RefreshCw size={14} className={cn(isLoading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {isLoading && !usage && (
        <div className="flex items-center gap-2 text-sm text-surface-500">
          <Loader2 size={16} className="animate-spin" />
          {t('settings.quota.loading')}
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
              {t('settings.quota.dismiss')}
            </button>
          </div>
        </div>
      )}

      {usage && (
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-surface-600">
                {usage.planName || t('settings.quota.currentPlan')}
              </span>
              <span className="font-medium text-surface-800">
                {unlimited
                  ? t('settings.quota.unlimited')
                  : t('settings.quota.usageCount', {
                      used: used.toLocaleString(),
                      total: total.toLocaleString(),
                    })}
              </span>
            </div>
            {!unlimited && (
              <div className="h-2 bg-surface-100 rounded-full overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    percentage >= 90 ? 'bg-red-500' : percentage >= 70 ? 'bg-amber-500' : 'bg-primary-500'
                  )}
                  style={{ width: `${percentage}%` }}
                />
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 bg-surface-50 rounded-lg">
              <p className="text-xs text-surface-500">{t('settings.quota.remaining')}</p>
              <p className="text-lg font-semibold text-surface-800">
                {unlimited ? t('settings.quota.unlimited') : remaining.toLocaleString()}
              </p>
            </div>
            <div className="p-3 bg-surface-50 rounded-lg">
              <p className="text-xs text-surface-500">{t('settings.quota.used')}</p>
              <p className="text-lg font-semibold text-surface-800">{used.toLocaleString()}</p>
            </div>
          </div>

          {(usage.resetAt || usage.expiresAt) && (
            <div className="flex items-center gap-2 text-sm text-surface-600">
              <Calendar size={14} className="text-surface-400" />
              <span>
                {usage.resetAt
                  ? t('settings.quota.resetAt', { date: new Date(usage.resetAt).toLocaleDateString() })
                  : t('settings.quota.expiresAt', { date: new Date(usage.expiresAt!).toLocaleDateString() })}
              </span>
            </div>
          )}
        </div>
      )}

      {plans.length > 0 && (
        <div className="pt-4 border-t border-surface-100 space-y-3">
          <div className="flex items-center gap-2">
            <Package size={14} className="text-surface-400" />
            <span className="text-xs font-medium text-surface-500">{t('settings.quota.availablePlans')}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {plans.map((plan) => (
              <div
                key={plan.id}
                className={cn(
                  'p-3 border rounded-lg',
                  plan.isActive ? 'border-primary-300 bg-primary-50' : 'border-surface-200 bg-white'
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-surface-700">{plan.name}</span>
                  <span className="text-sm font-semibold text-primary-600">
                    ¥{plan.price}
                  </span>
                </div>
                {plan.description && (
                  <p className="text-xs text-surface-500 mt-1">{plan.description}</p>
                )}
                <p className="text-xs text-surface-500 mt-1">
                  {plan.tokenAmount.toLocaleString()} tokens
                  {plan.durationDays && ` · ${plan.durationDays}${t('settings.quota.days')}`}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
      <PlanUpgradeDialog
        isOpen={showUpgradeDialog}
        onClose={() => setShowUpgradeDialog(false)}
      />
    </div>
  )
}
