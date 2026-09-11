import { createTool } from '@/agent/toolFactory'
import type { ToolExecutionContext } from '@/agent/types'
import type { WebSearchOptions, WebSearchResult, WebSearchProgress } from '../types'
import { resolveSearchAdapter } from '../adapters'
import { writeWebCache } from '../cache'
import { getWebSearchPrompt, WEB_SEARCH_TOOL_NAME } from './prompt'

const MAX_RESULTS = 10

export const webSearchTool = createTool<WebSearchOptions, WebSearchResult>({
  name: WEB_SEARCH_TOOL_NAME,
  description:
    '联网搜索。当你需要获取最新信息、实时数据或超出自身知识范围的外部资料时调用。返回搜索结果列表（标题、URL、摘要）以及完整结果的缓存路径 cached_path；如需深读请用 read_file 读取 cached_path。',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索查询词，应包含准确、具体的关键词；涉及近期信息时建议包含当前年份。',
      },
      top_n: {
        type: 'number',
        description: `最多返回的搜索结果条数，默认 5，最大 ${MAX_RESULTS}`,
      },
    },
    required: ['query'],
  },
  category: 'search',
  usagePrompt: getWebSearchPrompt(),
  riskLevel: 'read_only',
  isReadOnly: true,
  isConcurrencySafe: true,
  isDestructive: false,
  alwaysLoad: true,
  maxResultSizeChars: 100_000,
  async execute(input, ctx: ToolExecutionContext): Promise<WebSearchResult> {
    const query = input.query
    const topN = Math.min(Math.max(Number(input.top_n) || 5, 1), MAX_RESULTS)

    const adapter = resolveSearchAdapter()
    const hits = await adapter.search(query, {
      signal: ctx.abortSignal,
      onProgress: (progress: WebSearchProgress) => {
        ctx.onProgress?.({
          toolCallId: '', // 由调用方在外层填入
          toolName: WEB_SEARCH_TOOL_NAME,
          status: 'running',
          message:
            progress.type === 'query_update'
              ? `搜索: ${progress.query}`
              : `收到 ${progress.resultCount ?? 0} 条结果`,
          detail: progress,
        })
      },
    })

    const trimmedHits = hits.slice(0, topN)
    const engine = trimmedHits[0]?.engine || 'unknown'

    const { cachedPath, summary } = await writeWebCache(
      'search',
      query,
      {
        query,
        engine,
        results: trimmedHits,
      }
    )

    return {
      query,
      results: trimmedHits,
      summary,
      cached_path: cachedPath,
      result_count: trimmedHits.length,
    }
  },
})
