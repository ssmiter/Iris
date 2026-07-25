import { IS_STANDALONE } from '@/config/product'
import { getRuntimeMode } from '@/utils/runtimeMode'
import { indexedDbAdapter } from './indexedDbAdapter'
import { backendWorkspaceAdapter } from './backendWorkspaceAdapter'

/**
 * 工作区文件条目（前后端统一表示）
 */
export interface FileEntry {
  path: string
  content: string
  parentPath: string
  createdAt: string
  updatedAt: string
  size: number
  /** 文件来源，如 'user'、'backend'、具体工具名等 */
  source?: string
  /** MIME 类型（后端提供时保留） */
  mimeType?: string
  /** 生命周期状态（后端提供时保留）：Ready / Processing / Quarantined / Deleted */
  status?: string
  /** 同名文件版本号（后端上传版本化） */
  version?: number
  /** SHA-256 校验和（后端上传时计算） */
  checksum?: string
  /** 内容摘要（文件卡片，远期） */
  extractedSummary?: string
}

/**
 * 工作区存储适配器抽象。
 *
 * Standalone 模式下使用 IndexedDB + 可选 File System Access API；
 * MESCLI 模式下通过后端 Workspace API 操作实际文件。
 */
export interface WorkspaceAdapter {
  readonly kind: 'indexedDb' | 'backend'

  readFile(path: string): Promise<FileEntry | undefined>
  writeFile(
    path: string,
    content: string,
    options?: { append?: boolean; skipSync?: boolean; meta?: Partial<FileEntry>; encoding?: 'utf-8' | 'base64' }
  ): Promise<FileEntry>
  deleteFile(path: string): Promise<void>
  listFiles(path: string, options?: { recursive?: boolean }): Promise<{ files: string[]; directories: string[] }>
  fileExists(path: string): Promise<boolean>
  globFiles(pattern: string, basePath?: string): Promise<string[]>
  grepFiles(
    pattern: string,
    options?: { path?: string; glob?: string; caseInsensitive?: boolean }
  ): Promise<Array<{ path: string; line: number; content: string }>>
  getAllFiles(): Promise<FileEntry[]>
  scanWorkspaceFiles(): Promise<number>
  clearCache(): void
}

let adapter: WorkspaceAdapter | undefined

/**
 * 获取当前运行时对应的工作区适配器。
 *
 * 注意：此函数在调用时才会读取运行时状态，避免模块加载阶段的循环依赖。
 */
export function getWorkspaceAdapter(): WorkspaceAdapter {
  if (adapter) return adapter

  if (IS_STANDALONE) {
    adapter = indexedDbAdapter
  } else {
    // MESCLI Local / Online 均以后端 Workspace API 为权威源
    adapter = backendWorkspaceAdapter
  }

  return adapter
}

/**
 * 强制重置适配器（测试或模式切换时使用）
 */
export function resetWorkspaceAdapter(): void {
  adapter = undefined
}

export { indexedDbAdapter, backendWorkspaceAdapter }
