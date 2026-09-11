/**
 * 供应商预设库（ProviderProfile）类型与解析（2026-09-07 对齐 claude-code/cc-switch）
 *
 * 核心设计：一个供应商 = settingsConfig 整段 JSON（与 cc-switch 同形状，env 块是载体）
 * + meta（apiFormat/modelsUrl 等）。因此 cc-switch 里复制的配置可以原样粘贴使用。
 *
 * 存储：~/.wonwork/providers.json（后端只存取文本，schema 归本文件）；
 * localStorage 缓存键 wonwork_provider_profiles 作离线/standalone 兜底。
 *
 * 运行派生：deriveProfileRuntime 是唯一解析点——把 env 块翻译成
 * WonWork 生效链需要的 {providerId, clientFormat, baseUrl, apiKey, model}。
 * providerId 用 `profile:<id>` 命名空间，与内置 provider id 不冲突。
 */

/** 下拉/生效链里的 profile 命名空间前缀 */
export const PROFILE_PROVIDER_PREFIX = 'profile:'

export type ProviderApiFormat = 'anthropic' | 'openai'

export type ProviderProfileCategory =
  | 'official'
  | 'cn_official'
  | 'aggregator'
  | 'third_party'
  | 'custom'

export interface ProviderProfile {
  id: string
  name: string
  category?: ProviderProfileCategory
  websiteUrl?: string
  notes?: string
  /** cc-switch 兼容：整段 settings.json 形状，env 块是供应商配置载体 */
  settingsConfig: { env: Record<string, string>; [key: string]: unknown }
  meta: {
    apiFormat: ProviderApiFormat
    /** 模型清单端点覆写（空=按候选推导） */
    modelsUrl?: string
  }
  createdAt: number
}

/** providers.json 文件形状 */
export interface ProviderProfileFile {
  version: 1
  activeId: string | null
  profiles: ProviderProfile[]
  /** 整段写入时间戳（2026-09-07 增）：后端文件与 localStorage 缓存分叉时新的赢——
      此前无戳，"PUT 失败后刷新页面"会让后端旧数据覆盖缓存里的新数据（刚加的供应商消失） */
  updatedAt?: number
}

export function emptyProfileFile(): ProviderProfileFile {
  return { version: 1, activeId: null, profiles: [] }
}

/** 生效链派生结果：resolveProviderCredentials / modelClient 共用 */
export interface DerivedProfileRuntime {
  /** `profile:<id>` */
  providerId: string
  clientFormat: ProviderApiFormat
  baseUrl: string
  apiKey?: string
  model: string
  /** anthropic 系的小快模型（ANTHROPIC_SMALL_FAST_MODEL），暂作保留事实 */
  smallFastModel?: string
}

/**
 * 唯一解析点：settingsConfig.env → 运行视图。
 * apiFormat=anthropic 读 ANTHROPIC_* 键，openai 读 OPENAI_* 键；
 * env 其余键原样留在 settingsConfig 里不丢（后续按需映射进请求层）。
 * 关键字段缺失返回 null（该 profile 不可用于对话）。
 */
export function deriveProfileRuntime(profile: ProviderProfile): DerivedProfileRuntime | null {
  const env = profile.settingsConfig?.env ?? {}
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = env[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return undefined
  }

  if (profile.meta?.apiFormat === 'anthropic') {
    const baseUrl = pick('ANTHROPIC_BASE_URL')
    const model = pick('ANTHROPIC_MODEL')
    if (!baseUrl || !model) return null
    return {
      providerId: PROFILE_PROVIDER_PREFIX + profile.id,
      clientFormat: 'anthropic',
      baseUrl,
      apiKey: pick('ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'),
      model,
      smallFastModel: pick('ANTHROPIC_SMALL_FAST_MODEL'),
    }
  }

  const baseUrl = pick('OPENAI_BASE_URL', 'OPENAI_API_BASE')
  const model = pick('OPENAI_MODEL')
  if (!baseUrl || !model) return null
  return {
    providerId: PROFILE_PROVIDER_PREFIX + profile.id,
    clientFormat: 'openai',
    baseUrl,
    apiKey: pick('OPENAI_API_KEY'),
    model,
  }
}

export function isProfileProviderId(providerId: string): boolean {
  return providerId.startsWith(PROFILE_PROVIDER_PREFIX)
}

export function profileIdFromProviderId(providerId: string): string | null {
  return isProfileProviderId(providerId) ? providerId.slice(PROFILE_PROVIDER_PREFIX.length) : null
}

export function generateProfileId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 解析粘贴的 cc-switch 配置（"复制过来就能用"的入口）。
 * 宽容三种形状：
 *   1. cc-switch 供应商对象 {name, settingsConfig:{env:{...}}, websiteUrl, ...}
 *   2. 裸 settingsConfig {env:{...}}
 *   3. claude-code settings.json 整段（含 env 键，可能有 permissions 等其他键——原样保留）
 * 识别 apiFormat：有 ANTHROPIC_* 键 → anthropic；有 OPENAI_* 键 → openai；皆无 → null。
 */
export function parsePastedProviderConfig(raw: string): {
  name?: string
  websiteUrl?: string
  settingsConfig: { env: Record<string, string>; [key: string]: unknown }
  apiFormat: ProviderApiFormat
} | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const obj = parsed as Record<string, unknown>
  // 形状 1：cc-switch 供应商对象（settingsConfig 嵌套）
  const container =
    obj.settingsConfig && typeof obj.settingsConfig === 'object' && !Array.isArray(obj.settingsConfig)
      ? (obj.settingsConfig as Record<string, unknown>)
      : obj
  const envRaw = container.env
  if (!envRaw || typeof envRaw !== 'object' || Array.isArray(envRaw)) return null

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(envRaw as Record<string, unknown>)) {
    if (typeof v === 'string') env[k] = v
    else if (typeof v === 'number' || typeof v === 'boolean') env[k] = String(v)
  }

  const hasAnthropic = !!env.ANTHROPIC_BASE_URL || !!env.ANTHROPIC_AUTH_TOKEN || !!env.ANTHROPIC_API_KEY
  const hasOpenAI = !!env.OPENAI_BASE_URL || !!env.OPENAI_API_KEY
  if (!hasAnthropic && !hasOpenAI) return null

  return {
    name: typeof obj.name === 'string' ? obj.name : undefined,
    websiteUrl: typeof obj.websiteUrl === 'string' ? obj.websiteUrl : undefined,
    settingsConfig: { ...container, env },
    apiFormat: hasAnthropic ? 'anthropic' : 'openai',
  }
}
