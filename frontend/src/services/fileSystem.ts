import type { FileEntry, WorkspaceAdapter } from './workspaceAdapters'
import { getWorkspaceAdapter } from './workspaceAdapters'
import { trackFileEdit } from './fileHistory'
import { capabilityFs, isCapabilityPath, type CapabilityHitFile } from './capabilityFs'

/**
 * WonWork 前端虚拟文件系统（VFS）统一入口
 *
 * 设计原则：
 * 1. 路径统一以 /workspace/ 为前缀，与 system prompt 中的约定一致。
 * 2. Standalone 模式下使用 IndexedDB + 可选 File System Access API。
 * 3. MESCLI 模式下通过后端 Workspace API 操作实际文件，后端为权威源。
 * 4. 工具层、工作区面板、Agentic 循环均通过此文件访问文件，无需关心底层适配器。
 * 5. /capabilities/ 前缀路由到只读能力目录虚拟文件系统（capabilityFs），
 *    能力发现与工作区读写复用同一套 grep/glob/read_file/list_files 原语。
 * 6. /skills 虚拟目录已随技能文件化退役（2026-09-03）：技能就是 ~/.wonwork/skills/
 *    下的真实文件，模型用文件原语直读直写，不再需要虚拟发现面。
 */

export type { FileEntry }

function getAdapter(): WorkspaceAdapter {
  return getWorkspaceAdapter()
}

const READ_ONLY_CAPABILITIES_ERROR =
  '/capabilities 是只读能力目录，不支持写操作。使用工具请通过 read_capability("<path>") 加载后调用。'

/**
 * 读取文件内容。
 * fresh:true 绕开 3s 读缓存强制后端现读——expectedContent 写前对账等正确性敏感场景
 * 必须比对真实现状（2026-09-01 P0-7 零副本纪律：缓存只服务复读提速，不参与写前对账）。
 */
export async function readFile(path: string, options?: { fresh?: boolean }): Promise<FileEntry | undefined> {
  return getAdapter().readFile(path, options)
}

/**
 * 写入或创建文件（写前经 fileHistory 备份旧内容，支撑对话分支的世界状态回滚）
 */
export async function writeFile(
  path: string,
  content: string,
  options?: { append?: boolean; encoding?: 'utf-8' | 'base64' }
): Promise<FileEntry> {
  if (isCapabilityPath(path)) throw new Error(READ_ONLY_CAPABILITIES_ERROR)
  await trackFileEdit(path)
  return getAdapter().writeFile(path, content, options)
}

/**
 * 删除文件（删前经 fileHistory 备份旧内容）
 */
export async function deleteFile(path: string): Promise<void> {
  if (isCapabilityPath(path)) throw new Error(READ_ONLY_CAPABILITIES_ERROR)
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
  if (isCapabilityPath(path)) return capabilityFs.listFiles(path, options)
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
  if (basePath && isCapabilityPath(basePath)) return capabilityFs.globFiles(pattern, basePath)
  // 绝对 glob 模式直接命中 /capabilities 挂载点时同样路由
  if (!basePath && isCapabilityPath(pattern)) return capabilityFs.globFiles(pattern)
  return getAdapter().globFiles(pattern, basePath)
}

/**
 * Grep 搜索。matches 为截断后的返回集，total 为真实命中总数（> matches.length 即截断），
 * fileCount 为实际扫描的文件数（仅 /capabilities 路由提供，
 * 用于 0 命中时自证"目录非空"），hitFiles 为按文件聚合视图（同上，按命中密度排序）。
 */
export async function grepFiles(
  pattern: string,
  options?: { path?: string; glob?: string; caseInsensitive?: boolean }
): Promise<{
  matches: Array<{ path: string; line: number; content: string }>
  total: number
  fileCount?: number
  hitFiles?: CapabilityHitFile[]
}> {
  if (options?.path && isCapabilityPath(options.path)) return capabilityFs.grepFiles(pattern, options)
  const matches = await getAdapter().grepFiles(pattern, options)
  return { matches, total: matches.length }
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
