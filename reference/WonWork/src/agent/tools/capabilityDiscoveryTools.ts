import type { Tool } from '@/agent/types'
import type {
  CapabilityTreeResponse,
  CapabilitySchemaResponse,
  ToolDefinition,
} from '@/types/mescli'
import { toolApi } from '@/api/client'
import type { FrontendToolRegistry } from '@/agent/toolRegistry'
import { webBridgeClient } from '@/api/webbridgeClient'

/**
 * 文件系统式能力发现原语（v1.5）
 *
 * 替代低效的 keyword-based tool_search：
 * - list_capabilities(path) 像 ls 一样列出目录与工具入口
 * - read_capability(path) 像 cat 一样读取单个工具的完整 schema
 *
 * 发现后的工具名会被加入 sessionToolStore，供后续轮次自动注入上下文。
 */

export const LIST_CAPABILITIES_TOOL_NAME = 'list_capabilities'
export const READ_CAPABILITY_TOOL_NAME = 'read_capability'

interface ListCapabilitiesInput {
  /** 要浏览的路径，默认 "/" */
  path?: string
}

interface ReadCapabilityInput {
  /** 工具完整路径，例如 "/code/sql" */
  path: string
}

interface ListCapabilitiesOutput {
  path: string
  text: string
  nodes: CapabilityTreeResponse['nodes']
  note?: string
}

interface ReadCapabilityOutput {
  path: string
  name: string
  description: string
  parameters?: unknown
  schemaText: string
  /** 目录误读时直接承载给模型的引导文本（extractOutputText 优先取 content，避免模型看到 JSON 包装） */
  content?: string
}

export interface CapabilityDiscoveryOptions {
  systemCode?: string
  /** 前端工具镜像，read_capability 成功后会将工具注册进去 */
  registry?: FrontendToolRegistry
  /**
   * 注册前过滤（explore 子 Agent 只读场景）：返回 false 时不注册该工具，
   * 并给模型返回"未加载"的引导文本而非 schema——防止写工具经发现通道进入只读环境。
   */
  acceptTool?: (schema: CapabilitySchemaResponse) => boolean
  /**
   * 是否在目录中展示 /webbridge 域（默认 true）。只读子 Agent 环境传 false：
   * 浏览器写原语本就不注册进子注册表，列出来只会诱导空转加载。
   */
  includeWebBridge?: boolean
}

function normalizePath(path?: string): string {
  if (!path || path.trim().length === 0) return '/'
  let normalized = path.trim().replace(/\\/g, '/')
  if (!normalized.startsWith('/')) normalized = '/' + normalized
  normalized = normalized.replace(/\/+/g, '/')
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  // 容错：grep 结果展示的是 /capabilities 命名空间下的 .md 文件路径，
  // 本目录的规范路径没有这两层包装——剥掉再路由，避免模型照抄展示路径三次空转
  // （2026-08-14 模具状态对话实测：模型带前缀 read_capability 连错 3 次才自行剥正）
  if (normalized === '/capabilities') normalized = '/'
  else if (normalized.startsWith('/capabilities/')) {
    normalized = normalized.slice('/capabilities'.length)
  }
  if (normalized.toLowerCase().endsWith('.md')) {
    normalized = normalized.slice(0, -3)
  }
  return normalized
}

function isWebBridgeAvailable(): boolean {
  return webBridgeClient.isConnected
}

const WEBBRIDGE_DOMAIN = '/webbridge'

interface WebBridgeCapabilityEntry {
  path: string
  name: string
  description: string
}

const WEBBRIDGE_CAPABILITY_ENTRIES: WebBridgeCapabilityEntry[] = [
  { path: '/webbridge/navigate', name: 'webbridge_navigate', description: '导航到指定 URL' },
  { path: '/webbridge/screenshot', name: 'webbridge_screenshot', description: '截取当前页面' },
  { path: '/webbridge/extract', name: 'webbridge_extract', description: '提取页面文本/HTML/表格' },
  { path: '/webbridge/locate', name: 'webbridge_locate', description: '按自然语言定位页面元素' },
  { path: '/webbridge/click', name: 'webbridge_click', description: '点击页面元素' },
  { path: '/webbridge/type', name: 'webbridge_type', description: '在输入框中输入文本' },
  { path: '/webbridge/scroll', name: 'webbridge_scroll', description: '滚动页面' },
  { path: '/webbridge/wait', name: 'webbridge_wait', description: '等待时间或元素' },
]

