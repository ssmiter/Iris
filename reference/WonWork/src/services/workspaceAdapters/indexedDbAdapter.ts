import { dbGet, dbPut, dbDelete, dbGetAll } from '@/api/standaloneApi'
import {
  readWorkspaceFile,
  writeWorkspaceFile,
  statWorkspaceFile,
  getWorkspaceState,
} from '@/utils/workspaceStorage'
import { isProjectPath, normalizeVirtualPath } from '@/config/workspaceDirs'
import type { FileEntry, WorkspaceAdapter } from './index'

const STORE_NAME = 'files'
const CACHE_TTL_MS = 30_000

interface CachedFile {
  entry: FileEntry
  expiresAt: number
}

const fileCache = new Map<string, CachedFile>()
const writeLocks = new Map<string, Promise<unknown>>()
let lastWorkspaceScan = 0
const WORKSPACE_SCAN_INTERVAL_MS = 5000

function normalizePath(input: string): string {
  const p = normalizeVirtualPath(input)
  // S4：/project 用户轨需要 MESCLI Local（后端在本机解析真实目录）；
  // Standalone 的项目模式走 File System Access 句柄，是 S5 的范围。
  if (isProjectPath(p)) {
    throw new Error('项目模式（/project）需要 MESCLI Local，Standalone 将在后续版本支持（S5）')
  }
  return p
}

function getParentPath(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return '/workspace'
  return path.slice(0, idx) || '/workspace'
}

function getCache(path: string): FileEntry | undefined {
  const cached = fileCache.get(path)
  if (!cached) return undefined
  if (Date.now() > cached.expiresAt) {
    fileCache.delete(path)
    return undefined
  }
  return cached.entry
}

function setCache(entry: FileEntry): void {
  fileCache.set(entry.path, { entry, expiresAt: Date.now() + CACHE_TTL_MS })
}

function invalidateCache(path: string): void {
  fileCache.delete(path)
}

function isLikelyBinary(name: string): boolean {
  const binaryExtensions = new Set([
    'exe', 'dll', 'bin', 'dat', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp',
    'mp3', 'mp4', 'wav', 'avi', 'mov', 'zip', 'rar', '7z', 'gz', 'tar',
    'pdf', 'ico', 'ttf', 'woff', 'woff2',
  ])
  const ext = name.split('.').pop()?.toLowerCase() || ''
  return binaryExtensions.has(ext)
}

function getFileExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() || ''
}

function isOfficeDocument(name: string): boolean {
  return ['docx', 'xlsx', 'pptx'].includes(getFileExtension(name))
}

function officePlaceholder(path: string, size: number): string {
  const ext = getFileExtension(path)
  const typeMap: Record<string, string> = {
    docx: 'Word',
    xlsx: 'Excel',
    pptx: 'PowerPoint',
  }
  return `二进制 ${typeMap[ext] ?? 'Office'} 文件（.${ext}），大小 ${size} 字节，无法直接读取文本内容。`
}

