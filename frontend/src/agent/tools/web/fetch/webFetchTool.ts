import { createTool } from '@/agent/toolFactory'
import type { ToolExecutionContext } from '@/agent/types'
import type { WebFetchOptions, WebFetchResult, WebSearchProgress } from '../types'
import { resolveFetchAdapter } from '../adapters'
import { writeWebCache } from '../cache'
import { getWebFetchPrompt, WEB_FETCH_TOOL_NAME } from './prompt'

export const webFetchTool = createTool<WebFetchOptions, WebFetchResult>({
  name: WEB_FETCH_TOOL_NAME,
  description:
    '读取指定网页的内容。当你需要基于网页原文回答问题时，先使用 web_search 找到相关 URL，再用 web_fetch 读取页面。支持按 CSS 选择器提取章节，以及 offset/limit 分页读取长页面。完整内容会写入 /workspace/scratch/web_cache/pages/...，工具返回摘要 + cached_path；如需深读请用 read_file 读取 cached_path。',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: '要读取的页面 URL，必须以 http:// 或 https:// 开头',
      },
      selector: {
        type: 'string',
        description: '可选 CSS 选择器，只提取匹配元素的内容（例如 article、.main-content、#content）',
      },
      offset: {
        type: 'number',
        description: '起始行号（1-based），用于长页面分页；默认 1',
      },
      limit: {
        type: 'number',
        description: '最多返回行数，默认 200，最大 2000',
      },
      raw: {
        type: 'boolean',
        description: '是否返回原始 HTML；默认 false，返回提取后的可读文本',
      },
    },
    required: ['url'],
  },
  category: 'web',
  usagePrompt: getWebFetchPrompt(),
  riskLevel: 'read_only',
  isReadOnly: true,
  isConcurrencySafe: true,
  isDestructive: false,
  alwaysLoad: true,
  maxResultSizeChars: 100_000,
  async execute(input, ctx: ToolExecutionContext): Promise<WebFetchResult> {
    const adapter = resolveFetchAdapter()
    const result = await adapter.fetch(input, {
      signal: ctx.abortSignal,
      onProgress: (progress: WebSearchProgress) => {
        ctx.onProgress?.({
          toolCallId: '',
          toolName: WEB_FETCH_TOOL_NAME,
          status: 'running',
          message: progress.type === 'query_update' ? `抓取: ${progress.query}` : '提取页面内容中...',
          detail: progress,
        })
      },
    })

    const { cachedPath, summary } = await writeWebCache(
      'fetch',
      input.url,
      {
        url: result.url,
        title: result.title,
        content: result.fullContent ?? result.content,
        contentType: input.raw ? 'html' : 'text',
        totalChars: result.totalChars,
      }
    )

    // 2026-07-29 两点结构性修复：
    // 1) 模型可见文本是 content（extractOutputText 优先 content 字段），cached_path 必须内嵌到
    //    内容尾部，否则模型不知道去哪深读全文；
    // 2) 软 404 识别：站点返回 200 但正文是"主题不存在"类错误页时显式标注，
    //    避免模型把错误提示页当正文引用（保守启发式：标题命中，或正文极短且命中）
    const soft404 =
      /404|not\s*found|页面不存在|内容不存在|主题不存在|文章不存在|资源不存在/i.test(result.title ?? '') ||
      (result.totalChars > 0 && result.totalChars < 300 && /不存在|not\s*found|404/i.test(result.content))

    const notices = [`完整页面已缓存到 ${cachedPath}，可用 read_file（带 offset/limit 参数）深读全文`]
    if (soft404) notices.push('⚠ 该页面疑似错误提示页（软 404：抓取成功但内容是无效提示），请核对后再引用')

    return {
      ...result,
      content: `${result.content}\n\n[${notices.join('；')}]`,
      summary: soft404 ? `${summary} ⚠ 疑似错误提示页（软 404），引用前请核对内容。` : summary,
      cached_path: cachedPath,
    }
  },
})
