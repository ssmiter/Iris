import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { quotaApi } from '@/api/quotaApi'
import type { QuotaUsage, TokenPlan } from '@/types/mescli'

interface QuotaState {
  usage: QuotaUsage | null
  plans: TokenPlan[]
  isLoading: boolean
  error: string | null

  loadQuota: () => Promise<void>
  loadPlans: () => Promise<void>
  refresh: () => Promise<void>
  clearError: () => void

  /** 是否无限制额度 */
  isUnlimited: () => boolean
  /** 是否已耗尽 */
  isExhausted: () => boolean
  /** 是否至少还能使用指定 Token 数 */
  canUseTokens: (amount: number) => boolean
}

export const useQuotaStore = create<QuotaState>()(
  persist(
    (set, get) => ({
      usage: null,
      plans: [],
      isLoading: false,
      error: null,

      loadQuota: async () => {
        set({ isLoading: true, error: null })
        try {
          const usage = await quotaApi.getUsage()
          set({ usage, isLoading: false })
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : '加载额度失败',
            isLoading: false,
          })
        }
      },

      loadPlans: async () => {
        set({ isLoading: true, error: null })
        try {
          const plans = await quotaApi.getPlans()
          set({ plans, isLoading: false })
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : '加载套餐失败',
            isLoading: false,
          })
        }
      },

      refresh: async () => {
        await Promise.all([get().loadQuota(), get().loadPlans()])
      },

      clearError: () => set({ error: null }),

      isUnlimited: () => {
        const usage = get().usage
        return usage?.totalTokens === -1 || usage?.remainingTokens === -1
      },

      isExhausted: () => {
        const usage = get().usage
        if (!usage) return false
        if (usage.totalTokens === -1 || usage.remainingTokens === -1) return false
        return usage.remainingTokens <= 0
      },

      canUseTokens: (amount: number) => {
        const usage = get().usage
        if (!usage) return true
        if (usage.totalTokens === -1 || usage.remainingTokens === -1) return true
        return usage.remainingTokens >= amount
      },
    }),
    {
      name: 'wonwork-quota',
      partialize: (state) => ({
        usage: state.usage,
        plans: state.plans,
      }),
    }
  )
)
