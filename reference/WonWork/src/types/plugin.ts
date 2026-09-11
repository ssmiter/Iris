/**
 * 插件化架构类型定义（MVP）
 * 插件包格式：ZIP + manifest.json
 */

export type PluginContributionType = 'skill' | 'webbridge_action'

export interface PluginContribution {
  type: PluginContributionType
  id: string
  name: string
  description?: string
  // 类型相关的元数据
  metadata?: Record<string, unknown>
}

export interface PluginManifest {
  /** 插件唯一标识 */
  id: string
  /** 插件名称 */
  name: string
  /** 版本号，遵循 semver */
  version: string
  /** 插件描述 */
  description?: string
  /** 作者 */
  author?: string
  /** 兼容的 WonWork 核心版本范围 */
  targetCoreVersion?: string
  /** 依赖的其他插件 */
  dependencies?: Record<string, string>
  /** 插件贡献的能力清单 */
  contributions?: PluginContribution[]
  /** 入口文件（动态加载前端组件时使用） */
  entry?: string
  /** 图标 */
  icon?: string
}

export interface PluginPackage {
  manifest: PluginManifest
  /** ZIP 包原始二进制数据 */
  blob: Blob
}

export interface InstalledPlugin {
  id: string
  manifest: PluginManifest
  isEnabled: boolean
  installedAt: string
  updatedAt: string
  packageHash?: string
}

export interface PluginValidationResult {
  valid: boolean
  errors: string[]
}

export function validateManifest(manifest: Partial<PluginManifest>): PluginValidationResult {
  const errors: string[] = []
  if (!manifest.id) errors.push('缺少插件 ID')
  if (!manifest.name) errors.push('缺少插件名称')
  if (!manifest.version) errors.push('缺少插件版本')
  if (manifest.contributions) {
    const seenIds = new Set<string>()
    for (const c of manifest.contributions) {
      if (!c.id) errors.push('贡献项缺少 ID')
      if (!c.type) errors.push(`贡献项 ${c.id || '?'} 缺少类型`)
      if (c.id && seenIds.has(`${c.type}:${c.id}`)) {
        errors.push(`重复的贡献项：${c.type}:${c.id}`)
      }
      if (c.id) seenIds.add(`${c.type}:${c.id}`)
    }
  }
  return { valid: errors.length === 0, errors }
}
