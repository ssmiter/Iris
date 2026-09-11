import { toolApi } from '@/api/client'
import { webBridgeClient } from '@/api/webbridgeClient'
import { isLocalRuntime } from '@/utils/runtimeMode'
import type { ToolCatalogItem } from '@/types/mescli'

/**
 * /capabilities 检索专用虚拟目录（v1.6）
 *
 * 设计动机：能力发现复用文件系统抽象中的「检索」半套——模型已熟练使用 grep/glob/list_files，
 * 把能力目录挂载为虚拟目录后，发现即「全文检索定位 → read_capability 加载」，
 * 替代低效的关键词 tool_search 与多轮 list_capabilities 目录下探。
 *
 * 边界（重要）：本目录**只支持 grep / glob / list_files 检索**，不支持 read_file/写操作
 * （fileTools.validatePath 直接拒绝并指回正路）。能力 .md 文件仅供检索定位，
 * 加载统一走 read_capability——后端 schema 查找大小写不敏感、按域 fail-close，
 * 比前端虚拟文件查找更宽容，是唯一的加载入口。
 *
 * 能力文件信息模型（可搜索内容设计）：
 * grep 按行命中，所以文件的每一行都按「搜索词 → 辨识度」设计：
 * - 标题行 `# 工具名`：英文标识符搜索（如 grep "sql"）命中；
 * - 描述段：中文业务描述全文（language=zh），是中文业务词搜索（如 grep "硫化"）的主战场；
 * - 元数据行 `- 键: 值`：路径/分类/操作/风险/层级/实体/标签/域/审批，键值格式让命中行
 *   自身就有信息量（grep "write" 命中 `- 操作: write` 即知是写工具）；
 * - 实体行（affectedEntityTypes，如「工单、设备」）是业务对象搜索的金矿；
 * - 末尾行动行：read_capability 加载指令（路径原样可复制）。
 *
 * 关键约束：
 * - 域隔离（fail-close）：索引按当前登录 systemCode 拉取并以 systemCode 为缓存键；
 *   登录/切域后 systemCode 变化 → 自动重拉，绝不跨域合并或泄露其他域工具。
 * - 不含参数 schema（体积大且按需）：schema 由 read_capability 走后端 schema 端点单读。
 * - 会话级缓存：每个域拉取一次；刷新靠域切换自动失效或 invalidateCapabilityIndex()。
 */

export const CAPABILITIES_ROOT = '/capabilities'

interface CapabilityIndex {
  /** 缓存键 = 生效 systemCode（域切换即失效重拉，保证不跨域） */
  systemCode: string
  /** 虚拟文件路径 → markdown 内容 */
  files: Map<string, string>
  /** 全部目录（含根），供 list_files / glob 使用 */
  directories: Set<string>
}

let cachedIndex: CapabilityIndex | null = null
let inflightIndex: Promise<CapabilityIndex> | null = null
/** 失效代际：invalidate 后递增，在途请求完成时凭此识别自己是旧快照（不得回写缓存，C2） */
let indexGeneration = 0

/**
 * 生效 systemCode：与 chatStore 工具创建同源（chatStore.ts:1097）。
 * local 运行时必须传 'local'——后端 DomainCatalog.ResolveEffectiveSystemCode 对 local 身份
 * 采用客户端参数，若误传 'ykhm' 默认值会把 local 匿名用户导向企业域目录（越域）。
 * 域身份登录时后端以身份为准（fail-close），前端参数仅作缓存键。
 */
function currentSystemCode(): string {
  if (isLocalRuntime()) return 'local'
  return localStorage.getItem('wonclaw_system_code') || 'ykhm'
}

/** 显式失效（登录/登出/切域时也可依赖键失配自动重拉，此为兜底） */
export function invalidateCapabilityIndex(): void {
  cachedIndex = null
  // 在途请求一并作废：只清 cachedIndex 会让失效前发出的 /all 响应在完成后
  // 重新写回缓存（旧快照回魂，C2——装/删 MCP server 后 grep 命中旧目录）
  inflightIndex = null
  indexGeneration++
}

/** 判断路径是否落在 /capabilities 挂载点内 */
export function isCapabilityPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/')
  return normalized === CAPABILITIES_ROOT || normalized.startsWith(CAPABILITIES_ROOT + '/')
}

