import type { LucideIcon } from 'lucide-react'
import i18n from '@/i18n'
import {
  File,
  FileText,
  FileImage,
  FileCode,
  FileType,
  Sheet,
  Presentation,
} from 'lucide-react'

export interface FileIconInfo {
  icon: LucideIcon
  colorClass: string
  /** 文件类型中文标签，用于 aria-label / tooltip */
  label: string
}

const DEFAULT_ICON: FileIconInfo = { icon: File, colorClass: 'text-[var(--wf-faint)]', label: '文件' }

function normalizeExt(pathOrExt: string): string {
  const ext = pathOrExt.includes('.')
    ? pathOrExt.split('.').pop() ?? ''
    : pathOrExt
  return ext.toLowerCase().trim()
}

const ICON_MAP: Record<string, FileIconInfo> = {
  // Word
  doc: { icon: FileType, colorClass: 'text-blue-600', label: 'Word' },
  docx: { icon: FileType, colorClass: 'text-blue-600', label: 'Word' },

  // Excel / CSV
  xls: { icon: Sheet, colorClass: 'text-green-600', label: 'Excel' },
  xlsx: { icon: Sheet, colorClass: 'text-green-600', label: 'Excel' },
  csv: { icon: Sheet, colorClass: 'text-emerald-600', label: 'CSV' },

  // PPT
  ppt: { icon: Presentation, colorClass: 'text-orange-500', label: 'PPT' },
  pptx: { icon: Presentation, colorClass: 'text-orange-500', label: 'PPT' },

  // PDF
  pdf: { icon: FileText, colorClass: 'text-red-500', label: 'PDF' },

  // 图片
  png: { icon: FileImage, colorClass: 'text-purple-500', label: '图片' },
  jpg: { icon: FileImage, colorClass: 'text-purple-500', label: '图片' },
  jpeg: { icon: FileImage, colorClass: 'text-purple-500', label: '图片' },
  webp: { icon: FileImage, colorClass: 'text-purple-500', label: '图片' },
  gif: { icon: FileImage, colorClass: 'text-purple-500', label: '图片' },
  svg: { icon: FileImage, colorClass: 'text-purple-500', label: 'SVG' },

  // 代码 / 文本
  py: { icon: FileCode, colorClass: 'text-sky-600', label: 'Python' },
  js: { icon: FileCode, colorClass: 'text-yellow-500', label: 'JavaScript' },
  ts: { icon: FileCode, colorClass: 'text-blue-500', label: 'TypeScript' },
  tsx: { icon: FileCode, colorClass: 'text-blue-500', label: 'TSX' },
  jsx: { icon: FileCode, colorClass: 'text-blue-400', label: 'JSX' },
  json: { icon: FileCode, colorClass: 'text-slate-500', label: 'JSON' },
  md: { icon: FileText, colorClass: 'text-slate-600', label: 'Markdown' },
  txt: { icon: FileText, colorClass: 'text-slate-600', label: '文本' },
  log: { icon: FileText, colorClass: 'text-slate-600', label: '日志' },
  yaml: { icon: FileCode, colorClass: 'text-slate-500', label: 'YAML' },
  yml: { icon: FileCode, colorClass: 'text-slate-500', label: 'YAML' },
  sql: { icon: FileCode, colorClass: 'text-indigo-500', label: 'SQL' },
  html: { icon: FileCode, colorClass: 'text-orange-600', label: 'HTML' },
  css: { icon: FileCode, colorClass: 'text-sky-500', label: 'CSS' },
}

/** 中文 label → i18n 键（图标表保持模块级常量，翻译在取用处进行） */
const LABEL_KEYS: Record<string, string> = {
  文件: 'chat.fileIcon.file',
  图片: 'chat.fileIcon.image',
  文本: 'chat.fileIcon.text',
  日志: 'chat.fileIcon.log',
}

export function getFileIconInfo(pathOrExt: string): FileIconInfo {
  const info = ICON_MAP[normalizeExt(pathOrExt)] ?? DEFAULT_ICON
  const key = LABEL_KEYS[info.label]
  return key ? { ...info, label: i18n.t(key) } : info
}

export interface SourceBadgeInfo {
  label: string
  colorClass: string
}

export function getSourceBadge(source?: string): SourceBadgeInfo {
  const s = (source ?? 'unknown').toLowerCase()
  if (s === 'user' || s === 'upload') {
    return { label: i18n.t('chat.fileIcon.srcUser'), colorClass: 'bg-[var(--wf-mono-bg)] text-[var(--wf-sub)]' }
  }
  if (s === 'backend' || s === 'system') {
    return { label: i18n.t('chat.fileIcon.srcBackend'), colorClass: 'wf-badge-info' }
  }
  if (s.startsWith('create_') || s.includes('document') || s.includes('export')) {
    return { label: i18n.t('chat.fileIcon.srcGenerated'), colorClass: 'wf-badge-ok' }
  }
  if (s.startsWith('execute_python')) {
    return { label: 'Python', colorClass: 'wf-badge-info' }
  }
  // 默认把具体工具名作为来源
  return { label: source ?? i18n.t('chat.fileIcon.srcUnknown'), colorClass: 'bg-[var(--wf-mono-bg)] text-[var(--wf-sub)]' }
}
