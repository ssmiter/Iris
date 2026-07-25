import { create } from 'zustand'

export interface RuntimeAuthConfig {
  /** 是否强制登录 */
  requireLogin: boolean
  /** 登录提供方 */
  provider: 'none' | 'website' | 'cloud' | string
  /** 对外暴露的 website 根地址（调试用，实际请求走本地代理） */
  baseUrl: string
  /** 是否允许用户自配 API Key（BYOK） */
  byokEnabled: boolean
  /** 是否显示付费相关信息（TokenHub/额度/升级入口）。公网 v1.0 BYOK 发布版为 false；
   * 后端缺省 true，未读到该字段时按 true 处理（保持现状） */
  paymentEnabled?: boolean
}

/** 付费信息是否可见：未明确 false 即可见（旧后端/网络异常时保持现状） */
export function isPaymentVisible(cfg: Pick<RuntimeAuthConfig, 'paymentEnabled'>): boolean {
  return cfg.paymentEnabled !== false
}

interface RuntimeConfigState {
  config: RuntimeAuthConfig
  loaded: boolean
  error: string | null
  load: () => Promise<void>
}

export const useRuntimeConfigStore = create<RuntimeConfigState>((set) => ({
  config: { requireLogin: false, provider: 'none', baseUrl: '', byokEnabled: false, paymentEnabled: true },
  loaded: false,
  error: null,
  load: async () => {
    try {
      const res = await fetch('/api/auth/runtime-config', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const data = (await res.json()) as RuntimeAuthConfig
      set({ config: data, loaded: true, error: null })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ loaded: true, error: message })
      // 网络异常时保守处理：默认不要求登录，避免无法进入客户端
      set({ config: { requireLogin: false, provider: 'none', baseUrl: '', byokEnabled: false, paymentEnabled: true } })
    }
  },
}))
