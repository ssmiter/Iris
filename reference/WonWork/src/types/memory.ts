/**
 * 长期记忆类型
 *
 * 参考 E:\code\WonWork\learn\03\workshop\memory-workshop.md
 */

// ==================== 记忆条目 ====================

export type MemoryCategory = 'user_preference' | 'fact' | 'concept' | 'workflow' | 'session_summary'

export interface MemoryEntry {
  id: string
  category: MemoryCategory
  content: string
  /** 关键词标签，用于搜索 */
  tags?: string[]
  /** 关联消息 ID（溯源） */
  sourceMessageId?: string
  /** 关联会话 ID（溯源） */
  sourceConversationId?: number
  createdAt: string
  updatedAt: string
  /** 访问次数 */
  accessCount: number
  /** 重要性（0-1） */
  importance: number
  /** 过期时间 */
  expiresAt?: string
  metadata?: Record<string, unknown>
}

// ==================== 记忆查询 ====================

export interface MemoryQuery {
  query: string
  category?: MemoryCategory
  tags?: string[]
  limit?: number
  minImportance?: number
}

// ==================== 记忆配置 ====================

export interface MemoryConfig {
  /** 启用长期记忆 */
  enabled: boolean
  /** 最大记忆条目数 */
  maxEntries: number
  /** 自动摘要间隔（消息数） */
  autoSummarizeInterval: number
  /** 用户偏好中的系统角色影响权重（0-1） */
  roleInfluenceWeight: number
}

// ==================== 用户画像 ====================

export interface UserProfile {
  /** 用户偏好标签 */
  preferences: string[]
  /** 常用工具 */
  frequentTools: string[]
  /** 常用模型 */
  preferredModel?: string
  /** 语言偏好 */
  language?: string
  lastUpdated: string
}