function buildWebBridgeCapabilityGuide(path: string, tool: Tool): string {
  const schema = JSON.stringify(tool.inputSchema ?? {}, null, 2)
  return `已读取能力 ${path}（实际工具名：${tool.name}）：

描述：${tool.description}

参数 schema：
\`\`\`json
${schema}
\`\`\`

### 使用说明

WebBridge 原语用于浏览器自动化。推荐按 Sense-Act-Verify 模式组合调用：
- Sense：webbridge_navigate / webbridge_screenshot / webbridge_extract / webbridge_locate
- Act：webbridge_click / webbridge_type / webbridge_scroll / webbridge_wait
- Verify：每次 Act 后用 webbridge_screenshot 或 webbridge_extract 验证结果

不确定元素选择器时，优先用自然语言 \`target\` 参数调用 webbridge_click / webbridge_type，系统会内部定位；仍不确定时先用 webbridge_locate。


现在你可以直接调用工具 ${tool.name}。`
}

function findWebBridgeCapabilityEntry(path: string): WebBridgeCapabilityEntry | undefined {
  return WEBBRIDGE_CAPABILITY_ENTRIES.find((e) => e.path === path)
}

function formatTreeNode(node: CapabilityTreeResponse['nodes'][number]): string {
  const kindLabel = node.kind === 'folder' ? '📁' : '🔧'
  let hint = ''
  if (node.kind === 'folder') {
    const children = node.children ?? []
    const toolCount = node.toolCount ?? 0
    // 大目录只给统计，不罗列全部名字：让模型按需 list_capabilities 进入，
    // 避免一次把几十上百个工具名灌进上下文（按需加载，不多不少）。
    if (children.length > 0 && children.length <= 12) {
      hint = ` [包含: ${children.join(', ')}]`
    } else if (toolCount > 0 || children.length > 0) {
      const parts: string[] = []
      if (toolCount > 0) parts.push(`${toolCount} 个工具`)
      const subCount = children.length - toolCount
      if (subCount > 0) parts.push(`${subCount} 个子目录`)
      hint = ` [共 ${parts.join('、') || `${children.length} 项`}，用 list_capabilities("${node.path}") 进入查看]`
    }
  }
  return `${kindLabel} ${node.path}${hint}\n   ${node.description}`
}

export function formatListCapabilitiesResult(output: ListCapabilitiesOutput): string {
  if (output.nodes.length === 0) {
    return `${output.path} 下没有可发现的能力。${output.note ? '\n' + output.note : ''}`
  }

  const lines: string[] = [
    `路径 ${output.path} 下发现以下内容：`,
    '',
    ...output.nodes.map(formatTreeNode),
  ]

  if (output.note) {
    lines.push('', `提示：${output.note}`)
  }

  lines.push('', '如需使用某工具，请先调用 read_capability("<path>") 读取其完整 schema，然后再调用该工具。')
  return lines.join('\n')
}

export function formatReadCapabilityResult(output: ReadCapabilityOutput): string {
  const lines: string[] = [
    `已读取能力 ${output.path}（实际工具名：${output.name}）：`,
    '',
    `描述：${output.description}`,
    '',
    '参数 schema：',
    '```json',
    typeof output.parameters === 'string'
      ? output.parameters
      : JSON.stringify(output.parameters ?? {}, null, 2),
    '```',
    '',
    `现在你可以直接调用工具 ${output.name}。`,
  ]
  return lines.join('\n')
}

/**
 * 从 read_capability 的结果文本中提取实际工具名。
 */
export function extractDiscoveredNameFromReadCapability(resultText: string): string | null {
  const match = /实际工具名[:：]\s*([^\s)]+)/.exec(resultText)
  return match?.[1]?.trim().toLowerCase() || null
}

