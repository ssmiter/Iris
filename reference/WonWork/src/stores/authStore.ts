import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { UserInfo, AccountInfo } from '@/types/mescli'
import type { CloudTokenResponse, CloudUser } from '@/types/cloud'
import type { WebsiteUser, WebsiteAccountInfo } from '@/types/website'
import { authApi } from '@/api/client'
import { cloudApi } from '@/api/cloudApi'
import { websiteAuthApi } from '@/api/websiteAuthApi'
import { isOnline, isPreview } from '@/config/product'
import { getErrorMessage } from '@/utils/error'
import { useTokenHubStore } from '@/stores/tokenHubStore'
import { useRuntimeConfigStore } from '@/stores/runtimeConfigStore'

const IS_STANDALONE = import.meta.env.VITE_STANDALONE_MODE === 'true'

interface AuthState {
  user: UserInfo | null
  mesUser: UserInfo | null
  token: string | null
  isLoggedIn: boolean
  isMesLoggedIn: boolean
  isLoading: boolean
  error: string | null

  /** Online 模式 Wongoing 云端账号 */
  cloudAccount: AccountInfo | null
  cloudAccessToken: string | null
  cloudRefreshToken: string | null
  isCloudLoggedIn: boolean

  /** 公网版（External）Website 账号 */
  websiteAccount: WebsiteAccountInfo | null
  isWebsiteLoggedIn: boolean

  // Actions
  login: (workBarcode: string, password: string, systemCode?: string) => Promise<boolean>
  logout: () => Promise<void>
  fetchUser: () => Promise<void>
  restoreLocalUser: () => void
  setUser: (user: UserInfo) => void
  clearError: () => void

  cloudLogin: (account: string, password: string) => Promise<boolean>
  cloudRegister: (account: string, password: string, displayName?: string) => Promise<boolean>
  cloudLogout: () => Promise<void>
  restoreCloudSession: () => Promise<boolean>

  websiteLogin: (account: string, password: string) => Promise<boolean>
  websiteRegister: (account: string, password: string, code: string) => Promise<boolean>
  websiteSendCode: (account: string, purpose?: 'register' | 'reset') => Promise<{ ok: boolean; error?: string }>
  websiteLogout: () => Promise<void>
  restoreWebsiteSession: () => Promise<boolean>
}

function isLocalUser(user: UserInfo): boolean {
  const systemCode = user.systemCode?.toLowerCase() || ''
  const userName = user.userName?.toLowerCase() || ''
  const realName = user.realName || ''

  return (
    systemCode === 'local' ||
    systemCode === 'standalone' ||
    userName === 'localuser' ||
    realName === '本地用户' ||
    (userName === 'admin' && realName === '系统管理员')
  )
}

function mapCloudUserToUserInfo(cloud: CloudUser): UserInfo {
  const account = cloud.email || cloud.phone || String(cloud.id)
  return {
    userId: cloud.id,
    userName: account,
    realName: cloud.displayName || account,
    systemCode: 'wongoing-cloud',
    roleId: 1,
    factoryId: 1,
    deptId: 1,
    workshopId: 1,
  }
}

function mapCloudUserToAccountInfo(cloud: CloudUser): AccountInfo {
  return {
    userId: String(cloud.id),
    email: cloud.email,
    phone: cloud.phone,
    displayName: cloud.displayName,
    createdAt: new Date().toISOString(),
  }
}

function setCloudTokens(tokens: CloudTokenResponse): void {
  // 切到 cloud 身份前清理 stale MES 透传信息，避免 cloud 模式下误发 MES header
  clearMesLocalState()
  localStorage.setItem('wonclaw_cloud_access_token', tokens.accessToken)
  localStorage.setItem('wonclaw_cloud_refresh_token', tokens.refreshToken)
  localStorage.setItem('wonclaw_cloud_user_id', String(tokens.user.id))
  // Online 模式下 fetchApi 通过 wonclaw_token 附加 Authorization，需同步写入
  localStorage.setItem('wonclaw_token', tokens.accessToken)
  localStorage.setItem('wonclaw_user_id', String(tokens.user.id))
}

