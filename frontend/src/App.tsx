import { useEffect } from 'react'
import { MainLayout } from '@/components/layout'
import { Toast } from '@/components/common/Toast'
import { initTheme } from '@/utils/theme'
import { useAuthStore } from '@/stores/authStore'

/**
 * Iris 的启动壳只装载本地产品界面。WonWork 的账户、套餐、License、更新器和
 * 企业登录均不属于 Agent 前端内核，不能在应用启动时形成隐式前置条件。
 *
 * 【Iris 2026-09】身份收敛：启动即固定本地身份（authStore 初始值已是本地用户，
 * 此处 initLocalIdentity 幂等核对，顺带覆盖任何历史 persisted 脏身份）。
 */
function App() {
  useEffect(() => {
    useAuthStore.getState().initLocalIdentity()
    initTheme()
  }, [])

  return (
    <>
      <MainLayout />
      <Toast />
    </>
  )
}

export default App
