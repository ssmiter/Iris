import type { MemoryFileType } from '@/types/memoryFile'

/**
 * 记忆文件类型 → UI 徽章/文案键（2026-09-03 文件化后替代 memCategory 四桶）。
 * 无类型（''）= 速记笔记（/remember、管理页"记一笔"的产物）。
 */

export const MEMORY_FILE_TYPE_VALUES: MemoryFileType[] = ['user', 'feedback', 'project', 'reference']

/** 类型徽章样式（wf-badge 家族，与 stream/tree/manager 三视图共用） */
export const FILE_TYPE_BADGE: Record<string, string> = {
  user: 'wf-badge-info',
  feedback: 'wf-badge-warn',
  project: 'wf-badge-ok',
  reference: 'wf-badge-mut',
  '': 'wf-badge-mut',
}

/** 类型文案 i18n 键 */
export function fileTypeLabelKey(type: string): string {
  return type ? `memory.fileTypes.${type}` : 'memory.fileTypes.note'
}
