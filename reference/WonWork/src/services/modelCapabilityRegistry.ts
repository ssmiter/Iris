/**
 * 模型能力注册表（打磨任务7）
 *
 * 终态设计：窗口估计 = 区间收敛，不是单点猜测。
 * - windowLowerBound：上行校准，成功请求的 realTokensIn 证明窗口 ≥ 此值
 * - windowUpperBound：下行校准，400 错误解析出的精确 limit
 * - userOverride：用户显式设置（最高优先，但可被 400 证伪并提示）
 *
 * 解析优先级（对齐 claude-code context.ts:getContextWindowForModel 的精简版）：
 *   userOverride ?? windowUpperBound ?? max(名字猜测, windowLowerBound)
 *
 * 参考 claude-code src/utils/model/modelCapabilities.ts：
 * - schema 极简，只持久化能力字段
 * - sortForMatching：最长 id 优先，避免短 id 抢先子串匹配
 * - 失败静默，内容没变不写盘
 */
import { getModelContextWindow } from '@/utils/tokenEstimator'

export type CapabilitySource = 'user' | 'learned-400' | 'learned-usage' | 'api' | 'guess'

export interface ModelCapability {
  /** 匹配键：模型名（小写存储） */
  id: string
  /** 命名空间：同名模型不同 provider 能力可能不同 */
  provider: string
  /** 上行校准下界：成功请求证明窗口 ≥ 此值 */
  windowLowerBound?: number
  /** 下行校准上界：400 错误解析的精确 limit */
  windowUpperBound?: number
  /** 用户显式设置（最高优先） */
  userOverride?: number
  /** 同源学习的输出上限 */
  maxOutputTokens?: number
  source: CapabilitySource
  updatedAt: number
}

export type WindowSourceLabel = 'user' | 'learned' | 'api' | 'guess'

export interface ResolvedWindow {
  value: number
  source: WindowSourceLabel
}

/** 解析窗口输入：支持 128000 / 128k / 1m 写法，非法返回 null */
export function parseWindowInput(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/[,\s]/g, '')
  if (!s) return null
  const m = s.match(/^(\d+(?:\.\d+)?)(k|m)?$/)
  if (!m) return null
  const n = parseFloat(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const mult = m[2] === 'k' ? 1000 : m[2] === 'm' ? 1000000 : 1
  return Math.round(n * mult)
}

const STORAGE_KEY = 'wonwork.model-capabilities.v1'

function loadAll(): ModelCapability[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (c): c is ModelCapability =>
        c && typeof c.id === 'string' && typeof c.provider === 'string'
    )
  } catch {
    return []
  }
}

function saveAll(models: ModelCapability[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(models))
  } catch {
    // 失败静默（对齐 claude-code refreshModelCapabilities 的容错）
  }
}

/** 最长 id 优先：子串匹配时更具体的 id 先命中（对齐 claude-code sortForMatching） */
function sortForMatching(models: ModelCapability[]): ModelCapability[] {
  return [...models].sort(
    (a, b) => b.id.length - a.id.length || a.id.localeCompare(b.id)
  )
}

function findCapability(provider: string, model: string): ModelCapability | undefined {
  const all = sortForMatching(loadAll())
  const m = model.toLowerCase()
  const p = provider.toLowerCase()
  // 同 provider 精确匹配优先
  const exact = all.find(c => c.provider.toLowerCase() === p && c.id === m)
  if (exact) return exact
  // 同 provider 子串匹配
  const sameProvider = all.find(
    c => c.provider.toLowerCase() === p && m.includes(c.id)
  )
  if (sameProvider) return sameProvider
  // 跨 provider 兜底（用户切换 baseUrl 但模型相同的情况）
  return all.find(c => c.id === m)
}

function upsert(cap: ModelCapability): void {
  const all = loadAll()
  const idx = all.findIndex(
    c => c.provider.toLowerCase() === cap.provider.toLowerCase() && c.id === cap.id
  )
  if (idx >= 0) {
    all[idx] = { ...all[idx], ...cap, updatedAt: Date.now() }
  } else {
    all.push({ ...cap, updatedAt: Date.now() })
  }
  saveAll(all)
}

/**
 * 解析上下文窗口（四级链）：
 *   1. userOverride（用户显式设置）
 *   2. windowUpperBound（400 学到的精确值）
 *   3. max(名字猜测, windowLowerBound)（上行校准抬升）
 *   4. 名字猜测兜底
 */
export function resolveContextWindow(provider: string, model: string): ResolvedWindow {
  const guess = getModelContextWindow(model)
  const cap = findCapability(provider, model)
  if (!cap) return { value: guess, source: 'guess' }

  if (typeof cap.userOverride === 'number' && cap.userOverride > 0) {
    return { value: cap.userOverride, source: 'user' }
  }
  if (typeof cap.windowUpperBound === 'number' && cap.windowUpperBound > 0) {
    return { value: cap.windowUpperBound, source: 'learned' }
  }
  if (typeof cap.windowLowerBound === 'number' && cap.windowLowerBound > guess) {
    return { value: cap.windowLowerBound, source: 'learned' }
  }
  if (cap.source === 'api') {
    return { value: guess, source: 'api' }
  }
  return { value: guess, source: 'guess' }
}

