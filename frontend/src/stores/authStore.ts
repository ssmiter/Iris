import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { UserInfo } from '@/types/mescli'

/**
 * 【Iris 2026-09 收敛】本地单用户个人版身份 store。
 *
 * WonWork 的三轨身份体系（MES 工号 / website 官网账号 / cloud 云账号 + 心跳守卫
 * sessionGuard + 会话恢复 authSessionRecovery）是企业 MES 场景的历史包袱，已整体删除。
 * Iris 启动即以固定本地身份运行：无登录流程、无登录 UI、无 token、无多身份字段。
 *
 * 身份语义：
 * - user 恒为本地用户（userId:1, userName:'local', realName:'Local User', systemCode:'local'），
 *   与后端 GET /api/auth/user 返回的本地用户同形；isLoggedIn 恒 true。
 * - 保留 user/isLoggedIn/setUser/logout 骨架：下游组件（Sidebar/ChatView/chatStore 等）
 *   继续读这些字段，不需要改。logout 语义收敛为"重置回本地身份"（无登录页可回）。
 * - 不向 localStorage 写任何 wonclaw_token / wonclaw_user_* / wonclaw_* 透传凭证——
 *   后端 middleware 本地模式直接回退本地用户，不需要 token。
 */

/** 固定本地身份（与后端 GET /api/auth/user 的本地用户响应同形） */
export const LOCAL_USER: UserInfo = {
  userId: 1,
  userName: 'local',
  realName: 'Local User',
  systemCode: 'local',
  roleId: 1,
  factoryId: 1,
  deptId: 1,
  workshopId: 1,
}

interface AuthState {
  user: UserInfo
  /** 恒 true：本地个人版无未登录态。字段保留供下游组件读取。 */
  isLoggedIn: boolean

  // Actions
  setUser: (user: UserInfo) => void
  /** 本地个人版无登录页可回——logout 收敛为把身份重置回固定本地用户。 */
  logout: () => Promise<void>
  /** 幂等：启动核对入口。本地身份由初始值直接构造，无需恢复任何会话。 */
  initLocalIdentity: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: LOCAL_USER,
      isLoggedIn: true,

      setUser: (user) => {
        set({ user, isLoggedIn: true })
      },

      logout: async () => {
        set({ user: LOCAL_USER, isLoggedIn: true })
      },

      initLocalIdentity: () => {
        set({ user: LOCAL_USER, isLoggedIn: true })
      },
    }),
    {
      name: 'wonclaw-auth',
      partialize: (state) => ({
        user: state.user,
        isLoggedIn: state.isLoggedIn,
      }),
    }
  )
)
