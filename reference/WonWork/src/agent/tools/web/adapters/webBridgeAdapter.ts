import type {
  WebSearchAdapter,
  WebSearchHit,
  WebFetchAdapter,
  WebFetchOptions,
  WebFetchAdapterResult,
  AdapterOptions,
} from '../types'
import { webBridgeClient } from '@/api/webbridgeClient'
import type { BrowserAction } from '@/types/webbridge'

const SEARCH_URL_BASE = 'https://www.bing.com/search?q='
const FETCH_TIMEOUT_MS = 30_000

export class WebBridgeSearchAdapter implements WebSearchAdapter {
  async search(query: string, options: AdapterOptions = {}): Promise<WebSearchHit[]> {
    const { signal, onProgress } = options

    if (signal?.aborted) {
      throw new Error('Request aborted')
    }

    if (!webBridgeClient.isConnected) {
      throw new Error('WebBridge daemon 未连接，无法执行浏览器搜索')
    }

    onProgress?.({ type: 'query_update', query })

    const navigateAction: BrowserAction = {
      action_type: 'navigate',
      value: `${SEARCH_URL_BASE}${encodeURIComponent(query)}&setmkt=zh-CN`,
      timeout_ms: FETCH_TIMEOUT_MS,
    }

    const navigateResult = await webBridgeClient.send<{ success: boolean; data?: unknown; error_message?: string }>({
      type: 'action',
      payload: navigateAction,
    })

    if (!navigateResult.success) {
      throw new Error(navigateResult.error_message || 'WebBridge 导航失败')
    }

    if (signal?.aborted) {
      throw new Error('Request aborted')
    }

    const extractAction: BrowserAction = {
      action_type: 'extract_html',
      timeout_ms: FETCH_TIMEOUT_MS,
    }

    const extractResult = await webBridgeClient.send<{ success: boolean; data?: string; error_message?: string }>({
      type: 'action',
      payload: extractAction,
    })

    if (!extractResult.success || typeof extractResult.data !== 'string') {
      throw new Error(extractResult.error_message || 'WebBridge 提取页面失败')
    }

    const hits = extractBingResults(extractResult.data)
    onProgress?.({ type: 'search_results_received', query, resultCount: hits.length })
    return hits
  }
}

/**
 * 从 Bing 搜索结果 HTML 中提取自然结果。
 * 结果块位于 <li class="b_algo"> 中。
 */
function extractBingResults(html: string): WebSearchHit[] {
  const results: WebSearchHit[] = []
  const algoBlockRegex = /<li\s+class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi
  let blockMatch: RegExpExecArray | null

  while ((blockMatch = algoBlockRegex.exec(html)) !== null) {
    const block = blockMatch[1]
    const h2LinkRegex = /<h2[^>]*>\s*<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i
    const linkMatch = h2LinkRegex.exec(block)
    if (!linkMatch) continue

    const rawUrl = decodeHtmlEntities(linkMatch[1])
    const titleHtml = linkMatch[2]
    const url = resolveBingUrl(rawUrl)
    if (!url) continue

    const title = decodeHtmlEntities(titleHtml.replace(/<[^>]+>/g, '').trim())
    const snippet = extractSnippet(block)

    results.push({ title, url, snippet })
  }

  return results
}

function extractSnippet(block: string): string | undefined {
  const lineclampRegex = /<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i
  let match = lineclampRegex.exec(block)
  if (match) {
    return decodeHtmlEntities(match[1].replace(/<[^>]+>/g, '').trim())
  }

  const captionPRegex = /<div[^>]*class="b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i
  match = captionPRegex.exec(block)
  if (match) {
    return decodeHtmlEntities(match[1].replace(/<[^>]+>/g, '').trim())
  }

  const fallbackRegex = /<div[^>]*class="b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  const fallbackMatch = fallbackRegex.exec(block)
  if (fallbackMatch) {
    const text = fallbackMatch[1].replace(/<[^>]+>/g, '').trim()
    if (text) return decodeHtmlEntities(text)
  }

  return undefined
}

function decodeHtmlEntities(html: string): string {
  const textarea = document.createElement('textarea')
  textarea.innerHTML = html
  return textarea.value
}

function resolveBingUrl(rawUrl: string): string | undefined {
  if (rawUrl.startsWith('/') || rawUrl.startsWith('#')) return undefined

  const uMatch = rawUrl.match(/[?&]u=([a-zA-Z0-9+/_=-]+)/)
  if (uMatch) {
    const encoded = uMatch[1]
    if (encoded.length >= 3) {
      const prefix = encoded.slice(0, 2)
      const b64 = encoded.slice(2)
      try {
        const padded = b64.replace(/-/g, '+').replace(/_/g, '/')
        const padLen = (4 - (padded.length % 4)) % 4
        const decoded = atob(padded + '='.repeat(padLen))
        if (decoded.startsWith('http')) {
          return prefix === 'a1' ? decoded : decoded.replace(/^http:/, 'https:')
        }
      } catch {
        // fall through
      }
    }
  }

  if (!rawUrl.includes('bing.com')) return rawUrl
  return undefined
}

