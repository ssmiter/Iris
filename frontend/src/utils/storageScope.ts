/**
 * Iris 存储命名（原 WonWork 多作用域 storageScope 收敛为本地单一作用域，2026-09）。
 *
 * WonWork 按运行时模式（standalone / mescli-local / mescli-online / website-online）
 * 划分 IndexedDB / localStorage 作用域以防同域覆盖；Iris 无登录体系、恒为本地模式，
 * 作用域收敛为单一。IndexedDB 库名沿用历史值 'wonwork-mescli'，保证存量
 * 浏览器数据（视图状态、workspace 缓存等）可继续读取，不做迁移。
 */

/** IndexedDB 数据库名（历史沿用，勿改——改了等于丢弃存量本地数据） */
export function getIndexedDBName(): string {
  return 'wonwork-mescli'
}