/**
 * 从 400 错误消息解析真实窗口上限（对齐 claude-code errors.ts:parsePromptTooLongTokenCounts，
 * 并扩展 OpenAI 系格式）。宽容匹配：容忍 SDK 前缀、JSON 信封、大小写差异。
 */
export function parseContextLimitFromError(rawMessage: string): number | undefined {
  // Anthropic 系："prompt is too long: 137500 tokens > 135000 maximum"（limit 在 > 之后）
  const ptl = rawMessage.match(
    /prompt is too long[^0-9]*(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)/i
  )
  if (ptl) return parseInt(ptl[2].replace(/,/g, ''), 10)
  // OpenAI 系："This model's maximum context length is 131072 tokens"（limit 在前）
  const openai = rawMessage.match(
    /(?:maximum context length is|context length of|max(?:imum)? context (?:length|window))[^0-9]*?(\d[\d,]*)/i
  )
  if (openai) return parseInt(openai[1].replace(/,/g, ''), 10)
  return undefined
}

/**
 * 下行校准：400 错误解析出的窗口上限。
 * 若用户曾显式设置且被证伪（设置值 > 实测上限），清除该覆盖并返回标记——
 * 否则 resolve 永远优先 userOverride，会无限撞 400。告知由 UI 层 toast 完成，
 * 用户仍可在设置中重新修改（最终决定权在用户）。
 */
export function recordLearnedUpperBound(
  provider: string,
  model: string,
  limit: number
): { userOverrideFalsified: boolean } {
  if (!Number.isFinite(limit) || limit <= 0) return { userOverrideFalsified: false }
  const existing = findCapability(provider, model)
  const falsified =
    typeof existing?.userOverride === 'number' && existing.userOverride > limit
  upsert({
    id: model.toLowerCase(),
    provider,
    windowUpperBound: limit,
    // 证伪时显式清除用户覆盖（undefined 键在 JSON 持久化时自然消失）
    ...(falsified ? { userOverride: undefined } : {}),
    source: 'learned-400',
    updatedAt: Date.now(),
  })
  return { userOverrideFalsified: falsified }
}

/** 上行校准：成功请求的 realTokensIn 证明窗口 ≥ 此值 */
export function recordObservedLowerBound(
  provider: string,
  model: string,
  observedTokens: number
): void {
  if (!Number.isFinite(observedTokens) || observedTokens <= 0) return
  const existing = findCapability(provider, model)
  if (
    typeof existing?.windowLowerBound === 'number' &&
    existing.windowLowerBound >= observedTokens
  ) {
    return
  }
  // 成功请求的实测值是更强证据：若与已学上界矛盾（观测值 > 上界），清除上界
  const upperBoundFalsified =
    typeof existing?.windowUpperBound === 'number' &&
    observedTokens > existing.windowUpperBound
  upsert({
    id: model.toLowerCase(),
    provider,
    windowLowerBound: observedTokens,
    ...(upperBoundFalsified ? { windowUpperBound: undefined } : {}),
    source: existing?.source === 'learned-400' && !upperBoundFalsified
      ? existing.source
      : 'learned-usage',
    updatedAt: Date.now(),
  })
}

/** 用户显式覆盖（设置页） */
export function setUserWindowOverride(
  provider: string,
  model: string,
  value: number | null
): void {
  const existing = findCapability(provider, model)
  upsert({
    id: model.toLowerCase(),
    provider,
    userOverride: value && value > 0 ? value : undefined,
    source: value && value > 0 ? 'user' : existing?.source ?? 'guess',
    updatedAt: Date.now(),
  })
}

/**
 * 从错误消息解析模型输出上限（"max_tokens is too large: 64000. This model
 * supports at most 16384 output tokens."）。宽容匹配，解析不出返回 undefined。
 */
export function parseMaxOutputLimitFromError(rawMessage: string): number | undefined {
  if (!/max_tokens/i.test(rawMessage)) return undefined
  const m = rawMessage.match(
    /(?:at most|maximum of|supports up to|上限为?)[^0-9]*(\d[\d,]*)/i
  )
  if (m) return parseInt(m[1].replace(/,/g, ''), 10)
  return undefined
}

/** 学习输出上限（400 max_tokens 错误解析） */
export function recordLearnedMaxOutput(
  provider: string,
  model: string,
  limit: number
): void {
  if (!Number.isFinite(limit) || limit <= 0) return
  upsert({
    id: model.toLowerCase(),
    provider,
    maxOutputTokens: limit,
    source: 'learned-400',
    updatedAt: Date.now(),
  })
}

/** 查询已学习的输出上限（无则 undefined，调用方用自己的默认值） */
export function resolveMaxOutputTokens(provider: string, model: string): number | undefined {
  return findCapability(provider, model)?.maxOutputTokens
}

/** 查询某模型的完整能力记录（设置页展示用） */
export function getCapability(provider: string, model: string): ModelCapability | undefined {
  return findCapability(provider, model)
}
