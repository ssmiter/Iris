/**
 * 插件架构类型
 *
 * 参考 E:\code\WonWork\learn\05\plugin\plugin-overview.md
 */

// ==================== 插件清单 ====================

export interface PluginManifest {
  id: string
  name: string
  version: string
  description: string
  author: string
  /** 入口 JS 文件路径（相对于插件根目录） */
  entry: string
  /** 所需权限列表 */
  permissions?: string[]
  /** 最小引擎版本 */
  minEngineVersion?: string
  /** 图标 URL */
  iconUrl?: string
  /** 主页 URL */
  homepageUrl?: string
  /** 配置 schema（JSON Schema） */
  configSchema?: Record<string, unknown>
  /** 功能清单 */
  capabilities?: string[]
}

// ==================== 已安装插件 ====================

export interface InstalledPlugin {
  manifest: PluginManifest
  /** 安装路径 */
  installPath: string
  /** 是否启用 */
  enabled: boolean
  /** 用户自定义配置 */
  config?: Record<string, unknown>
  installedAt: string
  updatedAt: string
}

// ==================== 校验结果 ====================

export interface PluginValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}
