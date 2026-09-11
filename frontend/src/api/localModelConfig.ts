/**
 * 本地 AI 供应商配置（自 standaloneApi.ts 迁出，2026-09 standalone 死代码清理）。
 *
 * WonWork 时代这份配置叫 StandaloneConfig——standalone 模式直连 Provider 的唯一配置。
 * Iris 删除 standalone 后，它仍是"当前使用的模型 + Key"的本地存档（providerKeyVault
 * 会从这里做一次性迁移，ChatView/设置页据此恢复激活项），因此保留为叶子模块，
 * 不再依赖 standaloneApi 的庞大依赖链。
 */
import { PROVIDERS } from './providerPresets'

export interface StandaloneConfig {
  provider: string
  apiKey: string
  apiBase?: string
  model: string
  temperature: number
  maxTokens: number
  systemPrompt?: string
  /** 联网搜索提供商：bing 或自定义 endpoint */
  searchProvider?: 'bing' | 'custom'
  /** 联网搜索 API Key（Bing Web Search API v7 等） */
  searchApiKey?: string
  /** 自定义搜索 API Base URL，留空则使用 Bing 默认端点 */
  searchApiBaseUrl?: string
}

const CONFIG_KEY = 'wonclaw_standalone_config'

export function getStandaloneConfig(): StandaloneConfig {
  const raw = localStorage.getItem(CONFIG_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as StandaloneConfig
      // 旧缓存防御（2026-07-24）：历史配置可能存了现已不存在的 provider（或字段缺失）。
      // 不校验直接返回会让 PROVIDERS[config.provider] 取到 undefined，渲染时白屏。
      if (parsed && typeof parsed === 'object' && PROVIDERS[parsed.provider]) {
        return parsed
      }
    } catch {
      // ignore
    }
  }
  return {
    // 2026-08-05 用户拍板：默认用 DeepSeek；其他提供商仅隐藏不删
    provider: 'deepseek',
    apiKey: '',
    model: 'deepseek-v4-flash',
    temperature: 1.0,
    maxTokens: 2048,
    systemPrompt: '',
    searchProvider: 'bing',
    searchApiKey: '',
    searchApiBaseUrl: '',
  }
}

export function setStandaloneConfig(config: StandaloneConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
}
