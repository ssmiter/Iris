/**
 * Provider Key 保险柜（全局作用域）
 *
 * 背景 BUG（2026-07-24 排查）：用户在 website-online 模式配置了 kimi-code 的 API Key，
 * 登录 mescli-online 后 Key "消失"——模型看似不回答问题（实际是后端代理因无 Key 报错，
 * 而 error chunk 此前被前端静默吞掉，见 backendProxyModelClient）。
 *
 * 根因：设置页把 Key 存到"当前连接的后端"（公网后端与企业后端是两台机器、两套 DB），
 * localStorage 又按 storageScope 分前缀，换模式 = 换存储域 = 配置全部不可见。
 *
 * 设计决策：API Key 是"这台机器上这个用户"的凭据，与登录哪个后端无关。
 * 因此保险柜使用【全局】localStorage key（不带 scope 前缀），一次配置、跨模式可用，
 * 除非用户主动清除浏览器数据/重装，否则不需要重新配置。
 *
 * 读取优先级（resolveProviderCredentials）：BYOK 默认 Key → 保险柜 → 后端 userconfig。
 * 后端取到 Key 后会回写保险柜（自愈），设置页保存时也写保险柜。
 */

export interface ProviderKeyEntry {
  apiKey?: string
  baseUrl?: string
  model?: string
  updatedAt: number
}

const VAULT_KEY = 'wonwork_provider_keys'

function readVault(): Record<string, ProviderKeyEntry> {
  try {
    const raw = localStorage.getItem(VAULT_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, ProviderKeyEntry>
  } catch {
    return {}
  }
}

function writeVault(vault: Record<string, ProviderKeyEntry>): void {
  try {
    localStorage.setItem(VAULT_KEY, JSON.stringify(vault))
  } catch {
    // 存储满等异常静默——保险柜是优化层，写不进去不影响主链路
  }
}

/** 读取某 provider 的本地凭据（无则 undefined） */
export function getProviderKeyEntry(provider: string): ProviderKeyEntry | undefined {
  const entry = readVault()[provider]
  if (entry && (entry.apiKey || entry.baseUrl || entry.model)) return entry
  return importLegacyStandaloneConfig(provider)
}

/**
 * 一次性迁移：保险柜建立前的旧配置散落在按作用域前缀的 standalone_config 里
 * （wonwork_website_/wonwork_mescli_/wonclaw_ 三种前缀）。命中即导入保险柜，
 * 让升级前的老配置自动获得跨模式可见性，无需用户重配。
 */
function importLegacyStandaloneConfig(provider: string): ProviderKeyEntry | undefined {
  const LEGACY_KEYS = [
    'wonwork_website_standalone_config',
    'wonwork_mescli_standalone_config',
    'wonclaw_standalone_config',
  ]
  for (const key of LEGACY_KEYS) {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const cfg = JSON.parse(raw) as { provider?: string; apiKey?: string; apiBase?: string; model?: string }
      if (cfg?.provider !== provider || !cfg.apiKey) continue
      const entry = { apiKey: cfg.apiKey, baseUrl: cfg.apiBase, model: cfg.model }
      setProviderKeyEntry(provider, entry)
      return { ...entry, updatedAt: Date.now() }
    } catch {
      // 单个 key 损坏不影响其他来源
    }
  }
  return undefined
}

/** 写入/合并某 provider 的本地凭据（只覆盖传入的非空字段） */
export function setProviderKeyEntry(
  provider: string,
  patch: { apiKey?: string; baseUrl?: string; model?: string }
): void {
  const vault = readVault()
  const prev = vault[provider] ?? { updatedAt: 0 }
  vault[provider] = {
    apiKey: patch.apiKey || prev.apiKey,
    baseUrl: patch.baseUrl || prev.baseUrl,
    model: patch.model || prev.model,
    updatedAt: Date.now(),
  }
  writeVault(vault)
}

/** 清除某 provider 的 Key（设置页"清除"场景用；保留 baseUrl/model 偏好） */
export function clearProviderApiKey(provider: string): void {
  const vault = readVault()
  if (!vault[provider]) return
  vault[provider] = { ...vault[provider], apiKey: undefined, updatedAt: Date.now() }
  writeVault(vault)
}
