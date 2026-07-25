/**
 * ArtifactDock 预览坞类型
 *
 * 对应右侧栏中的 Artifact 坞数据结构。
 */

// ==================== 文件卡片 ====================

export interface FileCardArtifact {
  /** 产物唯一标识 */
  id: string
  /** 产物标题 */
  title: string
  /** 文件路径 */
  path: string
  /** 文件大小（字节） */
  size?: number
  /** 文件类型 */
  mimeType?: string
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt?: number
  /** 关联的 toolCallId */
  sourceToolCallId?: string
}

// ==================== Workspace 条目 ====================

export interface WorkspaceItemDto {
  path: string
  name: string
  /** 'folder' | 'file' */
  kind: string
  /** 文件大小 */
  sizeBytes?: number
  mimeType?: string
  /** 文件状态 */
  status?: string
  /** 版本号 */
  version?: number
  /** 更新时间 */
  updatedAt?: string
}
