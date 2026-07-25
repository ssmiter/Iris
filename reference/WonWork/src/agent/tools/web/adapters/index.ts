import { webBridgeClient } from '@/api/webbridgeClient'
import type { WebSearchAdapter, WebFetchAdapter, AdapterOptions } from '../types'
import { DaemonHttpSearchAdapter, DaemonHttpFetchAdapter } from './daemonAdapter'
import { HttpSearchAdapter, HttpFetchAdapter } from './httpAdapter'
import { WebBridgeSearchAdapter, WebBridgeFetchAdapter } from './webBridgeAdapter'
import type { HttpSearchConfig } from './httpAdapter'

const LOCAL_STORAGE_CONFIG_KEY = 'wonclaw_standalone_config'

interface RawStandaloneConfig {
  searchProvider?: 'bing' | 'custom'
  searchApiKey?: string
  searchApiBaseUrl?: string
  [key: string]: unknown
}

function loadSearchConfig(): HttpSearchConfig | null {
  const raw = localStorage.getItem(LOCAL_STORAGE_CONFIG_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as RawStandaloneConfig
    if (!parsed.searchApiKey) return null
    return {
      provider: parsed.searchProvider || 'bing',
      apiKey: parsed.searchApiKey,
      baseUrl: parsed.searchApiBaseUrl,
    }
  } catch {
    return null
  }
}

/**
 * 按优先级选择搜索适配器：
 * 1. WebBridge daemon 已连接 → 浏览器内搜索（无 API Key）
 * 2. 用户在 Standalone 设置中配置了搜索 API Key → HTTP 搜索
 * 3. 否则抛出明确错误
 */
export function resolveSearchAdapter(): WebSearchAdapter {
  if (webBridgeClient.isConnected) {
    return new DaemonHttpSearchAdapter()
  }

  const httpConfig = loadSearchConfig()
  if (httpConfig) {
    return new HttpSearchAdapter(httpConfig)
  }

  throw new Error(
    '未配置搜索适配器。请启动 WebBridge daemon，或在设置中配置搜索 API Key。'
  )
}

/**
 * 按优先级选择网页抓取适配器：
 * 1. WebBridge daemon 已连接 → 浏览器内抓取（可绕过 CORS、渲染动态页）
 * 2. 否则抛出明确错误（Standalone 浏览器内无法直接跨域抓取）
 */
export function resolveFetchAdapter(): WebFetchAdapter {
  if (webBridgeClient.isConnected) {
    return new DaemonHttpFetchAdapter()
  }

  throw new Error(
    '未配置网页抓取适配器。请启动 WebBridge daemon，或使用后端提供的 web_fetch 能力。'
  )
}

export type { WebSearchAdapter, WebFetchAdapter, AdapterOptions }
export {
  DaemonHttpSearchAdapter,
  DaemonHttpFetchAdapter,
  WebBridgeSearchAdapter,
  WebBridgeFetchAdapter,
  HttpSearchAdapter,
  HttpFetchAdapter,
}
export type { HttpSearchConfig } from './httpAdapter'
