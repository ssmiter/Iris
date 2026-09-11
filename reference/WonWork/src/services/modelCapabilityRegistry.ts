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
  /** 用户显式选择的思考强度档位（仅对声明支持的模型生效） */
  userEffort?: EffortLevel
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

// ===== 思考强度（effort）档位：语义照抄 claude-code src/utils/effort.ts =====

export type EffortLevel = 'low' | 'medium' | 'high' | 'max'

/** Claude/DeepSeek/OpenAI 风格档位（CC EFFORT_LEVELS 精简集，xhigh 暂不开放） */
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high']

/** Kimi K3 / GLM 5.2+ 风格档位：无 medium、有 max（官方枚举 low/high/max，发 medium 必 400） */
const TRI_EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'high', 'max']

/**
 * 模型是否支持 effort 参数（照抄 claude-code modelSupportsEffort 的判定哲学）：
 * **能力按模型家族判定、与协议链解耦**（2026-09-07/08 定版）——
 * 家族规则按「代际」写（主版本号比较），同家族新代发布自动覆盖、不用追名单；
 * 新家族进名单前必须核实官方文档（K2 实证：不支持 effort 的模型同发
 * thinking+reasoning_effort 必 400）。未知模型一律 false（CC 对 3P 未知默认不声明）。
 * wire 参数名由 apiFormat 决定（anthropic→output_config.effort / openai→reasoning_effort）。
 * effort 只在用户显式选档时才发送（默认不发送），上游不认时报错可见，
 * 用户改回"自动"即恢复不发送。
 */
export function modelSupportsEffort(provider: string, model: string): boolean {
  return isEffortCapableModelName(model.toLowerCase())
}

/** 该模型可展示的档位集：Kimi K3+/GLM 5.2+ 官方枚举是 low/high/max，其余用三档经典集 */
export function effortLevelsForModel(model: string): readonly EffortLevel[] {
  const m = model.toLowerCase()
  if (matchKimiGen(m) >= 3 || matchGlmGen(m) !== null) return TRI_EFFORT_LEVELS
  return EFFORT_LEVELS
}

/** 模型家族能力（链无关）：各家族官宣支持 effort 的代际并集（2026-09-08 核） */
function isEffortCapableModelName(m: string): boolean {
  // Claude：effort 自 4.6 代引入（opus-4-6/4-7、sonnet-4-6，CC 白名单同款），5 代起延续；
  // haiku 排除（CC 同款）。fable-5 等新命名由「主版本 ≥5」规则自动覆盖
  const claude = m.match(/(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?/)
  if (claude) {
    const major = +claude[1]
    const minor = +(claude[2] ?? 0)
    if (major >= 5 || (major === 4 && minor >= 6)) return true
  }
  // DeepSeek：V4 代起官宣 reasoning_effort（含 flash；CC 白名单的 deepseek-v4-pro 同款）
  const ds = m.match(/deepseek-v(\d+)/)
  if (ds && +ds[1] >= 4) return true
  if (m.includes('deepseek-chat')) return true
  // OpenAI 推理系：o1/o3/o4 前缀 + gpt-5 代起
  if (/^(?:o1|o3|o4)/.test(m)) return true
  const gpt = m.match(/gpt-(\d+)/)
  if (gpt && +gpt[1] >= 5) return true
  // Kimi：K3 代起官宣 reasoning_effort（low/high/max）；K2 只有 thinking 开关无档位
  if (matchKimiGen(m) >= 3) return true
  // GLM：5.2 代起官宣 reasoning_effort（5.2 全七档/5.3 三档且 thinking 恒开）；
  // 5.1 不支持 max 档，为保单一档位集不列入
  if (matchGlmGen(m) !== null) return true
  return false
}

/** Kimi 代际：kimi-k3 / k3 / k3-256k 等裸写都算；k 前须非字母数字防误命中，无命中返 0 */
function matchKimiGen(m: string): number {
  const k = m.match(/(?:^|[^a-z0-9])k(\d+)(?:[-.]|$)/)
  return k ? +k[1] : 0
}

/** GLM 代际：≥5.2 返回版本标记，否则 null（5.1 缺 max 档不入列，见上注） */
function matchGlmGen(m: string): true | null {
  const glm = m.match(/glm-(\d+)(?:\.(\d+))?/)
  if (!glm) return null
  const major = +glm[1]
  const minor = +(glm[2] ?? 0)
  return major > 5 || (major === 5 && minor >= 2) ? true : null
}

/** 用户显式选择的档位（设置持久化；null=恢复默认不发送） */
export function setUserEffort(provider: string, model: string, effort: EffortLevel | null): void {
  const existing = findCapability(provider, model)
  upsert({
    id: model.toLowerCase(),
    provider,
    userEffort: effort ?? undefined,
    source: existing?.source ?? 'guess',
    updatedAt: Date.now(),
  })
}

/**
 * 解析本次请求应发送的档位：仅当模型声明支持且用户显式选择过时返回，
 * 否则 undefined（= 不发送 effort 参数，上游用默认 high——CC resolveAppliedEffort 同款语义）。
 * 存储档位须在当前模型的档位集内（换模型后如 K3 无 medium，陈旧值自动回落"自动"）。
 */
export function resolveUserEffort(provider: string, model: string): EffortLevel | undefined {
  if (!modelSupportsEffort(provider, model)) return undefined
  const stored = findCapability(provider, model)?.userEffort
  if (!stored) return undefined
  return effortLevelsForModel(model).includes(stored) ? stored : undefined
}
