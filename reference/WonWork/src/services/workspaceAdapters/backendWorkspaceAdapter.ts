import { workspaceApi, ApiError } from '@/api/client'
import type { WorkspaceNode } from '@/types/mescli'
import { normalizeVirtualPath } from '@/config/workspaceDirs'
import type { FileEntry, WorkspaceAdapter } from './index'

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.js', '.ts', '.jsx', '.tsx',
  '.css', '.scss', '.html', '.xml', '.yaml', '.yml', '.csv', '.log',
  '.py', '.sh', '.cs', '.sql', '.ini', '.cfg', '.conf',
])

const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx'])

// P0-7（2026-09-01）：规范化收敛到 config/workspaceDirs.ts——/workspace 前缀补齐 +
// 物理绝对路径原样透传（后端负责登记根闸与 MSYS 归一），/project 在此显式退役报错
function normalizePath(input: string): string {
  return normalizeVirtualPath(input)
}

/**
 * 目录授权挑战（2026-09-01 P0-7）：后端对未登记物理路径返回 409
 * {error_code:'directory_not_registered', path, exists}，适配器转成类型化错误上抛，
 * fileTools 捕获后产出挑战形工具结果，toolExecutor 走"登记+原样重试"自愈闭环——
 * 与 run_command 的 cwd 挑战同一协议。
 */
export class DirectoryChallengeError extends Error {
  constructor(
    message: string,
    public readonly path: string,
    public readonly exists: boolean
  ) {
    super(message)
    this.name = 'DirectoryChallengeError'
  }
}

/** 识别后端 409 挑战并转类型化错误；非挑战错误原样返回（调用方决定吞还是抛） */
function toChallengeError(err: unknown): DirectoryChallengeError | null {
  if (err instanceof ApiError && err.status === 409) {
    const data = err.data as { error_code?: string; path?: string; exists?: boolean } | undefined
    if (data?.error_code === 'directory_not_registered' && typeof data.path === 'string') {
      return new DirectoryChallengeError(err.message, data.path, data.exists === true)
    }
  }
  return null
}

/** 挑战错误一律上抛（工具链需要它走自愈闭环）；其余错误由调用方按原语义处理 */
function rethrowIfChallenge(err: unknown): void {
  const challenge = toChallengeError(err)
  if (challenge) throw challenge
}

