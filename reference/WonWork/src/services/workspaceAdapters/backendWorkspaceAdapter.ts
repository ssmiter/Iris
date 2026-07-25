import { workspaceApi } from '@/api/client'
import type { WorkspaceNode } from '@/types/mescli'
import { normalizeVirtualPath } from '@/config/workspaceDirs'
import { useProjectStore } from '@/stores/projectStore'
import type { FileEntry, WorkspaceAdapter } from './index'

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.js', '.ts', '.jsx', '.tsx',
  '.css', '.scss', '.html', '.xml', '.yaml', '.yml', '.csv', '.log',
  '.py', '.sh', '.cs', '.sql', '.ini', '.cfg', '.conf',
])

const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx'])

// S4：规范化收敛到 config/workspaceDirs.ts（双根单一事实来源），/project 原样透传后端
function normalizePath(input: string): string {
  return normalizeVirtualPath(input)
}

function getParentPath(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return '/workspace'
  return path.slice(0, idx) || '/workspace'
}

function getFileExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() || ''
}

function isTextFile(name: string): boolean {
  const ext = '.' + getFileExtension(name)
  return TEXT_EXTENSIONS.has(ext)
}

function isOfficeDocument(name: string): boolean {
  return OFFICE_EXTENSIONS.has('.' + getFileExtension(name))
}

function officePlaceholder(path: string, size: number): string {
  const ext = getFileExtension(path)
  const typeMap: Record<string, string> = { docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint' }
  return `二进制 ${typeMap[ext] ?? 'Office'} 文件（.${ext}），大小 ${size} 字节，无法直接读取文本内容。`
}

function nodeToFileEntry(node: WorkspaceNode): FileEntry {
  const isOffice = isOfficeDocument(node.name)
  return {
    path: node.path,
    content: isOffice && node.sizeBytes !== undefined
      ? officePlaceholder(node.path, node.sizeBytes)
      : '',
    parentPath: getParentPath(node.path),
    createdAt: node.createdAt || new Date().toISOString(),
    updatedAt: node.updatedAt || new Date().toISOString(),
    size: node.sizeBytes ?? 0,
    source: node.source,
    mimeType: node.mimeType,
    status: node.status,
    version: node.version,
    checksum: node.checksumSha256,
    extractedSummary: node.extractedSummary,
  }
}

async function listAllFiles(path = '/workspace'): Promise<WorkspaceNode[]> {
  const result = await workspaceApi.list(path)
  const files: WorkspaceNode[] = []

  for (const node of result.nodes) {
    if (node.kind === 'file') {
      files.push(node)
    } else if (node.kind === 'folder') {
      try {
        const children = await listAllFiles(node.path)
        files.push(...children)
      } catch (err) {
        console.warn('[backendWorkspaceAdapter] 递归列出目录失败:', node.path, err)
      }
    }
  }

  return files
}

// S4：/project 是用户真实项目目录，体量不可控——必须跳过重型目录并加深度/条目上限，
// 否则 node_modules/.git/bin/obj 会把面板淹没、把请求打爆
const PROJECT_SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'bin', 'obj', 'dist', 'build', 'target',
  '.venv', 'venv', '__pycache__', '.vs', '.idea', 'packages', '.next', '.nuxt',
  'coverage', '.cache', 'tmp', 'temp',
])
const PROJECT_MAX_DEPTH = 4
const PROJECT_MAX_ENTRIES = 2000

async function listProjectFiles(path = '/project', depth = 0, budget = { count: 0 }): Promise<WorkspaceNode[]> {
  if (depth > PROJECT_MAX_DEPTH || budget.count >= PROJECT_MAX_ENTRIES) return []
  let result
  try {
    result = await workspaceApi.list(path)
  } catch (err) {
    console.warn('[backendWorkspaceAdapter] /project 列出失败:', path, err)
    return []
  }
  const files: WorkspaceNode[] = []

  for (const node of result.nodes) {
    if (budget.count >= PROJECT_MAX_ENTRIES) break
    if (node.kind === 'file') {
      files.push(node)
      budget.count++
    } else if (node.kind === 'folder' && !PROJECT_SKIP_DIRS.has(node.name)) {
      const children = await listProjectFiles(node.path, depth + 1, budget)
      files.push(...children)
    }
  }

  return files
}

