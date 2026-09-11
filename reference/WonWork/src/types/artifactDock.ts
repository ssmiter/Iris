/**
 * 预览坞（ArtifactDock）+ 统一文件卡片（FileCard）数据契约
 *
 * 从后端 `present_artifact` 工具返回的 `BaseArtifact` / `ImageArtifact` / `TableArtifact`
 * 转换为统一的 `FileCardArtifact`，供 FileCard 和 ArtifactDock 共用。
 */

import i18n from '@/i18n'

/** 产物类型分类（用于 mini 预览 + 大预览渲染） */
export type FileCardArtifactKind = 'chart' | 'table' | 'doc' | 'image' | 'workflow' | 'unknown'

/** 统一文件卡片数据契约 */
export interface FileCardArtifact {
  /** 唯一 ID，使用 artifact.path */
  id: string
  /** 产物分类，决定 mini 预览和大预览的渲染方式 */
  kind: FileCardArtifactKind
  /** 中文类型标签：图表 / 表格 / 文档 / 图片 / 文件 */
  typeLabel: string
  /** 强调色（hex） */
  accent: string
  /** 强调色背景（rgba） */
  accentBg: string
  /** 一句话结论（来自 present_artifact 的 caption 参数） */
  caption: string
  /** 文件名（含扩展名） */
  fileName: string
  /** workspace 路径 */
  path: string
  /** 格式化后的文件大小（如 "48 KB"） */
  size: string
  /** MIME 类型 */
  mimeType: string
  /** 预览/下载 URL */
  previewUrl: string
  /** 图表数据（kind === 'chart' 时填充） */
  chartData?: { title?: string; bars: [string, number][] }
  /** 表格数据（kind === 'table' 时填充） */
  tableData?: { columns: string[]; rows: string[][] }
  /** 文档 HTML（kind === 'doc' 时填充） */
  docHtml?: string
  /** 工作流数据（kind === 'workflow' 时填充）：内嵌文档 + 校验结果 */
  workflowData?: { doc: import('./workflow').WorkflowDoc; errors: string[] }
}

/** kind → accent 颜色映射 */
const KIND_ACCENT: Record<FileCardArtifactKind, string> = {
  chart: '#7c3aed',
  table: '#059669',
  doc: '#2563eb',
  image: '#0ea5e9',
  workflow: '#d97706',
  unknown: '#64748b',
}

/** kind → accent 背景色映射 */
const KIND_ACCENT_BG: Record<FileCardArtifactKind, string> = {
  chart: 'rgba(124,58,237,.08)',
  table: 'rgba(5,150,105,.08)',
  doc: 'rgba(37,99,235,.08)',
  image: 'rgba(14,165,233,.08)',
  workflow: 'rgba(217,119,6,.08)',
  unknown: 'rgba(100,116,139,.08)',
}

/** kind → 类型标签（随界面语言，APS/present 等产物卡胶囊文字） */
function getKindLabelMap(): Record<FileCardArtifactKind, string> {
  return {
    chart: i18n.t('chat.artifactKind.chart'),
    table: i18n.t('chat.artifactKind.table'),
    doc: i18n.t('chat.artifactKind.doc'),
    image: i18n.t('chat.artifactKind.image'),
    workflow: i18n.t('chat.artifactKind.workflow'),
    unknown: i18n.t('chat.artifactKind.unknown'),
  }
}

export function getKindAccent(kind: FileCardArtifactKind): string {
  return KIND_ACCENT[kind]
}

export function getKindAccentBg(kind: FileCardArtifactKind): string {
  return KIND_ACCENT_BG[kind]
}

export function getKindLabel(kind: FileCardArtifactKind): string {
  return getKindLabelMap()[kind]
}

// ── 转换函数：后端 Artifact → FileCardArtifact ────────────────

import type { Artifact, TableArtifact } from './artifact'
import { isTableArtifact, isWorkflowArtifact } from './artifact'
import { formatFileSize } from '@/utils/formatFileSize'

/** 从后端 Artifact 派生出 FileCardArtifact 的 kind */
function deriveKind(artifact: Artifact): FileCardArtifactKind {
  if (isWorkflowArtifact(artifact)) return 'workflow'
  if (isTableArtifact(artifact)) return 'table'
  if (artifact.type === 'document') return 'doc'
  // 优先按 MIME 类型判断——真实图片走 image，否则 type='image' 视为图表
  if (artifact.mimeType?.startsWith('image/')) return 'image'
  if (artifact.type === 'image') return 'chart'
  return deriveKindFromFile(artifact.path, artifact.mimeType)
}

/** 按文件名/MIME 派生 kind（工作区浏览入口与呈现入口共用同一套规则） */
export function deriveKindFromFile(fileName: string, mimeType?: string): FileCardArtifactKind {
  if (mimeType?.startsWith('image/')) return 'image'
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (ext === 'csv' || mimeType === 'text/csv') return 'table'
  if (ext === 'md' || ext === 'markdown' || ext === 'html' || ext === 'htm' || mimeType?.includes('markdown')) return 'doc'
  if (/\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i.test(fileName)) return 'image'
  return 'unknown'
}

