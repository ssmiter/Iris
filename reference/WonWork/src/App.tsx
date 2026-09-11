import { useEffect, useState } from 'react'
import { MainLayout } from '@/components/Layout'
import { UpdateAvailableModal } from '@/components/Update/UpdateAvailableModal'
import { UpdateNotificationBanner } from '@/components/Update/UpdateNotificationBanner'
import { LoginModal } from '@/components/Layout/LoginModal'
import { Toast } from '@/components/common/Toast'
import { useAuthStore, isMesToken } from '@/stores/authStore'
import { useRuntimeConfigStore } from '@/stores/runtimeConfigStore'
import { useCronSchedulerStore, scheduleNextWake } from '@/stores/cronSchedulerStore'
import { useSkillStore } from '@/stores/skillStore'
import { useWorkflowStore } from '@/stores/workflowStore'
import { useQuotaStore } from '@/stores/quotaStore'
import { useLicenseStore } from '@/stores/licenseStore'
import { useUpdateStore } from '@/stores/updateStore'
import { usePermissionStore } from '@/stores/permissionStore'
import { useWebBridgeStore } from '@/stores/webbridgeStore'
import { isOnline, supportsLicenseActivation, supportsTokenPlan } from '@/config/product'
import { shouldValidateMesSessionOnStartup } from '@/utils/authSessionRecovery'
import { useMescliPackageStore } from '@/stores/mescliPackageStore'
import { initTheme } from '@/utils/theme'

const IS_STANDALONE = import.meta.env.VITE_STANDALONE_MODE === 'true'

function App() {
  const { isLoggedIn, isMesLoggedIn, isWebsiteLoggedIn, fetchUser, restoreLocalUser, restoreWebsiteSession } = useAuthStore()
  const { config: runtimeConfig, load: loadRuntimeConfig, loaded: runtimeConfigLoaded } = useRuntimeConfigStore()
  const { loadPermissions } = usePermissionStore()
  const { checkVersion } = useUpdateStore()
  const [authReady, setAuthReady] = useState(false)

  // 应用启动时加载运行时配置（是否强制 website 登录）
  useEffect(() => {
    loadRuntimeConfig()
  }, [loadRuntimeConfig])

  // 应用启动时初始化主题（读取持久化主题并监听系统切换）
  useEffect(() => {
    initTheme()
  }, [])

  // 应用启动时即加载 Skill 列表，确保对话能使用关键词触发和模板选择
  useEffect(() => {
    useSkillStore.getState().init()
    useWorkflowStore.getState().init()
  }, [])

  // Launcher 已启动内部浏览器运行服务；前端通过 AIGateway 获取短期会话后静默连接。
  useEffect(() => {
    if (!runtimeConfigLoaded) return
    if ((isOnline || runtimeConfig.requireLogin) && !isLoggedIn) return
    useWebBridgeStore.getState().tryAutoConnect(true).catch(() => undefined)
  }, [isLoggedIn, runtimeConfig.requireLogin, runtimeConfigLoaded])

  // 应用启动时加载当前用户权限
  useEffect(() => {
    loadPermissions()
  }, [loadPermissions])

  useEffect(() => {
    // 等待运行时配置就绪
    if (!runtimeConfigLoaded) return

    // 公网版（External）强制 website 账号登录：优先恢复已有会话
    if (runtimeConfig.requireLogin && runtimeConfig.provider === 'website') {
      const activeToken = localStorage.getItem('wonclaw_token')
      // 如果当前活跃 token 已经是 MES JWT，说明用户此前已升级到 online，优先恢复 MES 会话
      if (activeToken && isMesToken(activeToken)) {
        fetchUser()
          .catch(() => restoreWebsiteSession())
          .finally(() => setAuthReady(true))
      } else {
        restoreWebsiteSession().finally(() => setAuthReady(true))
      }
      return
    }

    // Online 模式下必须登录 Wongoing 云端账号
    if (isOnline) {
      fetchUser().finally(() => setAuthReady(true))
      return
    }
    // Standalone 模式下恢复本地用户（本地用户为默认模式）
    if (IS_STANDALONE && !isLoggedIn) {
      restoreLocalUser()
    }
    // MESCLI 模式下只校验已持久化的 MES 身份，或在完全未登录时恢复会话。
    // 本地用户没有远端 MES 会话，不能因一次 401 被误替换；过期的 MES JWT
    // 必须重新校验，否则页面会继续显示缓存身份但所有受保护请求都返回 401。
    else if (
      shouldValidateMesSessionOnStartup({
        isOnline,
        websiteMode: runtimeConfig.requireLogin && runtimeConfig.provider === 'website',
        isLoggedIn,
        isMesLoggedIn,
      })
    ) {
      fetchUser()
    }
    setAuthReady(true)
  }, [fetchUser, isLoggedIn, isMesLoggedIn, restoreLocalUser, restoreWebsiteSession, runtimeConfigLoaded, runtimeConfig.provider, runtimeConfig.requireLogin])

  // License / Quota —— 仅登录后初始化，避免未登录时 401 报错
  useEffect(() => {
    if (!isLoggedIn) return
    if (supportsLicenseActivation || supportsTokenPlan) {
      useLicenseStore.getState().initialize()
      useQuotaStore.getState().refresh()
    }
  }, [isLoggedIn])

  // 定时任务唤醒（2026-08-05 事件驱动，替代固定轮询）：
  // 主机制=scheduleNextWake 精确到点定时器（store 内，任务变更自动重排）；
  // 这里只做三件事：启动时从后端同步权威清单（loadTasks 内部 arm 首次唤醒）；
  // 后台标签节流/系统睡眠的补查事件（focus/visibilitychange）；
  // 5 分钟低频保险丝（不空转，纯兜底漏网）。
  useEffect(() => {
    void useCronSchedulerStore.getState().loadTasks()
    const recheck = () => {
      void useCronSchedulerStore
        .getState()
        .checkAndRunDueTasks()
        .finally(() => scheduleNextWake())
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') recheck()
    }
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', onVisibility)
    const backstop = setInterval(recheck, 5 * 60 * 1000)
    return () => {
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', onVisibility)
      clearInterval(backstop)
    }
  }, [])

  // 版本更新检查 —— 启动时及每 30 分钟检查一次
  useEffect(() => {
    checkVersion()
    void useMescliPackageStore.getState().checkUpdates()
    const interval = setInterval(() => {
      checkVersion()
      void useMescliPackageStore.getState().checkUpdates()
    }, 30 * 60 * 1000)
    return () => clearInterval(interval)
  }, [checkVersion])

  const requireLoginModal =
    authReady &&
    !isLoggedIn &&
    (isOnline || (runtimeConfig.requireLogin && runtimeConfig.provider === 'website'))

  return (
    <>
      <MainLayout />
      <UpdateAvailableModal />
      <UpdateNotificationBanner />
      <LoginModal isOpen={requireLoginModal} onClose={() => {}} />
      <Toast />
    </>
  )
}

export default App
