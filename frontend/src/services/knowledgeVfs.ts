import { useKnowledgeStore, knowledgeStoreReady } from '@/stores/knowledgeStore'
import type {
  KnowledgeCollection,
  KnowledgeDocumentSummary,
  KnowledgeSourceDomain,
} from '@/types/knowledge'
import { extractLiteralTerms, type CapabilityHitFile } from './capabilityFs'

/**
 * /knowledge 检索专用虚拟目录（2026-08-16，知识库 agent 流程融合第 2 步）
 *
 * 与 /capabilities（capabilityFs）同构的发现面：知识库挂载为
 * 只读虚拟目录，模型用已熟练的 grep/glob/list_files 原语浏览与检索——目录即地图：
 *
 *   /knowledge/<local|online>/<知识库段>/_index.md          集合元数据卡
 *   /knowledge/<local|online>/<知识库段>/documents/<文档段>.md 文档元数据卡
 *
 * 信息边界（守住渐进披露与信任域纪律）：
 * - 卡片只含元数据（名称/简介/类型/版本/标签/标题路径/来源），不含正文——grep 结果
 *   不会把资料原文灌进上下文；语义检索走 knowledge_search，正文精读走 knowledge_read
 *   （citation 钉版本 + Online ACL 重校验）。
 * - Online 域同样只物化元数据卡：ACL 保护的正文绝不落地为可直读文件。
 *
 * 数据流：knowledgeStore 是唯一事实源。集合清单由 ensurePromptWarm 预热（chatStore
 * 每条消息触发一次，幂等）；文档卡片按需物化——首次 grep/list 进入某集合目录时
 * ensureDocuments 拉取该集合摘要并缓存，UI 的增删/上传/导入刷新路径会同步刷新缓存，
 * 下一次检索自然看到新集合（启停即发现面）。
 *
 * 边界：只支持 grep / glob / list_files；read_file/写操作由 fileSystem/fileTools 拒绝
 * 并指回 knowledge_search/knowledge_read 正路（虚拟文件层对模型重述路径太脆弱的教训，
 * 见 capabilityFs 文件头）。
 */

export const KNOWLEDGE_ROOT = '/knowledge'

/** 单域文档物化的集合数上限：超出时根级检索只覆盖集合卡（卡片内提示用 knowledge_search 深检） */
const MAX_WARM_COLLECTIONS = 15

/** 判断路径是否落在 /knowledge 挂载点内 */
export function isKnowledgePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/')
  return normalized === KNOWLEDGE_ROOT || normalized.startsWith(KNOWLEDGE_ROOT + '/')
}

/** 路径段 sanitize：保留中文（grep 主战场），只压路径敌对字符与空白，附短 id 保唯一稳定 */
function pathSegment(name: string, id: string): string {
  const seg = name.trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '')
  return `${seg || 'untitled'}-${id.slice(0, 8)}`
}

export function knowledgeCollectionDir(domain: KnowledgeSourceDomain, c: KnowledgeCollection): string {
  return `${KNOWLEDGE_ROOT}/${domain}/${pathSegment(c.name, c.id)}`
}

