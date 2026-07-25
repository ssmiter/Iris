import type { FileEntry, WorkspaceAdapter } from './workspaceAdapters'
import { getWorkspaceAdapter } from './workspaceAdapters'
import { trackFileEdit } from './fileHistory'

/**
 * WonWork 前端虚拟文件系统（VFS）统一入口
 *
 * 设计原则：
 * 1. 路径统一以 /workspace/ 为前缀，与 system prompt 中的约定一致。
 * 2. Standalone 模式下使用 IndexedDB + 可选 File System Access API。
 * 3. MESCLI 模式下通过后端 Workspace API 操作实际文件，后端为权威源。
 * 4. 工具层、工作区面板、Agentic 循环均通过此文件访问文件，无需关心底层适配器。
 */

export type { FileEntry }

function getAdapter(): WorkspaceAdapter {
  return getWorkspaceAdapter()
}

/**
 * 读取文件内容
 */
export async function readFile(path: string): Promise<FileEntry | undefined> {
  return getAdapter().readFile(path)
}

/**
 * 写入或创建文件（写前经 fileHistory 备份旧内容，支撑对话分支的世界状态回滚）
 */
export async function writeFile(
  path: string,
  content: string,
  options?: { append?: boolean; encoding?: 'utf-8' | 'base64' }
): Promise<FileEntry> {
  await trackFileEdit(path)
  return getAdapter().writeFile(path, content, options)
}

/**
 * 删除文件（删前经 fileHistory 备份旧内容）
 */
export async function deleteFile(path: string): Promise<void> {
  await trackFileEdit(path)
  return getAdapter().deleteFile(path)
}

/**
 * 列出目录下文件和子目录
 */
export async function listFiles(
  path: string,
  options?: { recursive?: boolean }
): Promise<{ files: string[]; directories: string[] }> {
  return getAdapter().listFiles(path, options)
}

/**
 * 检查文件是否存在
 */
export async function fileExists(path: string): Promise<boolean> {
  return getAdapter().fileExists(path)
}

/**
 * Glob 匹配（简化版，支持 * 和 **）
 */
export async function globFiles(pattern: string, basePath?: string): Promise<string[]> {
  return getAdapter().globFiles(pattern, basePath)
}

/**
 * Grep 搜索
 */
export async function grepFiles(
  pattern: string,
  options?: { path?: string; glob?: string; caseInsensitive?: boolean }
): Promise<Array<{ path: string; line: number; content: string }>> {
  return getAdapter().grepFiles(pattern, options)
}

/**
 * 获取所有文件条目（用于工作区文件面板）
 */
export async function getAllFiles(): Promise<FileEntry[]> {
  return getAdapter().getAllFiles()
}

/**
 * 扫描已连接的本地工作区目录（Standalone 模式），把其中文件同步到缓存。
 * MESCLI 模式下后端是权威源，此方法无实际操作。
 */
export async function scanWorkspaceFiles(): Promise<number> {
  return getAdapter().scanWorkspaceFiles()
}

/**
 * 清除内存缓存（测试或调试使用）
 */
export function clearFileCache(): void {
  getAdapter().clearCache()
}
