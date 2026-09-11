/**
 * SKILL 数据模型 v2（2026-08-08 重设计；2026-09-03 文件化）
 *
 * 设计来源：claude-code SKILL 渐进披露（元数据清单常驻 → 按需读 SKILL.md 正文 → 附属文件按需读）。
 * 技能就是 ~/.wonwork/skills/<id>/SKILL.md 真实文件（2026-09-03 起）：/skills 虚拟目录与
 * read_skill/create_skill 工具已退役，模型用文件原语直读直写。
 *
 * v1 的 trigger（always/keyword/manual）整体退役：
 * - always  → 元数据清单每轮常驻（层级 1，由 systemPromptBuilder 注入）
 * - keyword → 模型读 whenToUse 自主判断（比字符串包含匹配聪明）
 * - manual  → 文件原语按需读（层级 2）
 */

export interface SkillManifest {
  id: string
  name: string
  /** 一句话用途（写给人也写给模型，≤80 字为宜） */
  description: string
  /** 模型匹配主依据（CRITICAL）：以「当…时使用」风格写触发场景与用户原话示例 */
  whenToUse: string
  /** 功能域（office / industrial / general / 自定义）：管理页分组 */
  domain: string
  /** grep 检索助推词 */
  keywords: string[]
  /** 内容版本：改内置 SKILL 必须 bump（驱动内置同步覆盖更新） */
  version: string
  author: string
  /** lucide 图标名（管理页卡片用） */
  icon: string
  /** 技能正文（markdown 主体，SKILL.md frontmatter 之后的全文） */
  prompt: string
  /** 启停：false 时从元数据清单中消失（唯一事实来源即此字段） */
  enabled: boolean
  /** 是否出现在对话框 / 斜杠菜单（默认 true）；模型读文件不受此限 */
  userInvocable: boolean
  installedAt: string
  updatedAt: string
  /** built-in=内置（三件套+域知识包） / local=用户手建或模型沉淀（文件原语直写，默认落此值） / imported=导入 / agent=历史遗留值（create_skill 时代产物，现无写入方，仅为兼容旧文件保留在枚举里） */
  source: 'built-in' | 'local' | 'imported' | 'agent'
}

export interface SkillPackage {
  manifest: SkillManifest
  schemaVersion: '2.0'
}

/** 技能用量统计（运行态，持久化在前端本地，不进 SKILL.md frontmatter） */
export interface SkillUsageStat {
  count: number
  lastUsedAt: string
}