function getParentPath(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return '/'
  return path.slice(0, idx) || '/'
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

// ==================== 2026-08-02 性能统一：3s TTL 正缓存 ====================
// 根因背景：此前全链路零缓存，Agent 典型链 grep→read→str_replace→复读 每步都是完整 HTTP+磁盘读。
// 设计对齐 indexedDbAdapter 的 TTL 缓存先例（Map+{entry,expiresAt}），TTL 取 3s：
// 覆盖同一轮对话内的重复读/重复列举；后端无变更信号（python OUTPUT_PATH/SQL 落盘/外部编辑器旁路写），
// 最坏滞后一个 TTL——复读场景收益远大于此风险。
// 只缓存成功结果（正缓存）：404 与网络抖动不能固化成"文件不存在"。
// 2026-09-01 P0-7 零副本纪律：expectedContent 比对等正确性敏感读必须 fresh:true 绕开缓存——
// 缓存只服务"复读提速"，绝不参与写前对账。
const READ_CACHE_TTL_MS = 3000
const LIST_CACHE_TTL_MS = 3000
const readCache = new Map<string, { entry: FileEntry; expiresAt: number }>()
const listCache = new Map<string, { nodes: WorkspaceNode[]; expiresAt: number }>()

function getCachedRead(path: string): FileEntry | undefined {
  const hit = readCache.get(path)
  if (!hit) return undefined
  if (hit.expiresAt <= Date.now()) {
    readCache.delete(path)
    return undefined
  }
  return hit.entry
}

function setCachedRead(path: string, entry: FileEntry): void {
  readCache.set(path, { entry, expiresAt: Date.now() + READ_CACHE_TTL_MS })
}

/** 写/删后失效：读缓存按路径精确失效；目录列举可能因任何写变化，粗粒度全清（TTL 本就 3s，代价可忽略） */
function invalidateAfterWrite(path: string): void {
  readCache.delete(path)
  listCache.clear()
}

function getCachedList(path: string): WorkspaceNode[] | undefined {
  const hit = listCache.get(path)
  if (!hit) return undefined
  if (hit.expiresAt <= Date.now()) {
    listCache.delete(path)
    return undefined
  }
  return hit.nodes
}

function setCachedList(path: string, nodes: WorkspaceNode[]): void {
  listCache.set(path, { nodes, expiresAt: Date.now() + LIST_CACHE_TTL_MS })
}

/** 递归列出全部文件：子目录 Promise.all 并发（原为逐个 await 串行，N 层目录=N 倍往返）；
 *  按目录路径走 3s listCache——grep 每次都全量列举，同轮第二次起零请求。
 *  2026-08-31 递归单请求快路径：逐目录请求在浏览器 6 连接限流下，1061 目录实测 60s
 *  （发送路径 buildRecentFilesTailNote 卡死首句回复的根因）。recursive=true 一次拿回子树，
 *  以响应的 recursive 回声字段识别后端是否支持——旧后端静默忽略未知参数只回单层，
 *  缺回声必须回退逐层递归，不能把单层误当全量。
 *  2026-09-01 P0-7：物理根同样走此通道（重型目录跳过/深度上限由后端遍历纪律承担）。 */
async function listAllFiles(path = '/workspace'): Promise<WorkspaceNode[]> {
  const cached = getCachedList(path)
  if (cached) return cached

  try {
    const subtree = await workspaceApi.list(path, true)
    if (subtree.recursive === true) {
      const files = subtree.nodes.filter((n) => n.kind === 'file')
      setCachedList(path, files)
      return files
    }
  } catch (err) {
    // 挑战错误不是"快路径不可用"——登记闸必须上抛走自愈闭环，不能跌进逐层递归兜底
    rethrowIfChallenge(err)
    // 快路径不可用（旧后端/网络抖动）→ 走下方逐层递归兜底
  }

  const result = await workspaceApi.list(path)
  const files: WorkspaceNode[] = []
  const folderPaths: string[] = []

  for (const node of result.nodes) {
    if (node.kind === 'file') files.push(node)
    else if (node.kind === 'folder') folderPaths.push(node.path)
  }

  const childrenArrays = await Promise.all(
    folderPaths.map(async (p) => {
      try {
        return await listAllFiles(p)
      } catch (err) {
        rethrowIfChallenge(err)
        console.warn('[backendWorkspaceAdapter] 递归列出目录失败:', p, err)
        return [] as WorkspaceNode[]
      }
    })
  )
  for (const children of childrenArrays) files.push(...children)

  setCachedList(path, files)
  return files
}

export const backendWorkspaceAdapter: WorkspaceAdapter = {
  kind: 'backend',

  async readFile(path: string, options?: { fresh?: boolean }): Promise<FileEntry | undefined> {
    const normalized = normalizePath(path)
    if (!options?.fresh) {
      const cached = getCachedRead(normalized)
      if (cached) return cached
    }

    try {
      const response = await workspaceApi.read(normalized)
      if (!response) return undefined

      if (!response.isText || response.content === undefined) {
        const entry: FileEntry = {
          path: normalized,
          content: officePlaceholder(normalized, response.sizeBytes ?? 0),
          parentPath: getParentPath(normalized),
          createdAt: response.updatedAt || new Date().toISOString(),
          updatedAt: response.updatedAt || new Date().toISOString(),
          size: response.sizeBytes ?? 0,
          source: 'backend',
          mimeType: response.mimeType,
        }
        setCachedRead(normalized, entry)
        return entry
      }

      const entry: FileEntry = {
        path: normalized,
        content: response.content,
        parentPath: getParentPath(normalized),
        createdAt: response.updatedAt || new Date().toISOString(),
        updatedAt: response.updatedAt || new Date().toISOString(),
        size: response.sizeBytes ?? new Blob([response.content]).size,
        source: 'backend',
        mimeType: response.mimeType,
      }
      setCachedRead(normalized, entry)
      return entry
    } catch (err) {
      rethrowIfChallenge(err)
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
    let node: WorkspaceNode
    try {
      node = await workspaceApi.write(normalized, content, options?.append, options?.encoding)
    } catch (err) {
      rethrowIfChallenge(err)
      throw err
    }

    // base64 写入后端会解码为二进制，content 长度不等于实际字节数，用后端返回的 sizeBytes 更准
    const size =
      node.sizeBytes ??
      (options?.encoding === 'base64' ? Math.ceil(content.length * 0.75) : new Blob([content]).size)

    const entry: FileEntry = {
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

    // 缓存维护（网络写已完成，无竞态）：完整覆盖写顺手回填新内容——str_replace 写后复读零请求；
    // append 的 content 只是增量、base64 解码后是二进制，都不能回填，只失效
    invalidateAfterWrite(normalized)
    if (!options?.append && options?.encoding !== 'base64') {
      setCachedRead(normalized, entry)
    }

    return entry
  },

  async deleteFile(path: string): Promise<void> {
    const normalized = normalizePath(path)
    try {
      await workspaceApi.delete(normalized)
    } catch (err) {
      rethrowIfChallenge(err)
      throw err
    }
    invalidateAfterWrite(normalized)
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
    // 先查读正缓存：刚读过/写过的文件零请求判存在（缓存只存成功结果，命中即存在）
    if (getCachedRead(normalized)) return true
    try {
      await workspaceApi.read(normalized)
      return true
    } catch (err) {
      rethrowIfChallenge(err)
      return false
    }
  },

  async globFiles(pattern: string, basePath?: string): Promise<string[]> {
    const normalizedBase = basePath ? normalizePath(basePath) : '/workspace'

    // 服务端 glob（2026-09-01 P0-7）：登记根下"拉全量列表本地过滤"等于遍历整棵项目树；
    // 端点缺失（旧后端）/网络异常时回退前端"列举+本地过滤"，调用方无感
    try {
      const res = await workspaceApi.glob({ path: normalizedBase, pattern, maxResults: 2000 })
      return res.matches
    } catch (err) {
      rethrowIfChallenge(err)
      console.warn('[backendWorkspaceAdapter] 服务端 glob 不可用，回退前端列举过滤:', err)
    }

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
    // 正则先在前端实例化：语法错误在服务端/回退两通道的报错表现一致
    const regex = new RegExp(pattern, options?.caseInsensitive ? 'i' : '')

    // 优先服务端检索（2026-08-02 统一后端端点）：一次 HTTP 消灭"递归 list + 逐文件 read"的 N+1；
    // 端点缺失（旧后端）/网络异常时静默回退前端并发扫读，调用方无感
    try {
      const res = await workspaceApi.grep({
        path: basePath,
        pattern,
        glob: options?.glob,
        caseInsensitive: options?.caseInsensitive,
      })
      if (res.truncated) {
        console.warn('[backendWorkspaceAdapter] 服务端 grep 结果达上限被截断（matches=' + res.matches.length + '）')
      }
      return res.matches
    } catch (err) {
      rethrowIfChallenge(err)
      console.warn('[backendWorkspaceAdapter] 服务端 grep 不可用，回退前端并发扫读:', err)
    }

    // ---- 回退路径：前端并发扫读（worker-pool 8 路，原为逐文件串行 readFile = N+1 元凶） ----
    const all = await listAllFiles(basePath)
    const globRegex = options?.glob ? globToRegex(options.glob) : null
    const candidates = all.filter(
      (node) =>
        isTextFile(node.name) &&
        (!globRegex || globRegex.test(node.path.slice(basePath.length + 1)))
    )

    const GREP_WORKERS = 8 // 对齐浏览器每域 6 连接水位+留余量；读缓存命中时不占连接
    const perFile: Array<Array<{ path: string; line: number; content: string }>> = new Array(candidates.length)
    let cursor = 0

    const worker = async (): Promise<void> => {
      while (cursor < candidates.length) {
        const i = cursor++
        const node = candidates[i]
        try {
          const entry = await backendWorkspaceAdapter.readFile(node.path)
          if (!entry) continue
          const fileResults: Array<{ path: string; line: number; content: string }> = []
          const lines = entry.content.split('\n')
          for (let li = 0; li < lines.length; li++) {
            if (regex.test(lines[li])) {
              fileResults.push({ path: node.path, line: li + 1, content: lines[li].trim() })
            }
          }
          perFile[i] = fileResults
        } catch (err) {
          rethrowIfChallenge(err)
          console.warn('[backendWorkspaceAdapter] grep read failed:', node.path, err)
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(GREP_WORKERS, candidates.length) }, () => worker())
    )

    // 按候选文件顺序拼接，保持结果确定性（不随并发完成顺序漂移）
    const results: Array<{ path: string; line: number; content: string }> = []
    for (const fileResults of perFile) {
      if (fileResults) results.push(...fileResults)
    }
    return results
  },

  async getAllFiles(): Promise<FileEntry[]> {
    const nodes = await listAllFiles('/workspace')
    return nodes.map(nodeToFileEntry).sort((a, b) => a.path.localeCompare(b.path))
  },

  async scanWorkspaceFiles(): Promise<number> {
    // 后端是权威源，无需扫描本地目录
    return 0
  },

  clearCache(): void {
    // 2026-08-02：3s TTL 缓存就位后真正生效（此前为空实现"后端状态不缓存"）
    readCache.clear()
    listCache.clear()
  },
}

function globToRegex(pattern: string): RegExp {
  // 2026-08-02：先转义正则元字符再展开 glob 通配（此前 . 等会被当正则任意字符，与后端 GlobToRegex 语义对齐）
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const re = escaped
    .replace(/\*\*\//g, '{{GLOB_STAR}}')
    .replace(/\*\*/g, '{{GLOB_STAR_ALL}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/\{\{GLOB_STAR\}\}/g, '(?:.*/)?')
    .replace(/\{\{GLOB_STAR_ALL\}\}/g, '.*')

  return new RegExp(`^${re}$`, 'i')
}
