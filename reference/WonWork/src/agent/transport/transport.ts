import { buildAnthropicMessagesUrl } from '@/api/standalone/anthropicMessages'

/**
 * Transport 抽象层
 *
 * 职责：屏蔽网络传输细节。
 * - 直连 Provider API
 * - 通过 Vite 代理转发（开发环境 Anthropic 代理）
 * - 通过后端 LLM 代理（MESCLI Online / Preview 模式）
 *
 * ModelClient 只关心「发一个 HTTP 请求并拿到 Response」，
 * 具体 URL、Header、Credentials 由 Transport 实现决定。
 */

export interface TransportRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  credentials?: RequestCredentials
}

export interface TransportProvider {
  /**
   * 发起请求，返回原始 Response。
   * 由 ModelClient 自行处理 SSE reader。
   */
  fetch(request: TransportRequest): Promise<Response>
  /**
   * 根据 provider/baseUrl 构造最终请求 URL。
   */
  buildUrl(providerId: string, baseUrl: string, options?: { isAnthropic?: boolean }): string
}

/**
 * 默认 Transport：浏览器原生 fetch。
 *
 * 适用于：
 * - Standalone 直接调用 Provider API
 * - MESCLI Local 直接调用 Provider API（绕过 .NET 后端）
 */
export class BrowserFetchTransport implements TransportProvider {
  async fetch(request: TransportRequest): Promise<Response> {
    const { url, method = 'GET', headers = {}, body, signal, credentials = 'omit' } = request
    return fetch(url, {
      method,
      headers,
      body,
      signal,
      credentials,
    })
  }

  buildUrl(providerId: string, baseUrl: string, options?: { isAnthropic?: boolean }): string {
    if (options?.isAnthropic) {
      return buildAnthropicMessagesUrl(baseUrl)
    }

    const normalized = baseUrl.replace(/\/+$/, '')
    if (normalized.endsWith('/v1')) {
      return `${normalized}/chat/completions`
    }
    return `${normalized}/v1/chat/completions`
  }
}

/**
 * 后端代理 Transport。
 *
 * 适用于：
 * - MESCLI Online：由 .NET 后端代理 LLM 请求
 * - Preview 模式：`VITE_USE_BACKEND_API=true` 时 Standalone UI 走后端 SQLite
 *
 * 此 Transport 会把请求转发到后端 SSE 端点，由后端与 Provider 通信。
 */
export class BackendProxyTransport implements TransportProvider {
  constructor(private backendBaseUrl: string) {}

  async fetch(request: TransportRequest): Promise<Response> {
    const { url: _url, method = 'POST', headers = {}, body, signal, credentials = 'include' } = request
    const backendUrl = `${this.backendBaseUrl.replace(/\/+$/, '')}/api/chat/stream-sse`
    return fetch(backendUrl, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body,
      signal,
      credentials,
    })
  }

  buildUrl(): string {
    // 后端代理模式下 URL 由后端决定，此处返回占位
    return `${this.backendBaseUrl.replace(/\/+$/, '')}/api/chat/stream-sse`
  }
}

/**
 * 开发环境 Anthropic 代理 Transport。
 *
 * Kimi Code / Claude 等 Anthropic 兼容 Provider 在浏览器直接跨域会触发 OPTIONS 预检失败，
 * 开发时通过 Vite proxy（/anthropic-proxy）转发。
 */
export class AnthropicDevProxyTransport extends BrowserFetchTransport {
  buildUrl(_providerId: string, _baseUrl: string): string {
    return '/anthropic-proxy/coding/v1/messages'
  }
}