/** WebBridge 原语在 list_capabilities 中的合成条目（与 capabilityDiscoveryTools 保持一致） */
const WEBBRIDGE_ENTRIES: Array<{ path: string; name: string; description: string }> = [
  { path: '/webbridge/navigate', name: 'webbridge_navigate', description: '导航到指定 URL' },
  { path: '/webbridge/screenshot', name: 'webbridge_screenshot', description: '截取当前页面' },
  { path: '/webbridge/extract', name: 'webbridge_extract', description: '提取页面文本/HTML/表格' },
  { path: '/webbridge/locate', name: 'webbridge_locate', description: '按自然语言定位页面元素' },
  { path: '/webbridge/click', name: 'webbridge_click', description: '点击页面元素' },
  { path: '/webbridge/type', name: 'webbridge_type', description: '在输入框中输入文本' },
  { path: '/webbridge/scroll', name: 'webbridge_scroll', description: '滚动页面' },
  { path: '/webbridge/wait', name: 'webbridge_wait', description: '等待时间或元素' },
]

const OPERATION_TYPE_LABELS: Record<string, string> = {
  read: 'read（只读）',
  write: 'write（写操作）',
  mixed: 'mixed（读写混合）',
}

function renderCapabilityMarkdown(item: ToolCatalogItem): string {
  const lines: string[] = [
    `# ${item.name}`,
    '',
    item.description || '（无描述）',
    '',
  ]
  // 元数据行：键值格式让 grep 命中行自身有信息量；空字段不输出，保持文件紧凑
  if (item.path) lines.push(`- 路径: ${item.path}`)
  if (item.category) lines.push(`- 分类: ${item.category}`)
  if (item.operationType) {
    lines.push(`- 操作: ${OPERATION_TYPE_LABELS[item.operationType] ?? item.operationType}`)
  }
  if (item.riskLevel) lines.push(`- 风险: ${item.riskLevel}`)
  if (item.tier) lines.push(`- 层级: ${item.tier}`)
  if (item.affectedEntityTypes?.length) lines.push(`- 实体: ${item.affectedEntityTypes.join('、')}`)
  if (item.tags?.length) lines.push(`- 标签: ${item.tags.join('、')}`)
  if (item.scopes?.length) lines.push(`- 域: ${item.scopes.join('、')}`)
  if (item.requiresApproval) lines.push('- 审批: 调用前需要用户审批')
  lines.push(
    '',
    '---',
    '',
    `加载：read_capability("${item.path}") 读取完整参数 schema 后该工具即可直接调用。`
  )
  return lines.join('\n')
}

function buildIndex(systemCode: string, items: ToolCatalogItem[]): CapabilityIndex {
  const files = new Map<string, string>()
  const directories = new Set<string>([CAPABILITIES_ROOT])

  const addFile = (virtualPath: string, content: string) => {
    files.set(virtualPath, content)
    // 登记所有祖先目录
    let dir = virtualPath.slice(0, virtualPath.lastIndexOf('/'))
    while (dir.length >= CAPABILITIES_ROOT.length && dir.startsWith(CAPABILITIES_ROOT)) {
      directories.add(dir)
      const parent = dir.slice(0, dir.lastIndexOf('/'))
      if (parent === dir || parent.length < CAPABILITIES_ROOT.length) break
      dir = parent
    }
  }

  for (const item of items) {
    if (!item.path) continue
    // 语料语义 = "未加载、可通过发现获取的能力"。alwaysLoad 工具已在模型上下文中，
    // 无需被发现（grep 到它只会诱导多余的 read_capability 往返），统一不入语料。
    // 此过滤对 /all 与 prime 两个数据通道同时生效（都经 buildIndex）。
    if (item.alwaysLoad) continue
    const normalized = item.path.startsWith('/') ? item.path : `/${item.path}`
    addFile(`${CAPABILITIES_ROOT}${normalized}.md`, renderCapabilityMarkdown(item))
  }

  // WebBridge 前端原语不入后端目录，连接时手动补充（与 list_capabilities 行为一致）
  if (webBridgeClient.isConnected) {
    for (const entry of WEBBRIDGE_ENTRIES) {
      addFile(
        `${CAPABILITIES_ROOT}${entry.path}.md`,
        [
          `# ${entry.name}`,
          '',
          entry.description,
          '',
          '- 分类: 浏览器自动化（WebBridge）',
          `- 路径: ${entry.path}`,
          '',
          '---',
          '',
          `加载：read_capability("${entry.path}") 读取完整参数 schema 后该工具即可直接调用。`,
        ].join('\n')
      )
    }
  }

  return { systemCode, files, directories }
}

