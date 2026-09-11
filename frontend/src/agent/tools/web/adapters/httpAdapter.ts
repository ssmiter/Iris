import type {
  WebSearchAdapter,
  WebSearchHit,
  WebFetchAdapter,
  WebFetchOptions,
  WebFetchResult,
  AdapterOptions,
} from '../types'

const DEFAULT_BING_ENDPOINT = 'https://api.bing.microsoft.com/v7.0/search'

export interface HttpSearchConfig {
  provider: 'bing' | 'custom'
  apiKey: string
  baseUrl?: string
}

export class HttpSearchAdapter implements WebSearchAdapter {
  constructor(private config: HttpSearchConfig) {}

  async search(query: string, options: AdapterOptions = {}): Promise<WebSearchHit[]> {
    const { signal, onProgress } = options

    if (signal?.aborted) {
      throw new Error('Request aborted')
    }

    if (!this.config.apiKey) {
      throw new Error('未配置搜索 API Key')
    }

    onProgress?.({ type: 'query_update', query })

    const endpoint = this.config.baseUrl || DEFAULT_BING_ENDPOINT
    const url = `${endpoint}?q=${encodeURIComponent(query)}${endpoint.includes('bing.microsoft') ? '&count=10' : ''}`

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(endpoint.includes('bing.microsoft')
          ? { 'Ocp-Apim-Subscription-Key': this.config.apiKey }
          : { Authorization: `Bearer ${this.config.apiKey}` }),
      },
      signal,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`搜索请求失败: ${response.status} ${text}`)
    }

    const data = (await response.json()) as {
      webPages?: { value?: Array<{ name: string; url: string; snippet?: string }> }
      results?: Array<{ title: string; link: string; snippet?: string }>
    }

    const hits: WebSearchHit[] = []

    if (Array.isArray(data.webPages?.value)) {
      for (const item of data.webPages.value) {
        hits.push({ title: item.name, url: item.url, snippet: item.snippet })
      }
    } else if (Array.isArray(data.results)) {
      for (const item of data.results) {
        hits.push({ title: item.title, url: item.link, snippet: item.snippet })
      }
    }

    onProgress?.({ type: 'search_results_received', query, resultCount: hits.length })
    return hits
  }
}

/**
 * HTTP 网页抓取适配器占位。
 *
 * Standalone 浏览器环境下无法直接跨域抓取任意 URL，因此当前默认未实现。
 * 如果用户配置了 fetch 代理/CORS 代理，可在此接入。
 */
export class HttpFetchAdapter implements WebFetchAdapter {
  async fetch(_options: WebFetchOptions, _adapterOptions: AdapterOptions = {}): Promise<WebFetchResult> {
    throw new Error(
      'Standalone 浏览器内暂不支持直接跨域抓取网页。请连接 WebBridge daemon，或使用后端提供的 web_fetch 能力。'
    )
  }
}
