/**
 * 文件级记忆类型（2026-09-03 下限工程：对齐 claude-code memdir，全量降级）。
 *
 * 旧的 MemoryEntry（11 类型/5 优先级/4 层/embedding/tags/三元组）已废弃——
 * 那是"记忆之野"复杂设计的遗产，实际使用率极低。对齐 cc 后只保留四类型。
 *
 * 记忆 = ~/.wonwork/memory/ 下的 .md 文件：
 *   MEMORY.md          ← 索引（一行一条，200行/25KB 上限）
 *   <topic>.md         ← 每条记忆一个文件，frontmatter: name/description/type
 *
 * 模型用文件原语（read_file/write_file/str_replace/grep）直接管这些文件，
 * 不再经过 memory_write/memory_read 工具（已退役）。
 */

/** 记忆类型（对齐 cc MEMORY_TYPES 封闭枚举） */
export type MemoryFileType = 'user' | 'feedback' | 'project' | 'reference'
export const MEMORY_FILE_TYPES: MemoryFileType[] = ['user', 'feedback', 'project', 'reference']

export const MEMORY_TYPE_LABELS: Record<MemoryFileType, string> = {
  user: '用户',
  feedback: '反馈',
  project: '项目',
  reference: '参考',
}

/** 记忆文件条目（扫描结果，对齐后端 MemoryFileEntry） */
export interface MemoryFileEntry {
  /** 相对 memory/ 根的路径（如 "user-preference.md" 或 "project/wonwork-floor.md"） */
  relativePath: string
  name: string
  description: string
  type: string
  content: string
  lastModified: string
}

/** 生成记忆文件名（kebab-case，从内容提炼）；纯符号名提炼不出字符时兜底 note.md */
export function memoryFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  return (slug || 'note') + '.md'
}

/** 构建记忆文件的完整内容（frontmatter + 正文）；type 缺省时写无类型的速记（前端"记一笔"场景）。
 *  name/description 压成单行——多行值会把 frontmatter 与索引行断成两行 */
export function buildMemoryFileContent(
  name: string,
  description: string,
  type: MemoryFileType | undefined,
  content: string
): string {
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
  const typeLine = type ? `type: ${type}\n` : ''
  return `---\nname: ${oneLine(name)}\ndescription: ${oneLine(description)}\n${typeLine}---\n\n${content}\n`
}