/**
 * 确保索引就绪。缓存键 = 当前生效 systemCode：
 * 登录/切域后键失配自动重拉，保证结果永远不跨域（fail-close）。
 * 并发调用共享同一 in-flight 请求。
 */
async function ensureIndex(): Promise<CapabilityIndex> {
  const key = currentSystemCode()
  if (cachedIndex && cachedIndex.systemCode === key) return cachedIndex
  if (inflightIndex) {
    const awaitGeneration = indexGeneration
    const index = await inflightIndex
    // in-flight 完成后域可能已切换，键失配则重新拉取
    if (index.systemCode === key && awaitGeneration === indexGeneration) return index
    // 等待期间发生过 invalidate：拿到的是旧快照，丢弃并落到下方重拉
  }

  const startedAt = performance.now()
  const generation = indexGeneration
  const request = toolApi
    .all(key)
    .then((items) => {
      console.debug(`[capabilityFs] 索引拉取完成：${items.length} 项，耗时 ${Math.round(performance.now() - startedAt)}ms（域 ${key}）`)
      return buildIndex(key, items)
    })
    .then((index) => {
      // 代际守卫：失效后在途完成的旧快照不得回写缓存（调用方拿到返回值可用，但不进缓存）
      if (generation === indexGeneration) cachedIndex = index
      return index
    })
    .finally(() => {
      if (generation === indexGeneration) inflightIndex = null
    })
  inflightIndex = request
  return request
}

/**
 * 预热索引（fire-and-forget）：在会话建立工具注册时调用，
 * 让首次 grep /capabilities 直接命中内存缓存，避免模型工具调用干等网络往返。
 */
export function warmCapabilityIndex(): void {
  ensureIndex().catch((err) => {
    console.warn('[capabilityFs] 索引预热失败（首次检索时会重试）:', err)
  })
}

/**
 * 用已拉取的目录数据直接播种索引：chatStore 建会话时已经拉过 capabilitiesFull
 * （同为 BuildCatalogItem 产物、含 path），同一份数据直接复用，
 * 消除「capabilitiesFull 给注册表 + /all 给检索」双通道重复拉取与双缓存不一致风险。
 * 仅当键匹配且当前无缓存/无在途请求时生效。
 */
export function primeCapabilityIndex(systemCode: string, items: ToolCatalogItem[]): void {
  const key = currentSystemCode()
  if (key !== systemCode) return
  if (cachedIndex && cachedIndex.systemCode === key) return
  if (inflightIndex) return
  cachedIndex = buildIndex(systemCode, items)
}

function normalizeVirtualPath(path: string): string {
  let normalized = path.trim().replace(/\\/g, '/').replace(/\/+/g, '/')
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  return normalized
}

/** 简化 glob → RegExp（** 跨目录，* 单段，? 单字符），与 workspace 适配器语义一致 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/ /g, '.*')
  return new RegExp(`^${escaped}$`)
}

/** 结构性行（标题/路径/加载指令）：标识符刻意重复处，作代表行信息量少 */
function isStructuralLine(line: string): boolean {
  const t = line.trim()
  return t.startsWith('# ') || t.startsWith('- 路径') || t.startsWith('加载：') || t === '---'
}

/**
 * 从正则 pattern 中提取 literal 词（去正则语法）。
 * 用途：①文件级跨行命中时找代表行；②0 命中时按单词统计命中分布反馈给模型。
 */
export function extractLiteralTerms(pattern: string): string[] {
  const raw = pattern.split(/[.*+?^${}()|[\]\\]+/)
  const seen = new Set<string>()
  for (const t of raw) {
    const term = t.trim()
    if (!term) continue
    // 拉丁词至少 2 字符（滤掉正则残渣），CJK 单字即有效
    if (!/[一-鿿]/.test(term) && term.length < 2) continue
    seen.add(term)
  }
  return Array.from(seen)
}

/** grep 单文件聚合结果 */
export interface CapabilityHitFile {
  path: string
  /** 该文件内命中行数 */
  hits: number
  /** 代表命中行（优先非结构性行，截断至 120 字符） */
  repr: string
}