export function createListCapabilitiesTool(
  options: CapabilityDiscoveryOptions = {}
): Tool<ListCapabilitiesInput, ListCapabilitiesOutput> {
  const { systemCode: defaultSystemCode, includeWebBridge = true } = options

  return {
    name: LIST_CAPABILITIES_TOOL_NAME,
    description:
      '文件系统式能力浏览原语。像 `ls` 一样列出指定路径下的目录和工具入口。' +
      '能力目录按工厂工序/业务对象分层组织（工序顺序对应真实业务流转），浏览它可以建立全景：' +
      '某环节有哪些工具、上下游在哪——跨工序的链状问题尤其需要先从这里入手；' +
      '词面明确的点状查找用 grep(path="/capabilities") 全文检索更快。' +
      '建议先从 "/" 开始，看到顶层域后再深入。目录名可见，但工具 schema 需要通过 read_capability 单独读取。',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '要浏览的路径，例如 "/"、"/code"，默认 "/"',
          default: '/',
        },
      },
    },
    riskLevel: 'read_only',
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    alwaysLoad: true,
    maxResultSizeChars: 20000,
    execute: async (input: ListCapabilitiesInput): Promise<ListCapabilitiesOutput> => {
      const path = normalizePath(input.path)

      if (includeWebBridge && isWebBridgeAvailable() && path === WEBBRIDGE_DOMAIN) {
        const nodes: CapabilityTreeResponse['nodes'] = WEBBRIDGE_CAPABILITY_ENTRIES.map((e) => ({
          name: e.name,
          path: e.path,
          kind: 'tool',
          description: e.description,
        }))
        const text = formatListCapabilitiesResult({
          path,
          nodes,
          note: 'WebBridge 已连接。调用 read_capability("/webbridge/<tool>") 查看任一原语的 schema。',
          text: '',
        })
        return { path, text, nodes, note: 'WebBridge 已连接。' }
      }

      const response = await toolApi.tree(path, defaultSystemCode)
      let nodes = response.nodes
      let note = response.note

      if (includeWebBridge && isWebBridgeAvailable() && path === '/') {
        nodes = [
          ...nodes,
          {
            name: 'webbridge',
            path: WEBBRIDGE_DOMAIN,
            kind: 'folder',
            description: '浏览器自动化（WebBridge）：Sense / Act / Verify 原语',
            children: WEBBRIDGE_CAPABILITY_ENTRIES.map((e) => e.name),
          },
        ]
      }

      const text = formatListCapabilitiesResult({ path: response.path, nodes, note, text: '' })
      return { path: response.path, text, nodes, note }
    },
  }
}

type SchemaFetchResult =
  | { kind: 'schema'; schema: CapabilitySchemaResponse }
  | { kind: 'folderGuide'; guide: ReadCapabilityOutput }

/**
 * read_capability 的 schema 读取（带目录回退）。
 *
 * 模型偶尔会把目录路径（如 /code/sql）当作工具路径传入——这不是错误，是探索中的正常一步。
 * 后端对目录路径返回 404"不存在或无权访问"，措辞误导且会在瀑布流留下红色错误节点；
 * 这里回退到 list_capabilities 语义：目录存在则返回其下内容清单 + 纠正指引（作为正常结果，
 * 经 output.content 直达模型），目录也不存在才把原始错误抛回给模型。
 */
async function fetchSchemaWithFolderFallback(
  path: string,
  systemCode?: string
): Promise<SchemaFetchResult> {
  try {
    return { kind: 'schema', schema: await toolApi.schema(path, systemCode) }
  } catch (err) {
    // WebBridge 目录只存在于前端（后端无此命名空间），单独合成引导
    if (isWebBridgeAvailable() && path === WEBBRIDGE_DOMAIN) {
      const listing = WEBBRIDGE_CAPABILITY_ENTRIES.map((e) => e.path).join('、')
      return {
        kind: 'folderGuide',
        guide: {
          path,
          name: '',
          description: '',
          schemaText: '',
          content: `${path} 是能力目录而非工具，包含：${listing}。请改用其中一个完整工具路径重新调用 read_capability。`,
        },
      }
    }
    try {
      const tree = await toolApi.tree(path, systemCode)
      if (tree.nodes.length > 0) {
        const toolPaths = tree.nodes.filter((n) => n.kind !== 'folder').map((n) => n.path)
        const folderPaths = tree.nodes.filter((n) => n.kind === 'folder').map((n) => n.path)
        const listing = [
          ...toolPaths,
          ...folderPaths.map((p) => `${p}（子目录）`),
        ].join('、')
        const example = toolPaths[0] ?? `${path}/<工具名>`
        return {
          kind: 'folderGuide',
          guide: {
            path,
            name: '',
            description: '',
            schemaText: '',
            content: `${path} 是能力目录而非工具，包含：${listing}。请改用完整工具路径（如 ${example}）重新调用 read_capability。`,
          },
        }
      }
    } catch {
      // 目录也不存在，落入下面的原始错误
    }
    throw err
  }
}

