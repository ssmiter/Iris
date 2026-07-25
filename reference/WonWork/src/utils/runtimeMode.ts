import { IS_STANDALONE, isOnline } from '@/config/product'
import { useAuthStore } from '@/stores/authStore'

/**
 * WonWork 运行时模式（与编译时 BUILD_TARGET 正交）
 *
 * 统一构建只产出 Online 安装包，"用户是什么身份"不再由构建决定，
 * 而是安装后由登录状态决定，且可随时切换：
 *   - mescli-local   ：未登录任何账号。本地行为（本地历史/本地工具），
 *                      相当于免费本地版。website 时代之前的 MESCLI Local 用法已淡出，
 *                      但此模式保留，未来脱离 website 的私有部署版仍可能复用。
 *   - website-online ：官网账号登录。tokenhub 订阅付费能力（external 通道主路径）。
 *   - mescli-online  ：左下角"登录 MESCLI Online"完成 MES 认证（需内网/VPN）。
 *                      解锁企业级能力：企业模型 + SQL Server + 业务工具。所有版本保留此入口。
 *   - standalone     ：仅 Standalone 编译（VITE_STANDALONE_MODE=true）才会出现，
 *                      统一构建不再产出，属遗留能力。
 *
 * 注意：IS_STANDALONE 是编译时变量，只能区分 Standalone 构建与 MESCLI 构建。
 * 在 MESCLI 构建中，用户可能是本地用户（未登录 MES），也可能是 MES 认证用户。
 * 在 Online 构建中，用户通过官网账号登录，形成 website-online 模式。
 * 本函数通过读取 authStore 的运行时状态来区分这些情况。
 */
export type RuntimeMode = 'standalone' | 'mescli-local' | 'mescli-online' | 'website-online'

export function getRuntimeMode(): RuntimeMode {
  if (IS_STANDALONE) {
    return 'standalone'
  }

  const { isMesLoggedIn, isWebsiteLoggedIn, user } = useAuthStore.getState()

  // MES 已认证 → MESCLI 在线模式
  if (isMesLoggedIn && user && user.systemCode?.toLowerCase() !== 'local') {
    return 'mescli-online'
  }

  // Online 构建且已登录官网账号 → website-online 模式
  if (isOnline && isWebsiteLoggedIn) {
    return 'website-online'
  }

  // MESCLI 构建，但本地用户或未登录 MES → 本地模式
  return 'mescli-local'
}

/**
 * 判断当前是否可以访问企业 MES 数据
 */
export function canAccessMesData(): boolean {
  return getRuntimeMode() === 'mescli-online'
}

/**
 * 判断当前是否运行在本地（Standalone 或 MESCLI-Local）
 */
export function isLocalRuntime(): boolean {
  const mode = getRuntimeMode()
  return mode === 'standalone' || mode === 'mescli-local'
}

/**
 * 判断当前是否运行在官网 Online 模式
 */
export function isWebsiteOnline(): boolean {
  return getRuntimeMode() === 'website-online'
}