export const capabilityFs = {
  async listFiles(
    path: string,
    options?: { recursive?: boolean }
  ): Promise<{ files: string[]; directories: string[] }> {
    const index = await ensureIndex()
    const normalized = normalizeVirtualPath(path) || CAPABILITIES_ROOT
    const prefix = normalized === CAPABILITIES_ROOT ? CAPABILITIES_ROOT + '/' : normalized + '/'
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
    const index = await ensureIndex()
    const base = basePath ? normalizeVirtualPath(basePath) : CAPABILITIES_ROOT
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
    const index = await ensureIndex()
    const startedAt = performance.now()
    const flags = options?.caseInsensitive === false ? '' : 'i'
    let lineRegex: RegExp
    let fileRegex: RegExp
    try {
      lineRegex = new RegExp(pattern, flags)
      // 文件级匹配（dotall）：发现语义的单位是「工具=文件」，组合 pattern（A.*B 等）
      // 对整个文件求值可跨行命中——对齐模型心智，消掉行级语义差距
      fileRegex = new RegExp(pattern, flags + 's')
    } catch {
      // 非法正则退化为字面量搜索
      const lit = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      lineRegex = new RegExp(lit, flags)
      fileRegex = new RegExp(lit, flags + 's')
    }
    const literalTerms = extractLiteralTerms(pattern)

    const scope = options?.path ? normalizeVirtualPath(options.path) : CAPABILITIES_ROOT
    const scopePrefix = scope === CAPABILITIES_ROOT ? CAPABILITIES_ROOT + '/' : scope + '/'
    const globRegex = options?.glob ? globToRegExp(options.glob) : null

    const matches: Array<{ path: string; line: number; content: string }> = []
    // 按文件聚合：发现阶段模型要的是候选工具清单而非行碎片——
    // 标识符在标题/路径行/加载指令中刻意重复，行级计数会 3-5 倍放大感知。
    // 聚合基于全部命中（不受 matches 的 200 上限影响）。
    const byFile = new Map<string, { hits: number; repr: string; reprIsStructural: boolean }>()
    let total = 0
    let fileCount = 0
    const MAX_RESULTS = 200
    for (const [filePath, content] of index.files) {
      if (!filePath.startsWith(scopePrefix) && filePath !== scope) continue
      if (globRegex) {
        // glob 语义与 workspace 适配器对齐：对相对路径/文件名匹配。
        // 否则 "*.md" 这类常见写法因 ^ 锚定在全路径上永远 0 命中（伪"没有结果"）
        const rel = filePath.startsWith(scopePrefix) ? filePath.slice(scopePrefix.length) : filePath
        const base = filePath.slice(filePath.lastIndexOf('/') + 1)
        if (!globRegex.test(rel) && !globRegex.test(base) && !globRegex.test(filePath)) continue
      }
      fileCount++
      // 文件级判定：整个能力文件是一次匹配单位（组合条件可跨行）
      if (!fileRegex.test(content)) continue
      const lines = content.split('\n')
      let fileHits = 0
      let repr = ''
      let reprIsStructural = true
      // 行级统计与展示：命中行数、代表行仍按行给信息
      for (let i = 0; i < lines.length; i++) {
        if (lineRegex.test(lines[i])) {
          fileHits++
          total++
          // 达到上限后继续扫描计数（保证 total 与聚合完整），但不再收集行级明细
          if (matches.length < MAX_RESULTS) {
            matches.push({ path: filePath, line: i + 1, content: lines[i] })
          }
          if (!repr) repr = lines[i]
          // 代表行优先取非结构性命中（描述/元数据），标题/路径行/加载指令信息量少
          if (reprIsStructural && !isStructuralLine(lines[i])) {
            repr = lines[i]
            reprIsStructural = false
          }
        }
      }
      // 跨行命中（文件级中、行级无）：用 literal 词定位代表行并计数
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
    // 命中密度排序（标题/描述/实体都命中的更相关），同密度按路径稳定
    const hitFiles = Array.from(byFile.entries())
      .map(([path, e]) => ({ path, hits: e.hits, repr: e.repr.trim().slice(0, 120) }))
      .sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path))
    console.debug(
      `[capabilityFs] grep "${pattern}": ${total} 行命中 / ${hitFiles.length} 个文件（返回行级 ${matches.length}），` +
      `扫描 ${fileCount} 个能力文件，耗时 ${Math.round(performance.now() - startedAt)}ms`
    )
    return { matches, total, fileCount, hitFiles }
  },
}
