import type { Tool } from '@/agent/types'
import type {
  ToolSearchRequest,
  ToolSearchResponse,
  ToolTier,
} from '@/types/mescli'
import { toolApi } from '@/api/client'
import type { FrontendToolRegistry } from '@/agent/toolRegistry'

/**
 * ToolSearchTool — 工具发现原语
 *
 * 设计借鉴 claude-code 的 ToolSearchTool + defer_loading：
 * - 后端/外部 MCP 的大量工具默认不注入模型上下文（deferred）。
 * - 模型可以通过调用 tool_search 按关键词/分类查找可用工具。
 * - 被发现的工具会在后续轮次被注入上下文，直到对话结束。
 *
 * 该工具本身是 alwaysLoad，任何模式下都应注册并注入上下文。
 * M1 搜索范围：后端 Capability 目录 + 前端本地原语注册表。
 */

export const TOOL_SEARCH_TOOL_NAME = 'tool_search'

interface ToolSearchInput {
  /** 搜索关键词，支持模糊匹配工具名或描述 */
  query: string
  /** 系统码，如 ykhm / iris / xyqz */
  system_code?: string
  /** 允许返回的工具层级，默认包含 domain_operation 和 primitive */
  include_tiers?: ToolTier[]
  /** 按分类过滤，例如 "mes", "sql", "mcp", "report" */
  category?: string
  /** 最多返回多少条结果，默认 5 */
  limit?: number
}

interface ToolSearchMatch {
  name: string
  description: string
  tier?: ToolTier
  category?: string
  load_strategy?: string
  /** 能力目录路径（read_capability 可直接读取） */
  path?: string
  reason: string
}

interface ToolSearchOutput {
  query: string
  matches: ToolSearchMatch[]
  total: number
}

export interface ToolSearchOptions {
  systemCode?: string
  /** 前端工具镜像，用于同时搜索本地原语注册表 */
  registry?: FrontendToolRegistry
}

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 50

/**
 * 后端使用 PascalCase 的 enum 名（DomainOperation / Primitive / Admin / Workflow），
 * 而前端 schema 对模型暴露 snake_case。调用 /api/tools/search 前需要转换。
 */
function toBackendTier(tier: ToolTier): string {
  switch (tier) {
    case 'domain_operation':
      return 'DomainOperation'
    case 'primitive':
      return 'Primitive'
    case 'admin':
      return 'Admin'
    case 'workflow':
      return 'Workflow'
    default:
      return tier
  }
}