async function loadFromWorkspaceIfNeeded(path: string): Promise<FileEntry | undefined> {
  const cached = getCache(path)
  if (cached) return cached

  const state = getWorkspaceState()
  if (!state.isConnected || state.isFallbackMode) return undefined

  const relativePath = path.replace(/^\/workspace\//, '')

  if (isOfficeDocument(relativePath)) {
    try {
      const stat = await statWorkspaceFile(relativePath)
      if (!stat) return undefined

      const existing = await dbGet<FileEntry>(STORE_NAME, path)
      const entry: FileEntry = {
        path,
        content: officePlaceholder(path, stat.size),
        parentPath: getParentPath(path),
        createdAt: existing?.createdAt || new Date(stat.lastModified).toISOString(),
        updatedAt: new Date(stat.lastModified).toISOString(),
        size: stat.size,
      }
      await dbPut(STORE_NAME, entry)
      setCache(entry)
      return { ...entry }
    } catch (err) {
      console.warn('[indexedDbAdapter] 从 workspace 加载 Office 文件失败:', path, err)
      return undefined
    }
  }

  try {
    const content = await readWorkspaceFile(relativePath)
    if (content === null) return undefined

    const existing = await dbGet<FileEntry>(STORE_NAME, path)
    if (existing && content === '' && existing.content !== '') {
      setCache(existing)
      return { ...existing }
    }

    const entry: FileEntry = {
      path,
      content,
      parentPath: getParentPath(path),
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      size: new Blob([content]).size,
    }

    await dbPut(STORE_NAME, entry)
    setCache(entry)
    return entry
  } catch (err) {
    console.warn('[indexedDbAdapter] 从 workspace 加载失败:', path, err)
    return undefined
  }
}

async function syncToWorkspace(path: string, content: string): Promise<void> {
  const state = getWorkspaceState()
  if (!state.isConnected || state.isFallbackMode) return

  try {
    const relativePath = path.replace(/^\/workspace\//, '')
    await writeWorkspaceFile(relativePath, content)
  } catch (err) {
    console.warn('[indexedDbAdapter] 同步到 workspace 失败:', path, err)
  }
}

async function maybeScanWorkspace(): Promise<void> {
  const state = getWorkspaceState()
  if (!state.isConnected || state.isFallbackMode) return
  if (Date.now() - lastWorkspaceScan < WORKSPACE_SCAN_INTERVAL_MS) return
  try {
    await scanWorkspaceFiles()
  } catch (err) {
    console.warn('[indexedDbAdapter] 按需扫描失败:', err)
  }
}

async function scanWorkspaceFiles(): Promise<number> {
  const state = getWorkspaceState()
  if (!state.isConnected || state.isFallbackMode || !state.dirHandle) return 0

  let count = 0

  async function walk(dirHandle: FileSystemDirectoryHandle, relativePath: string): Promise<void> {
    for await (const [name, handle] of (dirHandle as any).entries()) {
      if (handle.kind === 'directory') {
        await walk(handle, relativePath ? `${relativePath}/${name}` : name)
      } else if (handle.kind === 'file') {
        try {
          const file = await handle.getFile()
          const path = '/workspace/' + (relativePath ? `${relativePath}/${name}` : name)

          if (isOfficeDocument(name)) {
            const entry: FileEntry = {
              path,
              content: officePlaceholder(path, file.size),
              parentPath: getParentPath(path),
              createdAt: new Date(file.lastModified).toISOString(),
              updatedAt: new Date(file.lastModified).toISOString(),
              size: file.size,
            }
            await dbPut(STORE_NAME, entry)
            setCache(entry)
            count++
            continue
          }

          if (isLikelyBinary(name)) {
            continue
          }
          const content = await file.text()
          const entry: FileEntry = {
            path,
            content,
            parentPath: getParentPath(path),
            createdAt: new Date(file.lastModified).toISOString(),
            updatedAt: new Date(file.lastModified).toISOString(),
            size: file.size,
          }
          await dbPut(STORE_NAME, entry)
          setCache(entry)
          count++
        } catch (err) {
          console.warn('[indexedDbAdapter] 扫描文件失败:', name, err)
        }
      }
    }
  }

  await walk(state.dirHandle, '')
  lastWorkspaceScan = Date.now()
  return count
}

function globToRegex(pattern: string): RegExp {
  let re = pattern
    .replace(/\*\*\//g, '{{GLOB_STAR}}')
    .replace(/\*\*/g, '{{GLOB_STAR_ALL}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/\{\{GLOB_STAR\}\}/g, '(?:.*/)?')
    .replace(/\{\{GLOB_STAR_ALL\}\}/g, '.*')

  return new RegExp(`^${re}$`, 'i')
}

export const indexedDbAdapter: WorkspaceAdapter = {
  kind: 'indexedDb',

  async readFile(path: string): Promise<FileEntry | undefined> {
    const normalized = normalizePath(path)

    const cached = getCache(normalized)
    if (cached) return { ...cached }

    try {
      const entry = await dbGet<FileEntry>(STORE_NAME, normalized)
      if (entry) {
        if (isOfficeDocument(normalized)) {
          const placeholder: FileEntry = {
            ...entry,
            content: officePlaceholder(normalized, entry.size),
          }
          setCache(placeholder)
          return { ...placeholder }
        }
        setCache(entry)
        return { ...entry }
      }
    } catch (err) {
      console.warn('[indexedDbAdapter] 读取 IndexedDB 失败:', normalized, err)
    }

    return loadFromWorkspaceIfNeeded(normalized)
  },

  async writeFile(
    path: string,
    content: string,
    options?: { append?: boolean; skipSync?: boolean; meta?: Partial<FileEntry>; encoding?: 'utf-8' | 'base64' }
  ): Promise<FileEntry> {
    const normalized = normalizePath(path)
    const now = new Date().toISOString()

    const previousLock = writeLocks.get(normalized) || Promise.resolve()
    const lock = previousLock.then(async () => {
      const existing = await this.readFile(normalized)

      let finalContent = content
      if (options?.append && existing) {
        finalContent = existing.content + content
      }

      const entry: FileEntry = {
        path: normalized,
        content: finalContent,
        parentPath: getParentPath(normalized),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        size: new Blob([finalContent]).size,
        ...options?.meta,
      }

      await dbPut(STORE_NAME, entry)
      setCache(entry)
      if (!options?.skipSync) {
        await syncToWorkspace(normalized, finalContent)
      }

      return { ...entry }
    })

    writeLocks.set(normalized, lock)
    try {
      return await lock as FileEntry
    } finally {
      setTimeout(() => {
        if (writeLocks.get(normalized) === lock) {
          writeLocks.delete(normalized)
        }
      }, 0)
    }
  },

  async deleteFile(path: string): Promise<void> {
    const normalized = normalizePath(path)
    invalidateCache(normalized)
    await dbDelete(STORE_NAME, normalized)
  },

  async listFiles(path: string, options?: { recursive?: boolean }): Promise<{ files: string[]; directories: string[] }> {
    const normalized = normalizePath(path)
    await maybeScanWorkspace()
    const allEntries = await dbGetAll<FileEntry>(STORE_NAME)

    const files: string[] = []
    const directories = new Set<string>()

    for (const entry of allEntries) {
      if (options?.recursive) {
        if (entry.path.startsWith(normalized + '/')) {
          files.push(entry.path)
        }
      } else {
        if (entry.parentPath === normalized) {
          files.push(entry.path)
        }
      }

      if (entry.path.startsWith(normalized + '/')) {
        const relative = entry.path.slice(normalized.length + 1)
        const slashIdx = relative.indexOf('/')
        if (slashIdx > 0) {
          directories.add(normalized + '/' + relative.slice(0, slashIdx))
        }
      }
    }

    return {
      files: Array.from(new Set(files)).sort(),
      directories: Array.from(directories).sort(),
    }
  },

  async fileExists(path: string): Promise<boolean> {
    const normalized = normalizePath(path)
    const entry = await this.readFile(normalized)
    return entry !== undefined
  },

  async globFiles(pattern: string, basePath?: string): Promise<string[]> {
    const normalizedBase = basePath ? normalizePath(basePath) : '/workspace'
    await maybeScanWorkspace()
    const allEntries = await dbGetAll<FileEntry>(STORE_NAME)

    const regex = globToRegex(pattern)
    const results: string[] = []

    for (const entry of allEntries) {
      if (!entry.path.startsWith(normalizedBase + '/') && entry.path !== normalizedBase) continue
      const relative = entry.path.slice(normalizedBase.length + 1) || entry.path
      if (regex.test(relative)) {
        results.push(entry.path)
      }
    }

    return results.sort()
  },

  async grepFiles(pattern: string, options?: { path?: string; glob?: string; caseInsensitive?: boolean }): Promise<Array<{ path: string; line: number; content: string }>> {
    const basePath = options?.path ? normalizePath(options.path) : '/workspace'
    await maybeScanWorkspace()
    const entries = await dbGetAll<FileEntry>(STORE_NAME)

    const regex = new RegExp(pattern, options?.caseInsensitive ? 'i' : '')
    const results: Array<{ path: string; line: number; content: string }> = []

    for (const entry of entries) {
      if (!entry.path.startsWith(basePath + '/') && entry.path !== basePath) continue
      if (options?.glob && !globToRegex(options.glob).test(entry.path.slice(basePath.length + 1))) continue

      const lines = entry.content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push({
            path: entry.path,
            line: i + 1,
            content: lines[i].trim(),
          })
        }
      }
    }

    return results
  },

  async getAllFiles(): Promise<FileEntry[]> {
    const entries = await dbGetAll<FileEntry>(STORE_NAME)
    return entries.sort((a, b) => a.path.localeCompare(b.path))
  },

  async scanWorkspaceFiles(): Promise<number> {
    return scanWorkspaceFiles()
  },

  clearCache(): void {
    fileCache.clear()
  },
}
