/**
 * Artifact 卡片数据契约
 *
 * 后端 `present_artifact` 工具通过 `ToolResultChunk.structuredData` 下发，
 * 前端直接写入 `ChatMessage.structuredData` 并由 `PresentArtifactRenderer` 渲染。
 */

export type ArtifactType = 'image' | 'table' | 'document' | 'workflow' | 'unknown'

export interface BaseArtifact {
  type: ArtifactType
  path: string
  mimeType: string
  sizeBytes: number
  previewUrl: string
  caption?: string
  fileName?: string
}

export interface ImageArtifact extends BaseArtifact {
  type: 'image'
  width?: number
  height?: number
}

export interface TableArtifact extends BaseArtifact {
  type: 'table'
  columns: string[]
  rows: Record<string, unknown>[]
  totalRows: number
}

/** 工作流投影产物（present_artifact path=/workflow/<id>.json，2026-09-08）：
 * 无 previewUrl（工作流文件不走 workspace 下载链），doc/errors 直接内嵌 payload。 */
export interface WorkflowArtifact extends Omit<BaseArtifact, 'previewUrl'> {
  type: 'workflow'
  previewUrl?: string
  workflow?: import('./workflow').WorkflowDoc
  /** 后端校验闸结果（结构待修在此可见） */
  errors?: string[]
}

export type Artifact = ImageArtifact | TableArtifact | WorkflowArtifact | BaseArtifact

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.every((v) => typeof v === 'object' && v !== null && !Array.isArray(v))
  )
}

export function isBaseArtifact(data: unknown): data is BaseArtifact {
  if (!data || typeof data !== 'object') return false
  const obj = data as Record<string, unknown>
  if (
    !isNonEmptyString(obj.path) ||
    !isNonEmptyString(obj.mimeType) ||
    !isNumber(obj.sizeBytes) ||
    !(obj.type === 'image' || obj.type === 'table' || obj.type === 'document' || obj.type === 'workflow' || obj.type === 'unknown')
  ) {
    return false
  }
  // workflow 投影产物无 previewUrl（工作流文件不走 workspace 下载链）
  if (obj.type !== 'workflow' && !isNonEmptyString(obj.previewUrl)) return false
  return true
}

export function isWorkflowArtifact(data: unknown): data is WorkflowArtifact {
  return isBaseArtifact(data) && data.type === 'workflow'
}

export function isImageArtifact(data: unknown): data is ImageArtifact {
  return isBaseArtifact(data) && data.type === 'image'
}

export function isTableArtifact(data: unknown): data is TableArtifact {
  if (!isBaseArtifact(data) || data.type !== 'table') return false
  const obj = data as unknown as Record<string, unknown>
  return (
    isStringArray(obj.columns) &&
    isRecordArray(obj.rows) &&
    isNumber(obj.totalRows)
  )
}

export function isArtifact(data: unknown): data is Artifact {
  return isBaseArtifact(data)
}

export function extractArtifact(data: unknown): Artifact | null {
  if (isArtifact(data)) return data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>
    if (isArtifact(obj.artifact)) return obj.artifact
  }
  return null
}
