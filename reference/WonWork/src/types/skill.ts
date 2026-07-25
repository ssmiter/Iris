/**
 * Skill 清单类型
 *
 * 参考 E:\code\WonWork\learn\05\skill\skill-system-overview.md
 */

// ==================== Skill Manifest ====================

export interface SkillManifest {
  id: string
  name: string
  version: string
  description: string
  author?: string
  /** 技能类别标签 */
  tags?: string[]
  /** 技能提示词 */
  prompt: string
  /** 示例对话 */
  examples?: SkillExample[]
  /** 所需工具（工具名列表） */
  requiredTools?: string[]
  /** 所需权限 */
  requiredPermissions?: string[]
  /** 图标 */
  icon?: string
  /** 分类 */
  category?: SkillCategory
  /** 是否激活 */
  enabled?: boolean
  /** 优先级排序 */
  sortOrder?: number
  /** 元数据 */
  metadata?: Record<string, unknown>
}

export type SkillCategory =
  | 'coding'
  | 'writing'
  | 'analysis'
  | 'research'
  | 'creative'
  | 'productivity'
  | 'education'
  | 'utility'
  | 'custom'

export interface SkillExample {
  input: string
  output: string
}

// ==================== Skill Package（导入导出） ====================

export interface SkillPackage {
  manifest: SkillManifest
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
}
