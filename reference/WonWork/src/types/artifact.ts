/**
 * Artifact 卡片数据类型
 *
 * 对应前端渲染产物的数据结构。
 */

// ==================== 基础 ====================

export interface BaseArtifact {
  id: string
  type: string
  title: string
  /** 跨轮次可引用的产物 ID */
  artifactId: string
  /** 同一产物被更新时 +1，旧版本可回看 */
  version?: number
  /** 溯源：生成此产物的工具调用 ID */
  sourceToolCallId?: string
  createdAt: number
  metadata?: Record<string, unknown>
}

// ==================== 图片 ====================

export interface ImageArtifact extends BaseArtifact {
  type: 'image'
  /** base64 或 URL */
  src: string
  alt?: string
  width?: number
  height?: number
}

// ==================== 表格 ====================

export interface TableArtifact extends BaseArtifact {
  type: 'table'
  headers: string[]
  rows: Record<string, unknown>[]
  caption?: string
}
