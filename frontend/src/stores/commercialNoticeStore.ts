import { create } from 'zustand'

export type CommercialNoticeType = 'quota_exhausted' | 'license_expired' | 'license_revoked' | 'feature_not_allowed' | 'payment_required'

interface CommercialNotice {
  type: CommercialNoticeType
  message: string
}

interface CommercialNoticeState {
  notice: CommercialNotice | null

  /** 由 API 层调用，触发全局商业化提示 */
  showNotice: (type: CommercialNoticeType, message: string) => void
  /** 关闭当前提示 */
  dismiss: () => void
}

export const useCommercialNoticeStore = create<CommercialNoticeState>()((set) => ({
  notice: null,

  showNotice: (type, message) => {
    set({ notice: { type, message } })
  },

  dismiss: () => set({ notice: null }),
}))
