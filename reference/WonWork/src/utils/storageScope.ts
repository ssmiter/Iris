import { IS_STANDALONE, isOnline } from '@/config/product'

/**
 * WonWork 存储作用域
 *
 * Standalone 与 MESCLI-Local 可能运行在同一域名下（如 localhost）。
 * 为避免 IndexedDB / localStorage 数据互相覆盖，按运行时模式划分作用域。
 *
 * 注意：
 * - MESCLI-Online 的会话、历史等业务数据存在后端，不依赖前端 IndexedDB。
 * - Auth key（wonclaw_token 等）仍共用，保证 fetchApi 正常工作。
 *
 * 实现上直接从 localStorage + 编译时标志推导，避免导入 runtimeMode/authStore
 * 造成循环依赖（storageScope -> runtimeMode -> authStore -> tokenHubStore -> storageScope），
 * 该循环在模块初始化时可能触发 TDZ/undefined 导致白屏。
 */

export type StorageScope = 'standalone' | 'mescli-local' | 'mescli-online' | 'website-online'

/**
 * 获取当前存储作用域
 */
export function getStorageScope(): StorageScope {
  if (IS_STANDALONE) {
    return 'standalone'
  }

  // Online 构建且已登录官网账号 → website-online 独立作用域
  const websiteToken = localStorage.getItem('wonclaw_website_token')
  if (isOnline && websiteToken) {
    return 'website-online'
  }

  // 通过 localStorage 中的 systemCode 区分 mescli-online 与 mescli-local，
  // 不依赖 authStore，避免循环导入。
  const systemCode = localStorage.getItem('wonclaw_system_code')?.toLowerCase() || ''
  if (systemCode && systemCode !== 'local' && systemCode !== 'standalone') {
    return 'mescli-online'
  }

  return 'mescli-local'
}

/**
 * 获取当前模式对应的 IndexedDB 数据库名
 *
 * 设计原则：
 * - Standalone 与 MESCLI / Website-Online 必须隔离，避免独立预览版与本机其他模式共用数据。
 * - MESCLI 内部不再按 local/online 拆分数据库。local 与 online 只是能力状态
 *   （能否访问 MES 业务数据），不是数据分区键。拆分会导致用户切换 online 后
 *   历史会话、配置全部"消失"。
 * - Website-Online（官网账号体系）使用独立数据库，避免与 MESCLI 数据混用。
 */
export function getIndexedDBName(): string {
  const scope = getStorageScope()
  if (scope === 'mescli-local' || scope === 'mescli-online') {
    return 'wonwork-mescli'
  }
  if (scope === 'website-online') {
    return 'wonwork-website-online'
  }
  return 'wonclaw-standalone'
}

/**
 * 获取当前模式对应的 localStorage key 前缀
 * @param key 不含前缀的业务 key，例如 'standalone_config'
 */
export function getLocalStorageKey(key: string): string {
  const scope = getStorageScope()
  if (scope === 'mescli-local' || scope === 'mescli-online') {
    return `wonwork_mescli_${key}`
  }
  if (scope === 'website-online') {
    return `wonwork_website_${key}`
  }
  return `wonclaw_${key}`
}