const MAX_FETCH_CHARS = 100_000

export class WebBridgeFetchAdapter implements WebFetchAdapter {
  async fetch(options: WebFetchOptions, adapterOptions: AdapterOptions = {}): Promise<WebFetchAdapterResult> {
    const { signal, onProgress } = adapterOptions
    const { url, selector, offset, limit, raw } = options

    if (signal?.aborted) {
      throw new Error('Request aborted')
    }

    if (!webBridgeClient.isConnected) {
      throw new Error('WebBridge daemon 未连接，无法执行网页抓取')
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      throw new Error('URL 必须以 http:// 或 https:// 开头')
    }

    onProgress?.({ type: 'query_update', query: url })

    const navigateAction: BrowserAction = {
      action_type: 'navigate',
      value: url,
      timeout_ms: FETCH_TIMEOUT_MS,
    }

    const navigateResult = await webBridgeClient.send<{ success: boolean; data?: unknown; error_message?: string }>({
      type: 'action',
      payload: navigateAction,
    })

    if (!navigateResult.success) {
      throw new Error(navigateResult.error_message || 'WebBridge 导航失败')
    }

    if (signal?.aborted) {
      throw new Error('Request aborted')
    }

    // 获取页面标题
    const titleResult = await webBridgeClient.send<{ success: boolean; data?: string; error_message?: string }>({
      type: 'action',
      payload: { action_type: 'get_title', timeout_ms: 5000 },
    })
    const title = titleResult.success && typeof titleResult.data === 'string' ? titleResult.data : undefined

    if (signal?.aborted) {
      throw new Error('Request aborted')
    }

    let content: string

    if (selector) {
      // 在浏览器端执行选择器提取
      const expression = raw
        ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.outerHTML : ''; })()`
        : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.innerText : ''; })()`

      const evaluateResult = await webBridgeClient.send<{ success: boolean; data?: string; error_message?: string }>({
        type: 'action',
        payload: {
          action_type: 'evaluate',
          value: expression,
          timeout_ms: FETCH_TIMEOUT_MS,
        },
      })

      if (!evaluateResult.success || typeof evaluateResult.data !== 'string') {
        throw new Error(evaluateResult.error_message || `选择器 ${selector} 未匹配到任何元素`)
      }
      content = evaluateResult.data
    } else if (raw) {
      const extractResult = await webBridgeClient.send<{ success: boolean; data?: string; error_message?: string }>({
        type: 'action',
        payload: { action_type: 'extract_html', timeout_ms: FETCH_TIMEOUT_MS },
      })
      if (!extractResult.success || typeof extractResult.data !== 'string') {
        throw new Error(extractResult.error_message || 'WebBridge 提取 HTML 失败')
      }
      content = extractResult.data
    } else {
      const extractResult = await webBridgeClient.send<{ success: boolean; data?: string; error_message?: string }>({
        type: 'action',
        payload: { action_type: 'extract_text', timeout_ms: FETCH_TIMEOUT_MS },
      })
      if (!extractResult.success || typeof extractResult.data !== 'string') {
        throw new Error(extractResult.error_message || 'WebBridge 提取文本失败')
      }
      content = extractResult.data
    }

    // 释放页面资源，避免内存持续增长
    await webBridgeClient.send({
      type: 'action',
      payload: { action_type: 'navigate', value: 'about:blank', timeout_ms: 5000 },
    })

    return applyFetchPagination({ url, title, content, selector, offset, limit })
  }
}

function applyFetchPagination(params: {
  url: string
  title?: string
  content: string
  selector?: string
  offset?: number
  limit?: number
}): WebFetchAdapterResult {
  const { url, title, content, selector, offset, limit } = params
  const rawLimit = Math.max(1, Math.min(limit ?? 200, 2000))
  const rawOffset = Math.max(1, offset ?? 1)

  const allLines = content.split('\n')
  const totalLines = allLines.length
  const totalChars = content.length

  const startIndex = rawOffset - 1
  const slicedLines = allLines.slice(startIndex, startIndex + rawLimit)
  let returnedContent = slicedLines.join('\n')

  const isLineTruncated = returnedContent.length < content.length

  // 再按字符封顶
  let isCharTruncated = false
  if (returnedContent.length > MAX_FETCH_CHARS) {
    returnedContent = returnedContent.slice(0, MAX_FETCH_CHARS)
    isCharTruncated = true
  }

  const isTruncated = isLineTruncated || isCharTruncated

  if (isTruncated && !returnedContent.includes('[内容已截断]')) {
    returnedContent +=
      '\n\n[内容已截断] 当前仅返回部分文本。如需继续阅读，请使用更大的 offset 再次调用 web_fetch。'
  }

  return {
    url,
    title,
    content: returnedContent,
    fullContent: content,
    totalLines,
    totalChars,
    isTruncated,
    returnedOffset: rawOffset,
    returnedLimit: rawLimit,
  }
}