/** 将后端 Artifact 转换为统一的 FileCardArtifact */
export function toFileCardArtifact(artifact: Artifact): FileCardArtifact {
  const kind = deriveKind(artifact)
  const fileName = artifact.fileName || artifact.path.split('/').pop() || 'unknown'

  const result: FileCardArtifact = {
    id: artifact.path,
    kind,
    typeLabel: getKindLabelMap()[kind],
    accent: KIND_ACCENT[kind],
    accentBg: KIND_ACCENT_BG[kind],
    caption: artifact.caption || '',
    fileName,
    path: artifact.path,
    size: formatFileSize(artifact.sizeBytes),
    mimeType: artifact.mimeType,
    previewUrl: artifact.previewUrl || '',
  }

  // 提取富数据
  if (kind === 'workflow' && isWorkflowArtifact(artifact)) {
    // 校验闸未通过的呈现只有 errors、无内嵌 doc——不置 workflowData，卡片退化为
    // 无图形态（MiniDoc 骨架）。曾把 undefined doc 喂给 WorkflowGraph 致渲染期崩溃：
    // 全仓无 ErrorBoundary，单条坏消息让整棵 React 树卸载、会话打开即空白。
    const doc = artifact.workflow as import('./workflow').WorkflowDoc | undefined
    if (doc && Array.isArray(doc.nodes) && Array.isArray(doc.edges)) {
      result.workflowData = { doc, errors: artifact.errors ?? [] }
    }
  }
  if (kind === 'table' && isTableArtifact(artifact)) {
    const table = artifact as TableArtifact
    result.tableData = {
      columns: table.columns,
      rows: table.rows.map((row) => table.columns.map((col) => String(row[col] ?? ''))),
    }
  }

  return result
}

/**
 * 从工作区文件树节点合成 FileCardArtifact。
 *
 * 预览坞 = 本对话的产物中心：呈现入口（present_artifact → FileCard）与
 * 浏览入口（工作区 tab 点击文件）汇入同一注册表——合成产物经 registerArtifact
 * 后同样出现在底部胶片条，可用同一 PreviewPane 预览。
 * id 取文件路径保证幂等：同路径后续经 present_artifact 注册富数据时会正确覆盖。
 */
export function fileNodeToArtifact(node: {
  name: string
  path: string
  size?: number
  mimeType?: string
}): FileCardArtifact {
  const kind = deriveKindFromFile(node.name, node.mimeType)
  return {
    id: node.path,
    kind,
    typeLabel: getKindLabelMap()[kind],
    accent: KIND_ACCENT[kind],
    accentBg: KIND_ACCENT_BG[kind],
    caption: node.name,
    fileName: node.name,
    path: node.path,
    size: node.size != null ? formatFileSize(node.size) : '',
    mimeType: node.mimeType || 'application/octet-stream',
    previewUrl: node.path,
  }
}

// ── 会话-文件索引（工作区对话隔离，后端 /api/workspace/items） ──────────

/** 后端 AiWorkspaceItem 的 DTO（camelCase，JsonSerializerOptions.Web） */
export interface WorkspaceItemDto {
  id: number
  conversationId: number
  userId: string
  virtualPath: string
  kind: 'output' | 'upload' | 'presented' | 'opened'
  caption?: string | null
  mimeType?: string | null
  sizeBytes?: number | null
  source?: string | null
  createdAt: string
  updatedAt: string
}

/**
 * 索引条目 → FileCardArtifact（会话切换时水合坞注册表）。
 * presented 条目带 caption（一句话结论），其余以文件名兜底。
 */
export function workspaceItemToArtifact(item: WorkspaceItemDto): FileCardArtifact {
  const fileName = item.virtualPath.split('/').pop() || item.virtualPath
  // 会话水合只有索引行（无内嵌文档）：/workflow/ 路径保持 workflow kind，
  // 打开预览时经 deriveKind 无文档 → 预览层按 id 重读（PreviewPane 处理）
  const kind = item.virtualPath.startsWith('/workflow/')
    ? 'workflow'
    : deriveKindFromFile(fileName, item.mimeType ?? undefined)
  return {
    id: item.virtualPath,
    kind,
    typeLabel: getKindLabelMap()[kind],
    accent: KIND_ACCENT[kind],
    accentBg: KIND_ACCENT_BG[kind],
    caption: item.caption || fileName,
    fileName,
    path: item.virtualPath,
    size: item.sizeBytes != null ? formatFileSize(item.sizeBytes) : '',
    mimeType: item.mimeType || 'application/octet-stream',
    previewUrl: item.virtualPath,
  }
}