function clearCloudTokens(): void {
  localStorage.removeItem('wonclaw_cloud_access_token')
  localStorage.removeItem('wonclaw_cloud_refresh_token')
  localStorage.removeItem('wonclaw_cloud_user_id')
  localStorage.removeItem('wonclaw_token')
  localStorage.removeItem('wonclaw_user_id')
  clearMesLocalState()
}

function mapWebsiteUserToUserInfo(user: WebsiteUser): UserInfo {
  const account = user.account || ''
  return {
    userId: 0,
    userName: account,
    realName: account,
    systemCode: 'wongoing-website',
    roleId: 1,
    factoryId: 1,
    deptId: 1,
    workshopId: 1,
  }
}

function mapWebsiteUserToAccountInfo(user: WebsiteUser): WebsiteAccountInfo {
  return {
    email: user.channel === 'email' ? user.account : undefined,
    phone: user.channel === 'phone' ? user.account : undefined,
    plan: user.plan,
    channel: user.channel,
  }
}

function setWebsiteToken(token: string): void {
  localStorage.setItem('wonclaw_token', token)
  localStorage.setItem('wonclaw_website_token', token)
}

/** 清理 MES 透传身份信息，防止 website/cloud/本地模式下 stale header 触发后端连内网 SQL。 */
function clearMesLocalState(): void {
  localStorage.removeItem('wonclaw_user_id')
  localStorage.removeItem('wonclaw_user_name')
  localStorage.removeItem('wonclaw_real_name')
  localStorage.removeItem('wonclaw_role_id')
  localStorage.removeItem('wonclaw_factory_id')
  localStorage.removeItem('wonclaw_dept_id')
  localStorage.removeItem('wonclaw_workshop_id')
  localStorage.removeItem('wonclaw_system_code')
}

function clearWebsiteToken(): void {
  localStorage.removeItem('wonclaw_token')
  localStorage.removeItem('wonclaw_website_token')
  clearMesLocalState()
}

function restoreWebsiteToken(): void {
  const websiteToken = localStorage.getItem('wonclaw_website_token')
  if (websiteToken) {
    localStorage.setItem('wonclaw_token', websiteToken)
  } else {
    localStorage.removeItem('wonclaw_token')
  }
}

/**
 * 判断 token 是否为 MES JWT（与 Website token 区分）。
 * Website token 由 website 签发，payload 中不会有 AIGateway/MESUser；
 * MES JWT 由 AIGateway 签发，iss='AIGateway'，aud='MESUser'。
 */
