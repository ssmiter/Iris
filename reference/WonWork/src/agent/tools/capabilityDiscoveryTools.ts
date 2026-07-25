import type { Tool } from '@/agent/types'
import type {
  CapabilityTreeResponse,
  CapabilitySchemaResponse,
  ToolDefinition,
} from '@/types/mescli'
import { toolApi } from '@/api/client'
import type { FrontendToolRegistry } from '@/agent/toolRegistry'
import { webBridgeClient } from '@/api/webbridgeClient'
import { webbridgeExecuteTool } from './web/bridge/webbridgeExecuteTool'

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
  /** 工具完整路径，例如 "/demo/query_products" */
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
}

export interface CapabilityDiscoveryOptions {
  systemCode?: string
  /** 前端工具镜像，read_capability 成功后会将工具注册进去 */
  registry?: FrontendToolRegistry
}

function normalizePath(path?: string): string {
  if (!path || path.trim().length === 0) return '/'
  let normalized = path.trim().replace(/\\/g, '/')
  if (!normalized.startsWith('/')) normalized = '/' + normalized
  normalized = normalized.replace(/\/+/g, '/')
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
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
  { path: '/webbridge/execute', name: 'webbridge_execute', description: '自然语言执行简单浏览器任务（1-3 步，降级保留）' },
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

webbridge_execute 仅用于简单 1-3 步任务；多步任务请拆解为上述原语。

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
  const { systemCode: defaultSystemCode } = options

  return {
    name: LIST_CAPABILITIES_TOOL_NAME,
    description:
      '文件系统式能力浏览原语。像 `ls` 一样列出指定路径下的目录和工具入口。' +
      '建议先从 "/" 开始，看到顶层域（如 /demo、/code）后再深入。' +
      '目录名可见，但工具 schema 需要通过 read_capability 单独读取。',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '要浏览的路径，例如 "/"、"/demo"、"/code"，默认 "/"',
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

      if (isWebBridgeAvailable() && path === WEBBRIDGE_DOMAIN) {
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

      if (isWebBridgeAvailable() && path === '/') {
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

export function createReadCapabilityTool(
  options: CapabilityDiscoveryOptions = {}
): Tool<ReadCapabilityInput, ReadCapabilityOutput> {
  const { systemCode: defaultSystemCode, registry } = options

  return {
    name: READ_CAPABILITY_TOOL_NAME,
    description:
      '文件系统式能力读取原语。像 `cat` 一样读取指定路径工具的完整参数 schema。' +
      '只有在调用 list_capabilities 发现具体工具路径后，才应调用此工具。' +
      '读取成功后，该工具会自动加入当前会话的可用工具上下文。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: '工具完整路径，例如 "/demo/query_products"、"/code/python"',
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
        const tool = (registry?.get(webBridgeEntry.name) as Tool | undefined) || webbridgeExecuteTool
        if (registry && !registry.get(tool.name)) {
          registry.register(tool as Tool<unknown, unknown>)
        }
        return {
          path,
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema ?? {},
          schemaText: buildWebBridgeCapabilityGuide(path, tool as Tool),
        }
      }

      const response = await toolApi.schema(path, defaultSystemCode)

      // 将读取到的工具注册到前端镜像，使其在后续轮次可被注入上下文
      if (registry) {
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
