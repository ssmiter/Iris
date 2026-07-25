import { useState, useEffect, useCallback } from 'react'
import { cn } from '@/utils'
import { useTranslation } from 'react-i18next'
import { websiteCloudApi } from '@/api/websiteCloudApi'
import { useRuntimeConfigStore } from '@/stores/runtimeConfigStore'
import type { CloudPlan, CloudPlanListItem, TokenHubKeyMeta } from '@/types/tokenhub'
import {
  CreditCard,
  Loader2,
  AlertCircle,
  Package,
  RefreshCw,
  ExternalLink,
  Check,
  Cloud,
  KeyRound,
} from 'lucide-react'

/**
 * 可购套餐兜底数据：仅在 `GET /api/cloud/plans` 拉取失败时使用
 * （website r125 已提供该接口，正常情况下走动态数据）。
 * 数值与 website Plans 表 seed 保持一致。
 */
const FALLBACK_PLANS: CloudPlanListItem[] = [
  {
    key: 'starter',
    name: '体验版',
    price: 29,
    currency: 'CNY',
    monthlyTokenQuota: 10_000_000,
    description: '个人用户入门体验',
    sortOrder: 1,
  },
  {
    key: 'pro',
    name: '专业版',
    price: 99,
    currency: 'CNY',
    monthlyTokenQuota: 20_000_000,
    description: '个人深度使用 / 小团队',
    sortOrder: 2,
  },
]

const FALLBACK_WEBSITE_BASE_URL = 'https://wonwork.wongoing.com'

/**
 * 套餐与购买（website-online 公网版）
 *
 * 设计决策（2026-07-20）：客户端内不内嵌支付。购买闭环统一收在官网 pricing.html
 * （website 服务端已实现：扫码 → 回调 → 开通 job → 腾讯云建 Key），本页只做：
 *   1. 当前套餐 + TokenHub Key 状态展示（走已打通的 websiteCloudApi）
 *   2. 可购套餐卡片 + 「去官网购买」外链
 *   3. 购买后手动刷新状态
 *
 * 此前的 createOrder / 收款码 / 凭证上传走 cloudApi（/api/cloud/payment/*），
 * 该契约服务端从未实现、AIGateway 也未代理，已整体移除（死链路）。
 */
export function PaymentSettingsView() {
  const { t } = useTranslation()
  const websiteBaseUrl =
    useRuntimeConfigStore((s) => s.config.baseUrl) || FALLBACK_WEBSITE_BASE_URL

  const [plan, setPlan] = useState<CloudPlan | null>(null)
  const [keyMeta, setKeyMeta] = useState<TokenHubKeyMeta | null>(null)
  const [plans, setPlans] = useState<CloudPlanListItem[]>(FALLBACK_PLANS)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const [planRes, keyRes, plansRes] = await Promise.all([
        websiteCloudApi.getCurrentPlan(),
        websiteCloudApi.getTokenHubKeyMeta(),
        websiteCloudApi.getPlans(),
      ])
      setPlan(planRes.plan)
      setKeyMeta(keyRes.key)
      if (plansRes.plans && plansRes.plans.length > 0) {
        setPlans(plansRes.plans)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.payment.loadFailed'))
    } finally {
      setIsLoading(false)
    }
  }, [t])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  const pricingUrl = `${websiteBaseUrl.replace(/\/$/, '')}/pricing.html`

  return (
    <div className="bg-white border border-surface-200 rounded-xl p-5 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CreditCard size={16} className="text-surface-500" />
          <h3 className="text-sm font-semibold text-surface-700">{t('settings.payment.title')}</h3>
        </div>
        <button
          onClick={loadStatus}
          disabled={isLoading}
          className="p-1.5 rounded-lg text-surface-400 hover:bg-surface-100 transition-colors disabled:opacity-50"
          title={t('settings.payment.refresh')}
        >
          <RefreshCw size={14} className={cn(isLoading && 'animate-spin')} />
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
          <AlertCircle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm text-red-700">{error}</p>
            <button
              onClick={() => setError(null)}
              className="text-xs text-red-600 underline mt-1 hover:text-red-800"
            >
              {t('settings.payment.dismiss')}
            </button>
          </div>
        </div>
      )}

      {/* 当前套餐状态 */}
      <div className="p-4 bg-surface-50 border border-surface-200 rounded-lg space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cloud size={16} className="text-primary-500" />
            <span className="text-sm font-medium text-surface-700">
              {t('settings.payment.currentPlan')}
            </span>
          </div>
          {isLoading && !plan ? (
            <Loader2 size={14} className="animate-spin text-surface-400" />
          ) : (
            <span
              className={cn(
                'text-xs px-2 py-0.5 rounded-full font-medium',
                plan && plan.key !== 'free'
                  ? 'bg-primary-100 text-primary-700'
                  : 'bg-surface-200 text-surface-600'
              )}
            >
              {plan?.name ?? t('settings.payment.noPlan')}
            </span>
          )}
        </div>

        {plan?.tokenHub && (
          <div className="space-y-1 text-sm text-surface-600">
            <p className="text-xs text-surface-500">
              {t('settings.payment.model', { model: plan.tokenHub.model })}
              {' · '}
              {t('settings.payment.monthlyQuota', {
                count: plan.tokenHub.monthlyTokenQuota.toLocaleString(),
              })}
            </p>
            <div className="flex items-center gap-2">
              <KeyRound size={14} className="text-surface-400" />
              {keyMeta ? (
                <>
                  <code className="font-mono text-xs">{keyMeta.keyHint}</code>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">
                    {t('settings.payment.keyActive')}
                  </span>
                </>
              ) : (
                <span className="text-xs text-surface-500">{t('settings.payment.keyPending')}</span>
              )}
            </div>
          </div>
        )}

        {plan && !plan.tokenHub && plan.key !== 'free' && (
          <p className="text-xs text-amber-600">{t('settings.payment.provisioning')}</p>
        )}
      </div>

      {/* 可购套餐 */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Package size={14} className="text-surface-400" />
          <span className="text-xs font-medium text-surface-500">
            {t('settings.payment.availablePlans')}
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {plans.map((p) => {
            const isCurrent = plan?.key === p.key
            return (
              <div
                key={p.key}
                className={cn(
                  'p-3 border rounded-lg',
                  isCurrent ? 'border-primary-300 bg-primary-50' : 'border-surface-200 bg-white'
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-surface-700">{p.name}</span>
                  <span className="text-sm font-semibold text-primary-600">
                    ¥{p.price}
                    <span className="text-xs font-normal text-surface-400">
                      {t('settings.payment.perMonth')}
                    </span>
                  </span>
                </div>
                {p.description && <p className="text-xs text-surface-500 mt-1">{p.description}</p>}
                {p.monthlyTokenQuota != null && (
                  <p className="text-xs text-surface-500 mt-1">
                    {p.monthlyTokenQuota.toLocaleString()} tokens
                    {t('settings.payment.perMonth')}
                  </p>
                )}
                {isCurrent && (
                  <div className="flex items-center gap-1 mt-2 text-xs text-primary-600">
                    <Check size={13} />
                    {t('settings.payment.currentBadge')}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <a
          href={pricingUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 transition-colors"
        >
          <ExternalLink size={14} />
          {t('settings.payment.buyAtWebsite')}
        </a>
        <p className="text-xs text-surface-400 text-center">{t('settings.payment.buyHint')}</p>
      </div>
    </div>
  )
}
