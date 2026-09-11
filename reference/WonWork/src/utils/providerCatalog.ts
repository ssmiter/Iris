export interface ProviderCatalogItem {
  provider: string
  model: string
  baseUrl?: string
  isEnabled?: boolean
}

/**
 * 后端配置优先，同时补齐前端内置但尚未写入本机数据库的 Provider。
 * 一个 Provider 在菜单中只出现一次；后端保存的模型和地址始终覆盖内置默认值。
 */
export function mergeProviderCatalog<T extends ProviderCatalogItem>(
  backend: T[],
  builtIn: T[]
): T[] {
  const merged = [...backend]
  const existingProviders = new Set(backend.map((item) => item.provider))

  for (const item of builtIn) {
    if (!item.model || existingProviders.has(item.provider)) continue
    merged.push(item)
    existingProviders.add(item.provider)
  }

  return merged
}
