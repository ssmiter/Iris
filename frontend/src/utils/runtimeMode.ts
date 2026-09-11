/**
 * Iris 运行时模式（原 WonWork 四模式收敛为本地个人版单模式）
 *
 * 【Iris 迁移 2026-09】WonWork 的 mescli-local / mescli-online / website-online /
 * standalone 由"用户登录了什么身份"决定；Iris 无登录体系，身份恒为固定本地用户
 * （见 stores/authStore.ts），运行时模式恒为本地。
 *
 * RuntimeMode 联合类型与四个导出函数保留：下游（chatStore / capabilityRegistry
 * 等）按模式分支的调用点不必改动，只是这些分支现在恒走本地一侧。
 */
export type RuntimeMode = 'mescli-local'

export function getRuntimeMode(): RuntimeMode {
  return 'mescli-local'
}

/**
 * 判断当前是否可以访问企业 MES 数据。
 * Iris 无 MES 登录体系，恒 false。
 */
export function canAccessMesData(): boolean {
  return false
}

/**
 * 判断当前是否运行在本地——Iris 只有一种形态，恒 true。
 */
export function isLocalRuntime(): boolean {
  return true
}

/**
 * 判断当前是否运行在官网 Online 模式——Iris 无官网账号体系，恒 false。
 */
export function isWebsiteOnline(): boolean {
  return false
}