function renderCollectionCard(c: KnowledgeCollection, domain: KnowledgeSourceDomain, docCount: number | null): string {
  const dir = knowledgeCollectionDir(domain, c)
  const lines = [
    `# ${c.name}（${c.id.slice(0, 8)}）`,
    '',
    c.description?.trim() || '（无简介）',
    '',
    `- 集合: ${c.id}`,
    `- 域: ${domain === 'local' ? '本地' : '企业'}`,
    `- 文档数: ${docCount ?? '未加载'}`,
    `- 更新: ${c.updatedAt}`,
    '',
    '---',
    '',
    `检索：knowledge_search(query, collection_id="${c.id}") 在本库内语义检索（延迟加载工具，先 read_capability("knowledge_search") 加载）。`,
    `浏览：list_files("${dir}/documents") 或 grep 该目录定位文档卡片；卡片只有元数据，正文精读走 knowledge_read。`,
  ]
  return lines.join('\n')
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function renderDocumentCard(d: KnowledgeDocumentSummary, c: KnowledgeCollection, domain: KnowledgeSourceDomain): string {
  const lines = [
    `# ${d.title}（${d.id.slice(0, 8)}）`,
    '',
    `- 文档: ${d.id}`,
    `- 知识库: ${c.name}（id: ${c.id.slice(0, 8)}）`,
    `- 域: ${domain === 'local' ? '本地' : '企业'}`,
    `- 类型: ${d.mimeType}`,
    `- 版本: r${d.currentRevision}`,
    `- 来源: ${d.sourceLocator}`,
    `- 大小: ${formatBytes(d.byteLength)}`,
    `- 片段数: ${d.chunkCount}`,
  ]
  if (d.tags.length > 0) lines.push(`- 标签: ${d.tags.join('、')}`)
  if (d.headingPaths.length > 0) {
    const joined = d.headingPaths.join(' / ')
    lines.push(`- 标题路径: ${joined.length > 200 ? joined.slice(0, 199) + '…' : joined}`)
  }
  lines.push(
    `- 更新: ${d.updatedAt}`,
    '',
    '---',
    '',
    `精读：knowledge_read(documentId="${d.id}", revision=${d.currentRevision}) 回读原文（先 read_capability("knowledge_read") 加载）；语义检索用 knowledge_search。`,
  )
  return lines.join('\n')
}

interface KnowledgeIndex {
  files: Map<string, string>
  directories: Set<string>
}

/** 从 knowledgeStore 同步派生物化面：只含元数据卡片，不含正文 */
function deriveIndex(): KnowledgeIndex {
  const state = useKnowledgeStore.getState()
  const files = new Map<string, string>()
  const directories = new Set<string>([KNOWLEDGE_ROOT])
  if (!state.capabilities?.enabled) return { files, directories }

  const byDomain: Array<[KnowledgeSourceDomain, KnowledgeCollection[]]> = [
    ['local', state.collections.local],
    ...(state.capabilities.onlineAvailable
      ? [['online', state.collections.online] as [KnowledgeSourceDomain, KnowledgeCollection[]]]
      : []),
  ]
  for (const [domain, collections] of byDomain) {
    directories.add(`${KNOWLEDGE_ROOT}/${domain}`)
    for (const c of collections) {
      const dir = knowledgeCollectionDir(domain, c)
      const docs = state.documentsByCollection[c.id]
      directories.add(dir)
      directories.add(`${dir}/documents`)
      files.set(`${dir}/_index.md`, renderCollectionCard(c, domain, docs?.length ?? null))
      for (const d of docs ?? []) {
        files.set(`${dir}/documents/${pathSegment(d.title, d.id)}.md`, renderDocumentCard(d, c, domain))
      }
    }
  }
  return { files, directories }
}

function normalizeVirtualPath(path: string): string {
  let normalized = path.trim().replace(/\\/g, '/').replace(/\/+/g, '/')
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  return normalized
}

/** 简化 glob → RegExp（** 跨目录，* 单段，? 单字符），与 capabilityFs 语义一致 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/ /g, '.*')
  return new RegExp(`^${escaped}$`)
}

/** 结构性行（标题/全文 id/加载指令）：标识符刻意重复处，作代表行信息量少 */
function isStructuralLine(line: string): boolean {
  const t = line.trim()
  return (
    t.startsWith('# ') ||
    t.startsWith('- 文档') ||
    t.startsWith('- 集合') ||
    t.startsWith('检索：') ||
    t.startsWith('精读：') ||
    t.startsWith('浏览：') ||
    t === '---'
  )
}

/** 预热：确保清单可用，并按需物化 scope 内各集合的文档卡片（有界、去重、失败静默） */
async function warmScope(scope: string): Promise<void> {
  const store = useKnowledgeStore.getState()
  store.ensurePromptWarm()
  await knowledgeStoreReady()
  const state = useKnowledgeStore.getState()
  if (!state.capabilities?.enabled) return

  const seg = scope === KNOWLEDGE_ROOT ? [] : scope.slice(KNOWLEDGE_ROOT.length + 1).split('/')
  const scopeDomain = seg[0] === 'local' || seg[0] === 'online' ? (seg[0] as KnowledgeSourceDomain) : null
  const scopeCollectionSeg = seg.length >= 2 ? seg[1] : null

  const targets: Array<{ c: KnowledgeCollection; domain: KnowledgeSourceDomain }> = []
  const pushDomain = (domain: KnowledgeSourceDomain, collections: KnowledgeCollection[]) => {
    for (const c of collections) {
      if (scopeCollectionSeg && pathSegment(c.name, c.id) !== scopeCollectionSeg) continue
      targets.push({ c, domain })
    }
  }
  if (!scopeDomain || scopeDomain === 'local') pushDomain('local', state.collections.local)
  if (state.capabilities.onlineAvailable && (!scopeDomain || scopeDomain === 'online')) {
    pushDomain('online', state.collections.online)
  }
  await Promise.all(
    targets.slice(0, MAX_WARM_COLLECTIONS).map((t) => store.ensureDocuments(t.c.id, t.domain))
  )
}

export const knowledgeVfs = {
  async listFiles(
    path: string,
    options?: { recursive?: boolean }
  ): Promise<{ files: string[]; directories: string[] }> {
    const normalized = normalizeVirtualPath(path) || KNOWLEDGE_ROOT
    // 递归列举才需要文档卡片；非递归根/域级列表只需集合目录（零额外请求）
    if (options?.recursive || normalized.split('/').length >= 4) await warmScope(normalized)
    else {
      useKnowledgeStore.getState().ensurePromptWarm()
      await knowledgeStoreReady()
    }
    const index = deriveIndex()
    const prefix = normalized === KNOWLEDGE_ROOT ? KNOWLEDGE_ROOT + '/' : normalized + '/'
    const recursive = options?.recursive ?? false

    const files: string[] = []
    const directories: string[] = []
    for (const filePath of index.files.keys()) {
      if (!filePath.startsWith(prefix)) continue
      const rest = filePath.slice(prefix.length)
      if (recursive || !rest.includes('/')) files.push(filePath)
    }
    for (const dirPath of index.directories) {
      if (dirPath === normalized || !dirPath.startsWith(prefix)) continue
      const rest = dirPath.slice(prefix.length)
      if (recursive || !rest.includes('/')) directories.push(dirPath)
    }
    return { files: files.sort(), directories: directories.sort() }
  },

  async globFiles(pattern: string, basePath?: string): Promise<string[]> {
    const base = basePath ? normalizeVirtualPath(basePath) : KNOWLEDGE_ROOT
    await warmScope(base)
    const index = deriveIndex()
    const fullPattern = pattern.startsWith('/') ? pattern : `${base}/${pattern}`
    const regex = globToRegExp(normalizeVirtualPath(fullPattern))
    return Array.from(index.files.keys()).filter((p) => regex.test(p)).sort()
  },

  async grepFiles(
    pattern: string,
    options?: { path?: string; glob?: string; caseInsensitive?: boolean }
  ): Promise<{
    matches: Array<{ path: string; line: number; content: string }>
    total: number
    fileCount: number
    hitFiles: CapabilityHitFile[]
  }> {
    const scope = options?.path ? normalizeVirtualPath(options.path) : KNOWLEDGE_ROOT
    await warmScope(scope)
    const index = deriveIndex()

    const flags = options?.caseInsensitive === false ? '' : 'i'
    let lineRegex: RegExp
    let fileRegex: RegExp
    try {
      lineRegex = new RegExp(pattern, flags)
      // 文件级匹配（dotall）：发现语义的单位是「卡片=文件」，组合 pattern 可跨行命中
      fileRegex = new RegExp(pattern, flags + 's')
    } catch {
      const lit = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      lineRegex = new RegExp(lit, flags)
      fileRegex = new RegExp(lit, flags + 's')
    }
    const literalTerms = extractLiteralTerms(pattern)

    const scopePrefix = scope === KNOWLEDGE_ROOT ? KNOWLEDGE_ROOT + '/' : scope + '/'
    const globRegex = options?.glob ? globToRegExp(options.glob) : null

    const matches: Array<{ path: string; line: number; content: string }> = []
    const byFile = new Map<string, { hits: number; repr: string; reprIsStructural: boolean }>()
    let total = 0
    let fileCount = 0
    const MAX_RESULTS = 200
    for (const [filePath, content] of index.files) {
      if (!filePath.startsWith(scopePrefix) && filePath !== scope) continue
      if (globRegex) {
        const rel = filePath.startsWith(scopePrefix) ? filePath.slice(scopePrefix.length) : filePath
        const base = filePath.slice(filePath.lastIndexOf('/') + 1)
        if (!globRegex.test(rel) && !globRegex.test(base) && !globRegex.test(filePath)) continue
      }
      fileCount++
      if (!fileRegex.test(content)) continue
      const lines = content.split('\n')
      let fileHits = 0
      let repr = ''
      let reprIsStructural = true
      for (let i = 0; i < lines.length; i++) {
        if (lineRegex.test(lines[i])) {
          fileHits++
          total++
          if (matches.length < MAX_RESULTS) {
            matches.push({ path: filePath, line: i + 1, content: lines[i] })
          }
          if (!repr) repr = lines[i]
          if (reprIsStructural && !isStructuralLine(lines[i])) {
            repr = lines[i]
            reprIsStructural = false
          }
        }
      }
      // 跨行命中：用 literal 词定位代表行并计数（与 capabilityFs 同法）
      if (fileHits === 0 && literalTerms.length > 0) {
        const lowerTerms = literalTerms.map((t) => t.toLowerCase())
        for (const line of lines) {
          const lower = line.toLowerCase()
          if (lowerTerms.some((t) => lower.includes(t))) {
            fileHits++
            total++
            if (!repr) repr = line
            if (reprIsStructural && !isStructuralLine(line)) {
              repr = line
              reprIsStructural = false
            }
          }
        }
      }
      if (!repr) repr = lines.find((l) => !isStructuralLine(l) && l.trim()) || lines[0] || ''
      byFile.set(filePath, { hits: fileHits, repr, reprIsStructural })
    }
    const hitFiles = Array.from(byFile.entries())
      .map(([path, e]) => ({ path, hits: e.hits, repr: e.repr.trim().slice(0, 120) }))
      .sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path))
    return { matches, total, fileCount, hitFiles }
  },
}