export function createReadCapabilityTool(
  options: CapabilityDiscoveryOptions = {}
): Tool<ReadCapabilityInput, ReadCapabilityOutput> {
  const { systemCode: defaultSystemCode, registry, acceptTool } = options

  return {
    name: READ_CAPABILITY_TOOL_NAME,
    description:
      '文件系统式能力读取原语。像 `cat` 一样读取指定路径工具的完整参数 schema。' +
      '只有在通过 grep 检索 /capabilities 或 list_capabilities 浏览目录、发现具体工具路径后，才应调用此工具。' +
      '读取成功后，该工具会自动加入当前会话的可用工具上下文。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: '工具完整路径，例如 "/code/sql"、"/code/python"',
        },
      },
    },
    riskLevel: 'read_only',
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    alwaysLoad: true,
    maxResultSizeChars: 30000,
    execute: async (input: ReadCapabilityInput): Promise<ReadCapabilityOutput> => {
      const path = normalizePath(input.path)

      // WebBridge 前端原生工具：不走后端 schema 接口，直接返回合成描述
      const webBridgeEntry = isWebBridgeAvailable() ? findWebBridgeCapabilityEntry(path) : undefined
      if (webBridgeEntry) {
        const tool = registry?.get(webBridgeEntry.name) as Tool | undefined
        if (!tool) {
          throw new Error(`浏览器能力尚未加载：${webBridgeEntry.name}`)
        }
        return {
          path,
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema ?? {},
          schemaText: buildWebBridgeCapabilityGuide(path, tool as Tool),
        }
      }

      const fetched = await fetchSchemaWithFolderFallback(path, defaultSystemCode)

      // 目录误读：直接返回引导文本（非错误），模型一步自我纠正，瀑布流不留红色错误节点
      if (fetched.kind === 'folderGuide') {
        return fetched.guide
      }
      const response = fetched.schema

      // 只读环境过滤（explore 子 Agent）：写/破坏性工具不注册，给模型明确的"未加载"引导。
      // name 置空使 agenticLoop 不会把它计入已发现集合。
      if (acceptTool && !acceptTool(response)) {
        return {
          path: response.path,
          name: '',
          description: response.description,
          schemaText: '',
          content: `能力 ${response.path}（${response.name}）是写/破坏性操作，当前环境为只读探索，未加载该工具。请改用只读查询类工具完成任务。`,
        }
      }

      // 将读取到的工具注册到前端镜像，使其在后续轮次可被注入上下文
      if (registry) {
        // 已有同名工具时保留其前端附加面（2026-08-31 审批链根治）：
        // applyBackendToolOverrides 在目录加载后为 run_command 等工具挂了动态
        // checkPermissions/riskLevel/isReadOnly——裸注册同名条目会把这些全部
        // 冲掉（目录闸失效、审批卡不弹、命令直达后端硬拒的实测根因）。
        // 此处只更新目录元数据与发现状态（deferred→可见），前端附加面不动。
        const existing = registry.get(response.name)
        if (existing) {
          existing.description = response.description
          existing.inputSchema = response.parameters ?? {}
          existing.deferred = false
          existing.alwaysLoad = false
          existing.tier = response.tier
          existing.operationType = response.operationType
          existing.approvalMode = response.approvalMode
          existing.requiresApproval = response.requiresApproval
          existing.idempotent = response.idempotent
          existing.maxResultSizeChars = response.maxResultSizeChars ?? existing.maxResultSizeChars
        } else {
          const tool: Tool = {
            name: response.name,
            description: response.description,
            inputSchema: response.parameters ?? {},
            riskLevel: response.riskLevel ?? 'standard',
            isReadOnly:
              response.operationType === 'read' || response.riskLevel === 'read_only',
            isConcurrencySafe: response.operationType === 'read',
            isDestructive: response.riskLevel === 'destructive',
            requiredPermissions: response.requiredPermissions,
            maxResultSizeChars: response.maxResultSizeChars ?? 50000,
            category: response.category,
            deferred: false,
            alwaysLoad: false,
            tier: response.tier,
            operationType: response.operationType,
            approvalMode: response.approvalMode,
            requiresApproval: response.requiresApproval,
            idempotent: response.idempotent,
          }
          registry.register(tool)
        }
      }

      return {
        path: response.path,
        name: response.name,
        description: response.description,
        parameters: response.parameters,
        schemaText: formatReadCapabilityResult({
          path: response.path,
          name: response.name,
          description: response.description,
          parameters: response.parameters,
          schemaText: '',
        }),
      }
    },
  }
}
