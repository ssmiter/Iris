import { useEffect, useState } from 'react'
import { MainLayout } from '@/components/Layout'
import { UpdateAvailableModal } from '@/components/Update/UpdateAvailableModal'
import { LoginModal } from '@/components/Layout/LoginModal'
import { Toast } from '@/components/common/Toast'
import { useAuthStore, isMesToken } from '@/stores/authStore'
import { useRuntimeConfigStore } from '@/stores/runtimeConfigStore'
import { useCronSchedulerStore } from '@/stores/cronSchedulerStore'
import { useSkillStore } from '@/stores/skillStore'
import { useQuotaStore } from '@/stores/quotaStore'
import { useLicenseStore } from '@/stores/licenseStore'
import { useUpdateStore } from '@/stores/updateStore'
import { usePermissionStore } from '@/stores/permissionStore'
import { useWebBridgeStore } from '@/stores/webbridgeStore'
import { useDagWorkflowStore } from '@/stores/dagWorkflowStore'
import { isOnline, supportsLicenseActivation, supportsTokenPlan } from '@/config/product'
import { ensureDagExampleWorkflows } from '@/utils/dagWorkflowExamples'

const IS_STANDALONE = import.meta.env.VITE_STANDALONE_MODE === 'true'

function App() {
  const { isLoggedIn, isWebsiteLoggedIn, fetchUser, restoreLocalUser, restoreWebsiteSession } = useAuthStore()
  const { config: runtimeConfig, load: loadRuntimeConfig, loaded: runtimeConfigLoaded } = useRuntimeConfigStore()
  const { loadPermissions } = usePermissionStore()
  const { checkVersion } = useUpdateStore()
  const [authReady, setAuthReady] = useState(false)

  // 应用启动时加载运行时配置（是否强制 website 登录）
  useEffect(() => {
    loadRuntimeConfig()
  }, [loadRuntimeConfig])

  // 应用启动时即加载 Skill 列表，确保对话能使用关键词触发和模板选择
  useEffect(() => {
    useSkillStore.getState().init()
  }, [])

  // 应用启动时播种 WebBridge / DAG 示例工作流，确保安装后首次打开即可见
  useEffect(() => {
    useWebBridgeStore.getState().ensureExampleWorkflows()
    ensureDagExampleWorkflows()
  }, [])

  // 安装包启动后，Launcher 已在后台拉起 WebBridge Daemon；前端启动时静默探测并自动连接
  useEffect(() => {
    useWebBridgeStore.getState().tryAutoConnect(true).catch(() => undefined)
  }, [])

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
    // MESCLI 模式下尝试恢复登录状态：本地模式会直接返回本地用户，在线模式无会话则进入登录
    else if (!isLoggedIn) {
      fetchUser()
    }
    setAuthReady(true)
  }, [fetchUser, isLoggedIn, restoreLocalUser, restoreWebsiteSession, runtimeConfigLoaded, runtimeConfig.provider, runtimeConfig.requireLogin])

  // License / Quota —— 仅登录后初始化，避免未登录时 401 报错
  useEffect(() => {
    if (!isLoggedIn) return
    if (supportsLicenseActivation || supportsTokenPlan) {
      useLicenseStore.getState().initialize()
      useQuotaStore.getState().refresh()
    }
  }, [isLoggedIn])

  // 全局定时任务检查 —— 每 30 秒检查一次到期任务
  useEffect(() => {
    const interval = setInterval(() => {
      useCronSchedulerStore.getState().checkAndRunDueTasks()
    }, 30000)
    return () => clearInterval(interval)
  }, [])

  // 版本更新检查 —— 启动时及每 30 分钟检查一次
  useEffect(() => {
    checkVersion()
    const interval = setInterval(() => {
      checkVersion()
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
      <LoginModal isOpen={requireLoginModal} onClose={() => {}} />
      <Toast />
    </>
  )
}

export default App
