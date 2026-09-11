import { create } from 'zustand'
import { adminAuthApi } from '@/api/client'

/**
 * 管理员提权态（权限码登录，企业级入口）。
 * - token 存 localStorage.wonclaw_admin_token，由 client.ts 作为 X-Admin-Token 头附带；
 *   与主登录态（wonclaw_token）正交，互不影响。
 * - 提权 token 4h 过期不续签；启动时已过期待清理（clearExpired）。
 * - 后端权限码轮换会使既有 token 全量失效（codeVer 机制），此时接口 403，
 *   用户重新输码即可，无需手动清理。
 */
const TOKEN_KEY = 'wonclaw_admin_token'
const EXPIRES_AT_KEY = 'wonclaw_admin_expires_at'

function readPersisted(): { token: string | null; expiresAt: number | null } {
  const token = localStorage.getItem(TOKEN_KEY)
  const expiresAtRaw = localStorage.getItem(EXPIRES_AT_KEY)
  const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : null
  return { token, expiresAt: expiresAt && Number.isFinite(expiresAt) ? expiresAt : null }
}

interface AdminState {
  /** 当前是否处于提权态（token 存在且未过期） */
  isElevated: boolean
  /** 提权过期时间（epoch ms），未提权为 null */
  expiresAt: number | null
  /** 权限码提权；失败抛错（含锁定提示），由调用方展示 */
  elevate: (accessCode: string) => Promise<void>
  /** 主动退出提权（通知后端记日志，本地立即清理） */
  revoke: () => Promise<void>
  /** 启动时调用：清理过期 token */
  clearExpired: () => void
}

export const useAdminStore = create<AdminState>()((set, get) => ({
  isElevated: false,
  expiresAt: null,

  elevate: async (accessCode) => {
    const result = await adminAuthApi.elevate(accessCode)
    const expiresAt = new Date(result.expiresAt).getTime()
    localStorage.setItem(TOKEN_KEY, result.adminToken)
    localStorage.setItem(EXPIRES_AT_KEY, String(expiresAt))
    set({ isElevated: true, expiresAt })
  },

  revoke: async () => {
    try {
      await adminAuthApi.revoke()
    } catch {
      // 通知失败不阻塞本地退出（token 本就 4h 自过期）
    }
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(EXPIRES_AT_KEY)
    set({ isElevated: false, expiresAt: null })
  },

  clearExpired: () => {
    const { token, expiresAt } = readPersisted()
    if (token && expiresAt && expiresAt > Date.now()) {
      set({ isElevated: true, expiresAt })
    } else {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(EXPIRES_AT_KEY)
      if (get().isElevated) set({ isElevated: false, expiresAt: null })
    }
  },
}))