export function createToolSearchTool(options: ToolSearchOptions = {}): Tool<ToolSearchInput, ToolSearchOutput> {
  const { systemCode: defaultSystemCode, registry } = options

  return {
    name: TOOL_SEARCH_TOOL_NAME,
    description:
      '工具发现原语。当用户请求的操作不在当前已注入上下文的工具列表中时，使用此工具按关键词搜索可用工具。' +
      '搜索范围包括后端 Capability 目录和前端本地原语。' +
      '只返回工具名称、描述和适用场景，不返回完整参数 schema。发现后请直接调用目标工具，无需再次搜索。' +
      'query 请使用领域关键词，不要写完整句子。',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词，例如 "inventory", "report", "quality", "设备故障报表", "查询成型计划"',
        },
        system_code: {
          type: 'string',
          description: '系统码，如 ykhm / iris / xyqz',
        },
        include_tiers: {
          type: 'array',
          description: '允许返回的工具层级，默认包含 domain_operation 和 primitive',
          items: {
            type: 'string',
            enum: ['domain_operation', 'primitive', 'admin', 'workflow'],
          },
        },
        category: {
          type: 'string',
          description: '按分类过滤，例如 "mes", "sql", "mcp", "report"',
        },
        limit: {
          type: 'number',
          description: '最多返回多少条结果，默认 5',
          default: DEFAULT_LIMIT,
        },
      },
    },
    riskLevel: 'read_only',
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    alwaysLoad: true,
    maxResultSizeChars: 20000,
    execute: async (input: ToolSearchInput): Promise<ToolSearchOutput> => {
      const query = (input.query || '').trim()
      if (!query) {
        return { query: '', matches: [], total: 0 }
      }

      const category = input.category ? input.category.trim() : undefined
      const limit =
        typeof input.limit === 'number' && input.limit > 0
          ? Math.min(input.limit, MAX_LIMIT)
          : DEFAULT_LIMIT

      const request: ToolSearchRequest = {
        query,
        systemCode: input.system_code || defaultSystemCode,
        includeTiers: (input.include_tiers ?? ['domain_operation', 'primitive']).map(
          toBackendTier
        ) as ToolTier[],
        category,
        limit,
      }

      // 1. 优先调用后端 /api/tools/search，利用后端 CapabilityService 的语义/权限过滤
      let backendResponse: ToolSearchResponse = { tools: [] }
      try {
        backendResponse = await toolApi.search(request)
      } catch (err) {
        console.warn('[tool_search] 后端搜索失败，回退到本地镜像搜索:', err)
      }

      // 2. 同时在前端工具镜像中搜索本地原语（L1）
      const localMatches: ToolSearchMatch[] = []
      if (registry) {
        const queryLower = query.toLowerCase()
        const categoryLower = category?.toLowerCase()
        for (const tool of registry.list()) {
          const nameLower = tool.name.toLowerCase()
          if (nameLower === TOOL_SEARCH_TOOL_NAME) continue

          const descLower = (tool.description || '').toLowerCase()
          const catLower = (tool.category || '').toLowerCase()

          const matchesQuery =
            nameLower.includes(queryLower) || descLower.includes(queryLower)
          const matchesCategory = !categoryLower || catLower === categoryLower

          if (matchesQuery && matchesCategory) {
            localMatches.push({
              name: tool.name,
              description: tool.description,
              tier: tool.tier,
              category: tool.category,
              load_strategy: tool.loadStrategy,
              reason: `前端本地原语 "${tool.name}" 匹配关键词 "${query}"`,
            })
          }
        }
      }

      // 3. 合并并去重（按工具名），优先保留后端返回的元数据
      const seen = new Set<string>()
      const matches: ToolSearchMatch[] = []

      const addMatch = (match: ToolSearchMatch) => {
        const key = match.name.toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        matches.push(match)
      }

      for (const item of backendResponse.tools || []) {
        addMatch({
          name: item.name,
          description: item.description,
          tier: item.tier,
          category: item.category,
          load_strategy: item.loadStrategy,
          path: item.path,
          reason: `后端 Capability 目录匹配关键词 "${query}"`,
        })
      }

      for (const match of localMatches) {
        addMatch(match)
      }

      const limited = matches.slice(0, limit)
      // total 取后端命中总数与本地合并结果数的较大者：让模型知道"还有更多"，
      // 而不是误以为返回的几条就是全部。
      const total = Math.max(backendResponse.total ?? 0, matches.length)

      return {
        query,
        matches: limited,
        total,
      }
    },
  }
}

/**
 * 将 tool_search 结果格式化为模型可读的文本。
 */
export function formatToolSearchResult(output: ToolSearchOutput): string {
  if (output.total === 0) {
    return `未找到与 "${output.query}" 匹配的工具。请尝试其他关键词或分类，或用 list_capabilities 浏览目录定位。`
  }

  const truncated = output.total > output.matches.length
  const lines: string[] = [
    truncated
      ? `找到 ${output.total} 个与 "${output.query}" 相关的可用工具（按相关度返回前 ${output.matches.length} 个）：`
      : `找到 ${output.total} 个与 "${output.query}" 相关的可用工具：`,
    '',
  ]
  for (const match of output.matches) {
    const metaParts: string[] = []
    if (match.category) metaParts.push(match.category)
    if (match.tier) metaParts.push(match.tier)
    const meta = metaParts.length > 0 ? `（${metaParts.join(' / ')}）` : ''
    lines.push(`- **${match.name}**${meta}`)
    lines.push(`  ${match.description}`)
    if (match.path) lines.push(`  路径：${match.path}`)
  }
  lines.push('')
  lines.push(
    truncated
      ? '结果较多时：优先选路径与需求所属工序/业务对象最贴近的工具，用 read_capability("路径") 读取完整 schema 后再调用；不必全部读取。'
      : '调用前请先用 read_capability("路径") 读取目标工具的完整 schema。'
  )
  return lines.join('\n')
}

/**
 * 从 tool_search 的结果文本中提取已发现工具名。
 *
 * 简单启发式：匹配 `- **name**` 行。
 */
export function extractDiscoveredToolNames(resultText: string): string[] {
  const names: string[] = []
  const regex = /^-\s*\*\*([^*\s][^*]*)\*\*/gm
  let match: RegExpExecArray | null
  while ((match = regex.exec(resultText)) !== null) {
    names.push(match[1].trim().toLowerCase())
  }
  return names
}
