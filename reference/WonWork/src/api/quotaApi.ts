import { isPreview, isOnline } from '@/config/product'
import { fetchApi } from './client'
import { websiteCloudApi } from './websiteCloudApi'
import type { CloudPlan } from '@/types/tokenhub'
import type { QuotaUsage, TokenPlan } from '@/types/mescli'
import { DEFAULT_FEATURES_BY_TIER, FEATURE_FLAGS } from '@/config/product'
import type { LicenseTier } from '@/types/mescli'

// ==================== MESCLI 实现 ====================

const mescliQuotaApi = {
  /** GET /api/quota/usage */
  getUsage: async (): Promise<QuotaUsage> => {
    return fetchApi<QuotaUsage>('/api/quota/usage')
  },

  /** GET /api/quota/plans */
  getPlans: async (): Promise<TokenPlan[]> => {
    return fetchApi<TokenPlan[]>('/api/quota/plans')
  },
}

// ==================== Online 实现（Wongoing Cloud） ====================

function mapCloudTier(tier: string): LicenseTier {
  const t = tier.toLowerCase()
  if (t === 'pro') return 'pro'
  if (t === 'enterprise') return 'enterprise'
  return 'free'
}

function mapWebsitePlanToTokenPlan(plan: CloudPlan): TokenPlan {
  const tier = mapCloudTier(plan.key)
  const info = plan.tokenHub
  return {
    id: plan.key,
    name: plan.name,
    tier,
    tokenAmount: info?.monthlyTokenQuota ?? 0,
    price: 0,
    currency: 'CNY',
    description: '',
    isActive: true,
    features: DEFAULT_FEATURES_BY_TIER[tier] ?? DEFAULT_FEATURES_BY_TIER.free,
  }
}

const onlineQuotaApi = {
  getUsage: async (): Promise<QuotaUsage> => {
    const [plan, usage] = await Promise.all([
      websiteCloudApi.getCurrentPlan(),
      websiteCloudApi.getQuotaUsage(),
    ])
    return {
      planId: plan.plan?.key ?? 'free',
      planName: plan.plan?.name ?? 'Free',
      totalTokens: usage.monthlyTokenQuota ?? -1,
      usedTokens: usage.usedTokens,
      remainingTokens:
        usage.monthlyTokenQuota != null
          ? usage.monthlyTokenQuota - usage.usedTokens
          : -1,
    }
  },

  getPlans: async (): Promise<TokenPlan[]> => {
    const res = await websiteCloudApi.getCurrentPlan()
    if (!res.plan) return []
    return [mapWebsitePlanToTokenPlan(res.plan)]
  },
}

// ==================== Preview 实现（BYOK 无限制） ====================

const previewQuotaApi = {
  getUsage: async (): Promise<QuotaUsage> => {
    return {
      planId: 'preview-byok',
      planName: 'Preview BYOK',
      totalTokens: -1,
      usedTokens: 0,
      remainingTokens: -1,
    }
  },

  getPlans: async (): Promise<TokenPlan[]> => {
    return []
  },
}

export const quotaApi = isPreview ? previewQuotaApi : isOnline ? onlineQuotaApi : mescliQuotaApi

/** 判断额度是否为无限制 */
export function isUnlimitedQuota(quota: QuotaUsage | null | undefined): boolean {
  return quota?.totalTokens === -1 || quota?.remainingTokens === -1
}

/** 根据套餐 tier 获取默认功能列表 */
export function getFeaturesByTier(tier: LicenseTier): string[] {
  return DEFAULT_FEATURES_BY_TIER[tier] ?? DEFAULT_FEATURES_BY_TIER.free
}