export const backendWorkspaceAdapter: WorkspaceAdapter = {
  kind: 'backend',

  async readFile(path: string): Promise<FileEntry | undefined> {
    const normalized = normalizePath(path)
    try {
      const response = await workspaceApi.read(normalized)
      if (!response) return undefined

      if (!response.isText || response.content === undefined) {
        return {
          path: normalized,
          content: officePlaceholder(normalized, response.sizeBytes ?? 0),
          parentPath: getParentPath(normalized),
          createdAt: response.updatedAt || new Date().toISOString(),
          updatedAt: response.updatedAt || new Date().toISOString(),
          size: response.sizeBytes ?? 0,
          source: 'backend',
          mimeType: response.mimeType,
        }
      }

      return {
        path: normalized,
        content: response.content,
        parentPath: getParentPath(normalized),
        createdAt: response.updatedAt || new Date().toISOString(),
        updatedAt: response.updatedAt || new Date().toISOString(),
        size: response.sizeBytes ?? new Blob([response.content]).size,
        source: 'backend',
        mimeType: response.mimeType,
      }
    } catch (err) {
      console.warn('[backendWorkspaceAdapter] readFile failed:', normalized, err)
      return undefined
    }
  },

  async writeFile(
    path: string,
    content: string,
    options?: { append?: boolean; encoding?: 'utf-8' | 'base64' }
  ): Promise<FileEntry> {
    const normalized = normalizePath(path)
    const node = await workspaceApi.write(normalized, content, options?.append, options?.encoding)

    // base64 写入后端会解码为二进制，content 长度不等于实际字节数，用后端返回的 sizeBytes 更准
    const size =
      node.sizeBytes ??
      (options?.encoding === 'base64' ? Math.ceil(content.length * 0.75) : new Blob([content]).size)

    return {
      path: normalized,
      content,
      parentPath: getParentPath(normalized),
      createdAt: node.createdAt || new Date().toISOString(),
      updatedAt: node.updatedAt || new Date().toISOString(),
      size,
      source: node.source ?? 'user',
      mimeType: node.mimeType,
      status: node.status,
      version: node.version,
      checksum: node.checksumSha256,
      extractedSummary: node.extractedSummary,
    }
  },

  async deleteFile(path: string): Promise<void> {
    const normalized = normalizePath(path)
    await workspaceApi.delete(normalized)
  },

  async listFiles(path: string, options?: { recursive?: boolean }): Promise<{ files: string[]; directories: string[] }> {
    const normalized = normalizePath(path)

    if (options?.recursive) {
      const all = await listAllFiles(normalized)
      const files = all.map((n) => n.path).sort()
      return { files, directories: [] }
    }

    const response = await workspaceApi.list(normalized)
    const files: string[] = []
    const directories: string[] = []

    for (const node of response.nodes) {
      if (node.kind === 'file') files.push(node.path)
      else if (node.kind === 'folder') directories.push(node.path)
    }

    return { files: files.sort(), directories: directories.sort() }
  },

  async fileExists(path: string): Promise<boolean> {
    const normalized = normalizePath(path)
    try {
      await workspaceApi.read(normalized)
      return true
    } catch {
      return false
    }
  },

  async globFiles(pattern: string, basePath?: string): Promise<string[]> {
    const normalizedBase = basePath ? normalizePath(basePath) : '/workspace'
    const all = await listAllFiles(normalizedBase)
    const regex = globToRegex(pattern)

    return all
      .filter((node) => {
        const relative = node.path.slice(normalizedBase.length + 1) || node.path
        return regex.test(relative)
      })
      .map((node) => node.path)
      .sort()
  },

  async grepFiles(
    pattern: string,
    options?: { path?: string; glob?: string; caseInsensitive?: boolean }
  ): Promise<Array<{ path: string; line: number; content: string }>> {
    const basePath = options?.path ? normalizePath(options.path) : '/workspace'
    const all = await listAllFiles(basePath)
    const regex = new RegExp(pattern, options?.caseInsensitive ? 'i' : '')
    const results: Array<{ path: string; line: number; content: string }> = []

    for (const node of all) {
      if (!isTextFile(node.name)) continue
      if (options?.glob && !globToRegex(options.glob).test(node.path.slice(basePath.length + 1))) continue

      try {
        const entry = await backendWorkspaceAdapter.readFile(node.path)
        if (!entry) continue
        const lines = entry.content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push({ path: node.path, line: i + 1, content: lines[i].trim() })
          }
        }
      } catch (err) {
        console.warn('[backendWorkspaceAdapter] grep read failed:', node.path, err)
      }
    }

    return results
  },

  async getAllFiles(): Promise<FileEntry[]> {
    const nodes = await listAllFiles('/workspace')
    // S4：有活跃项目时合并 /project 树（跳过重型目录 + 深度/条目上限）
    const activeProject = useProjectStore.getState().activeProject
    if (activeProject) {
      const projectNodes = await listProjectFiles('/project')
      nodes.push(...projectNodes)
    }
    return nodes.map(nodeToFileEntry).sort((a, b) => a.path.localeCompare(b.path))
  },

  async scanWorkspaceFiles(): Promise<number> {
    // 后端是权威源，无需扫描本地目录
    return 0
  },

  clearCache(): void {
    // 后端状态不缓存
  },
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