export function isMesToken(token: string): boolean {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return false
    const payload = JSON.parse(atob(parts[1]))
    return payload?.iss === 'AIGateway' && payload?.aud === 'MESUser'
  } catch {
    return false
  }
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      mesUser: null,
      token: null,
      isLoggedIn: false,
      isMesLoggedIn: false,
      isLoading: false,
      error: null,
      cloudAccount: null,
      cloudAccessToken: null,
      cloudRefreshToken: null,
      isCloudLoggedIn: false,
      websiteAccount: null,
      isWebsiteLoggedIn: false,

      login: async (workBarcode, password, systemCode = 'ykhm') => {
        set({ isLoading: true, error: null })
        try {
          const response = await authApi.login({
            workBarcode,
            password,
            systemCode,
          })

          if (response.success && response.token && response.user) {
            localStorage.setItem('wonclaw_token', response.token)
            localStorage.setItem('wonclaw_user_id', String(response.user.userId))
            localStorage.setItem('wonclaw_user_name', response.user.userName)
            localStorage.setItem('wonclaw_real_name', response.user.realName)
            if (response.user.roleId) localStorage.setItem('wonclaw_role_id', String(response.user.roleId))
            if (response.user.factoryId) localStorage.setItem('wonclaw_factory_id', String(response.user.factoryId))
            if (response.user.deptId) localStorage.setItem('wonclaw_dept_id', String(response.user.deptId))
            if (response.user.workshopId) localStorage.setItem('wonclaw_workshop_id', String(response.user.workshopId))
            localStorage.setItem('wonclaw_system_code', response.user.systemCode)

            const local = isLocalUser(response.user)
            set({
              user: response.user,
              mesUser: local ? null : response.user,
              token: response.token,
              isLoggedIn: true,
              isMesLoggedIn: !local,
              isLoading: false,
            })
            // 在线模式登录后刷新页面，以重新加载对应该 systemCode 的快捷指令与历史对话
            if (!local) {
              window.location.reload()
            }
            return true
          } else {
            set({
              error: getErrorMessage(
                { code: response.errorCode, message: response.error },
                response.error || '登录失败'
              ),
              isLoading: false,
            })
            return false
          }
        } catch (err) {
          set({
            error: getErrorMessage(err, '登录异常'),
            isLoading: false,
          })
          return false
        }
      },

      logout: async () => {
        const state = get()

        // 公网版：已登 MES 时退出 MES，回到 website local 模式，而不是退出 website
        if (state.isWebsiteLoggedIn && state.isMesLoggedIn) {
          try {
            await authApi.logout()
          } catch {
            // ignore
          }
          // 清除 MES 透传身份信息，避免回到 website 模式后仍误带 MES header
          clearMesLocalState()
          // 恢复 website token 为活跃 token，应用重启后会自动恢复 website 会话
          restoreWebsiteToken()
          window.location.reload()
          return
        }

        if (state.isWebsiteLoggedIn) {
          await get().websiteLogout()
          return
        }
        if (isOnline || state.isCloudLoggedIn) {
          await get().cloudLogout()
          return
        }
        try {
          await authApi.logout()
        } catch {
          // ignore
        }
        // 退出 MES 登录后恢复到本地用户模式
        get().restoreLocalUser()
        // 刷新页面以重新加载本地模式的快捷指令与历史对话
        window.location.reload()
      },

      fetchUser: async () => {
        // 公网版（external：isOnline 构建目标 + website provider）的 MES 会话恢复
        // 必须走 MES 后端的 getCurrentUser，不能被 isOnline 短路到 Wongoing cloud——
        // 否则 MES 登录后的刷新会恢复失败，连带清掉 website 会话（双登录死循环）。
        const rc = useRuntimeConfigStore.getState().config
        const websiteMode = rc.requireLogin && rc.provider === 'website'
        if (isOnline && !websiteMode) {
          await get().restoreCloudSession()
          return
        }
        try {
          const user = await authApi.getCurrentUser()
          const local = isLocalUser(user)
          // 双登录共存：只更新 MES 身份字段，不动 websiteAccount/isWebsiteLoggedIn
          set({
            user,
            mesUser: local ? null : user,
            isLoggedIn: true,
            isMesLoggedIn: !local,
          })
        } catch {
          // MES 会话失效：清 MES 身份，website 会话（若存在）保持登录态
          const keepWebsite = websiteMode && get().isWebsiteLoggedIn
          set({
            user: keepWebsite ? get().user : null,
            mesUser: null,
            isLoggedIn: keepWebsite,
            isMesLoggedIn: false,
          })
        }
      },

      restoreLocalUser: () => {
        // Online 模式不允许恢复到本地用户，必须登录 Wongoing 账号
        if (isOnline) {
          set({
            user: null,
            mesUser: null,
            token: null,
            isLoggedIn: false,
            isMesLoggedIn: false,
          })
          return
        }
        const localUser: UserInfo = {
          userId: 1,
          userName: 'localuser',
          realName: '本地用户',
          systemCode: IS_STANDALONE ? 'standalone' : 'local',
          roleId: 1,
          factoryId: 1,
          deptId: 1,
          workshopId: 1,
        }
        // 清除所有 MES 透传身份信息，让后端 middleware 回退到本地用户
        localStorage.removeItem('wonclaw_token')
        clearMesLocalState()
        localStorage.setItem('wonclaw_system_code', localUser.systemCode)
        set({ user: localUser, mesUser: null, token: null, isLoggedIn: true, isMesLoggedIn: false })
      },

      setUser: (user) => {
        const local = isLocalUser(user)
        set({ user, mesUser: local ? null : user, isLoggedIn: true, isMesLoggedIn: !local })
      },

      clearError: () => set({ error: null }),

      // 2026-07-24 死链警告：cloudLogin/cloudRegister 走 /api/cloud/auth/*，
      // 该契约本地 daemon（CloudProxyController 只代理 plan/quota/tokenhub/license）
      // 与公网服务器均未实现，调用必 404。LoginModal 已移除调用入口；
      // 在线登录请用 websiteLogin（/api/auth/website/*）。本函数仅为兼容历史
      // persisted 会话（isCloudLoggedIn/cloudAccount 展示、licenseApi 判断）保留，
      // 不要再接回 UI。
      cloudLogin: async (account, password) => {
        set({ isLoading: true, error: null })
        try {
          const tokens = await cloudApi.login({ account, password })
          setCloudTokens(tokens)
          const userInfo = mapCloudUserToUserInfo(tokens.user)
          const accountInfo = mapCloudUserToAccountInfo(tokens.user)
          set({
            user: userInfo,
            mesUser: null,
            token: tokens.accessToken,
            isLoggedIn: true,
            isMesLoggedIn: false,
            cloudAccount: accountInfo,
            cloudAccessToken: tokens.accessToken,
            cloudRefreshToken: tokens.refreshToken,
            isCloudLoggedIn: true,
            isLoading: false,
          })
          return true
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : '云端登录异常',
            isLoading: false,
          })
          return false
        }
      },

      cloudRegister: async (account, password, displayName) => {
        set({ isLoading: true, error: null })
        try {
          const { userId } = await cloudApi.register({ account, password, displayName })
          if (!userId) {
            set({ error: '注册失败', isLoading: false })
            return false
          }
          // 注册成功后直接登录
          return get().cloudLogin(account, password)
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : '注册异常',
            isLoading: false,
          })
          return false
        }
      },

      cloudLogout: async () => {
        clearCloudTokens()
        set({
          user: null,
          mesUser: null,
          token: null,
          isLoggedIn: false,
          isMesLoggedIn: false,
          cloudAccount: null,
          cloudAccessToken: null,
          cloudRefreshToken: null,
          isCloudLoggedIn: false,
        })
        // Online 模式下退出后需要重新登录，刷新页面清空状态
        if (isOnline) {
          window.location.reload()
        }
      },

      restoreCloudSession: async () => {
        const accessToken = localStorage.getItem('wonclaw_cloud_access_token')
        const refreshToken = localStorage.getItem('wonclaw_cloud_refresh_token')
        if (!accessToken || !refreshToken) {
          set({ isCloudLoggedIn: false, isLoggedIn: false })
          return false
        }
        try {
          const tokens = await cloudApi.refresh(refreshToken)
          setCloudTokens(tokens)
          const userInfo = mapCloudUserToUserInfo(tokens.user)
          const accountInfo = mapCloudUserToAccountInfo(tokens.user)
          set({
            user: userInfo,
            mesUser: null,
            token: tokens.accessToken,
            isLoggedIn: true,
            isMesLoggedIn: false,
            cloudAccount: accountInfo,
            cloudAccessToken: tokens.accessToken,
            cloudRefreshToken: tokens.refreshToken,
            isCloudLoggedIn: true,
          })
          return true
        } catch {
          clearCloudTokens()
          set({
            user: null,
            mesUser: null,
            token: null,
            isLoggedIn: false,
            isMesLoggedIn: false,
            cloudAccount: null,
            cloudAccessToken: null,
            cloudRefreshToken: null,
            isCloudLoggedIn: false,
          })
          return false
        }
      },

      websiteLogin: async (account, password) => {
        set({ isLoading: true, error: null })
        try {
          const res = await websiteAuthApi.login({ account, password })
          if (!res.ok || !res.token || !res.user) {
            set({ error: res.error || '登录失败', isLoading: false })
            return false
          }
          setWebsiteToken(res.token)
          // 切到 website 身份后清理 stale MES 状态，避免后续请求误带 MES header
          clearMesLocalState()
          const userInfo = mapWebsiteUserToUserInfo(res.user)
          const accountInfo = mapWebsiteUserToAccountInfo(res.user)
          set({
            user: userInfo,
            mesUser: null,
            token: res.token,
            isLoggedIn: true,
            isMesLoggedIn: false,
            websiteAccount: accountInfo,
            isWebsiteLoggedIn: true,
            isLoading: false,
          })
          return true
        } catch (err) {
          set({ error: getErrorMessage(err, '登录异常'), isLoading: false })
          return false
        }
      },

      websiteRegister: async (account, password, code) => {
        set({ isLoading: true, error: null })
        try {
          const res = await websiteAuthApi.register({
            channel: 'email',
            target: account,
            code,
            password,
          })
          if (!res.ok || !res.token || !res.user) {
            set({ error: res.error || '注册失败', isLoading: false })
            return false
          }
          setWebsiteToken(res.token)
          // 新 website 账号同样清理 stale MES 状态
          clearMesLocalState()
          const userInfo = mapWebsiteUserToUserInfo(res.user)
          const accountInfo = mapWebsiteUserToAccountInfo(res.user)
          set({
            user: userInfo,
            mesUser: null,
            token: res.token,
            isLoggedIn: true,
            isMesLoggedIn: false,
            websiteAccount: accountInfo,
            isWebsiteLoggedIn: true,
            isLoading: false,
          })
          return true
        } catch (err) {
          set({ error: getErrorMessage(err, '注册异常'), isLoading: false })
          return false
        }
      },

      websiteSendCode: async (account, purpose = 'register') => {
        try {
          const res = await websiteAuthApi.sendCode({
            channel: 'email',
            target: account,
            purpose,
          })
          if (!res.ok) {
            return { ok: false, error: res.error || '发送失败' }
          }
          return { ok: true }
        } catch (err) {
          return { ok: false, error: getErrorMessage(err, '发送验证码异常') }
        }
      },

      websiteLogout: async () => {
        try {
          await websiteAuthApi.logout()
        } catch {
          // ignore
        }
        clearWebsiteToken()
        useTokenHubStore.getState().clear()
        set({
          user: null,
          mesUser: null,
          token: null,
          isLoggedIn: false,
          isMesLoggedIn: false,
          websiteAccount: null,
          isWebsiteLoggedIn: false,
        })
        window.location.reload()
      },

      restoreWebsiteSession: async () => {
        const token = localStorage.getItem('wonclaw_token')
        if (!token) {
          set({ isWebsiteLoggedIn: false, isLoggedIn: false })
          return false
        }
        try {
          const res = await websiteAuthApi.me()
          if (!res.ok || !res.user) {
            clearWebsiteToken()
            useTokenHubStore.getState().clear()
            clearMesLocalState()
            set({
              user: null,
              mesUser: null,
              token: null,
              isLoggedIn: false,
              isMesLoggedIn: false,
              websiteAccount: null,
              isWebsiteLoggedIn: false,
            })
            return false
          }
          // website 会话有效，确保没有 stale MES header
          clearMesLocalState()
          const userInfo = mapWebsiteUserToUserInfo(res.user)
          const accountInfo = mapWebsiteUserToAccountInfo(res.user)
          set({
            user: userInfo,
            mesUser: null,
            token,
            isLoggedIn: true,
            isMesLoggedIn: false,
            websiteAccount: accountInfo,
            isWebsiteLoggedIn: true,
          })
          return true
        } catch {
          clearWebsiteToken()
          useTokenHubStore.getState().clear()
          clearMesLocalState()
          set({
            user: null,
            mesUser: null,
            token: null,
            isLoggedIn: false,
            isMesLoggedIn: false,
            websiteAccount: null,
            isWebsiteLoggedIn: false,
          })
          return false
        }
      },
    }),
    {
      name: 'wonclaw-auth',
      partialize: (state) => ({
        user: state.user,
        mesUser: state.mesUser,
        token: state.token,
        isLoggedIn: state.isLoggedIn,
        isMesLoggedIn: state.isMesLoggedIn,
        cloudAccount: state.cloudAccount,
        cloudAccessToken: state.cloudAccessToken,
        cloudRefreshToken: state.cloudRefreshToken,
        isCloudLoggedIn: state.isCloudLoggedIn,
        websiteAccount: state.websiteAccount,
        isWebsiteLoggedIn: state.isWebsiteLoggedIn,
      }),
    }
  )
)
