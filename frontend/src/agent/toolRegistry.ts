import type {
  Tool,
  ToolCall,
  ToolDefinition,
  ToolRiskLevel,
} from './types'
import type { ToolCatalogItem, ToolLoadStrategy } from '@/types/mescli'
import { toolApi } from '@/api/client'

/**
 * 求值可能是静态布尔或输入相关函数的工具元数据标志。
 */
export function evaluateToolFlag<TInput>(
  flag: boolean | ((input: TInput) => boolean) | undefined,
  input: TInput,
  defaultValue = false
): boolean {
  if (flag === undefined) return defaultValue
  if (typeof flag === 'function') {
    try {
      return flag(input)
    } catch {
      return defaultValue
    }
  }
  return flag
}
/**
 * 前端 ToolRegistry 镜像
 *
 * - MESCLI 模式下从后端 /api/capabilities 拉取工具目录；
 * - 后端未返回 riskLevel / isReadOnly 时，按工具名关键词兜底推断；
 * - Standalone 模式下返回空列表（或未来从 skill 生成只读镜像）。
 *
 * 重要：前端推断仅用于 UI 警示与执行分区提示，**不拦截**实际调用；
 * 真实权限与执行控制以后端为准。
 */

export interface RiskInferenceRule {
  pattern: RegExp
  riskLevel: ToolRiskLevel
  isReadOnly?: boolean
}

export interface FrontendToolRegistryOptions {
  systemCode?: string
  /** 覆盖默认推断规则 */
  riskRules?: RiskInferenceRule[]
}

export interface ToolDefinitionsOptions {
  /** 已通过的发现链路（read_capability）加载的延迟加载工具名 */
  discoveredToolNames?: Set<string>
  /**
   * 发现工具的租约表（小写名 → 最近使用时间戳，2026-08-05 租约式生命周期）。
   * 提供后 tier 1 按"最新优先"装入、预算不足时驱逐最久未用（状态性降回 deferred）；
   * 不提供则退化为旧行为（tier 1 内按注册序，裁新不裁旧，仅当轮临时裁剪）。
   */
  toolLastUsedAt?: Map<string, number>
  /** 租约驱逐回调：被降回 deferred 的工具名（小写），由 loop 侧同步发现集与持久化 */
  onEvict?: (names: string[]) => void
  /** Provider 是否支持 defer_loading beta（Anthropic 协议） */
  supportsDeferredLoading?: boolean
  /** 被权限规则拒绝、不应暴露给模型的工具名 */
  deniedToolNames?: Set<string>
  /** 本轮工具 schema 预算（字符），由 loop 按窗口百分比计算（computeToolBudgetChars）；
   *  缺省走 MIN 下限=旧行为 */
  budgetChars?: number
}

const DEFAULT_RISK_RULES: RiskInferenceRule[] = [
  {
    pattern: /execute_sql_query/,
    riskLevel: 'elevated',
    isReadOnly: true,
  },
  {
    pattern: /\b(get|list|search|query|select|find|fetch|describe|show|trace)\b/,
    riskLevel: 'read_only',
    isReadOnly: true,
  },
  {
    pattern: /\b(create|insert|update|modify|write|export|generate|render|build|send|start)\b/,
    riskLevel: 'standard',
    isReadOnly: false,
  },
  {
    pattern: /\b(delete|remove|drop|truncate|disable|destroy|purge|clear)\b/,
    riskLevel: 'destructive',
    isReadOnly: false,
  },
]

/** 工具描述字符数预算下限（保守值，小窗口行为与 2026-08-05 前逐字节一致=零回归） */
const MIN_TOOL_DESCRIPTION_BUDGET_CHARS = 16000
/** 工具描述字符数预算上限（1M 窗口触顶 ≈ 26K tokens ≈ 窗口 2.6%；缓存命中价下
 *  schema token 便宜，贵的是 miss，天花板无需随窗口继续上调） */
const MAX_TOOL_DESCRIPTION_BUDGET_CHARS = 65536
/** 预算占上下文窗口的 token 比例（对齐 claude-code ENABLE_TOOL_SEARCH=auto:N% 思路） */
const TOOL_BUDGET_WINDOW_RATIO = 0.05
/** 字符↔token 换算系数（claude-code toolSearch 同款启发式 chars/2.5） */
const CHARS_PER_TOKEN = 2.5

/**
 * 工具 schema 预算（2026-08-05 阶段 3）：按上下文窗口百分比计算，带字符上下界。
 * 1M 窗口（DeepSeek 主力）→ 触顶 65536；256K → 32000；128K 及以下 → 16000（与旧行为一致）。
 */
export function computeToolBudgetChars(contextWindowTokens: number): number {
  const scaled = Math.round(contextWindowTokens * TOOL_BUDGET_WINDOW_RATIO * CHARS_PER_TOKEN)
  return Math.min(
    MAX_TOOL_DESCRIPTION_BUDGET_CHARS,
    Math.max(MIN_TOOL_DESCRIPTION_BUDGET_CHARS, scaled)
  )
}

/**
 * 租约驱逐滞回水位（2026-08-05）：触发驱逐时一次降到预算的 80%，而非刚好够放。
 * 连续发现场景下摊薄驱逐事件（一次驱逐腾出一段空间），避免每发现一个驱逐一个、
 * 连续推动前缀缓存断点。
 */
const EVICTION_HYSTERESIS_RATIO = 0.8

/** 核心前端本地原语：即使未显式标记 alwaysLoad，也不应在预算保护时被丢弃 */
const CORE_PRIMITIVE_NAMES = new Set([
  'tool_search', // 已 deprecated（v1.6），保留仅为兼容旧后端目录
  'list_capabilities',
  'read_capability',
  'read_file',
  'write_file',
  'str_replace',
  'list_files',
  'glob',
  'grep',
  'delete_file',
  'web_search',
  'web_fetch',
])

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export class FrontendToolRegistry {
  private tools = new Map<string, Tool<any, any>>()
  private riskRules: RiskInferenceRule[]
  private systemCode?: string
  /** 预算裁剪通知（裁剪集合变化时生成一次，由 agenticLoop 消费注入 system 尾部） */
  private pendingBudgetNotice: string | null = null
  private lastBudgetDropFingerprint = ''

  constructor(options?: FrontendToolRegistryOptions) {
    this.systemCode = options?.systemCode
    this.riskRules = options?.riskRules?.length
      ? [...options.riskRules, ...DEFAULT_RISK_RULES]
      : [...DEFAULT_RISK_RULES]
  }

  register(tool: Tool<any, any>): void {
    this.tools.set(tool.name.toLowerCase(), tool)
  }

  /**
   * 租约驱逐（2026-08-05）：把发现工具原位降回 deferred。
   * 原地翻标志、不重注册——保住注册表插入序（前缀缓存保序的关键，见 toToolDefinitions 注释）；
   * 工具仍留在 registry，模型凭历史记忆直接调用时照常可执行，
   * 也可经 grep /capabilities → read_capability 找回（找回即最新租约）。
   */
  demoteToDeferred(name: string): boolean {
    const tool = this.tools.get(name.toLowerCase())
    if (!tool || tool.deferred) return false
    tool.deferred = true
    return true
  }

  get(name: string): Tool<any, any> | undefined {
    return this.tools.get(name.toLowerCase())
  }

  list(): Tool<any, any>[] {
    return Array.from(this.tools.values())
  }

  listByRisk(level: ToolRiskLevel): Tool<any, any>[] {
    return this.list().filter((t) => t.riskLevel === level)
  }

  /**
   * 按读写分区：只读调用可并发，写调用需串行/审批。
   * 当输入已知时，会按输入动态求值 isReadOnly；否则回退静态声明。
   */
  partitionReadWrite(
    calls: ToolCall[],
    argsByCall?: Map<string, Record<string, unknown>>
  ): { readonly: ToolCall[]; write: ToolCall[] } {
    const readonly: ToolCall[] = []
    const write: ToolCall[] = []
    for (const call of calls) {
      const tool = this.get(call.name)
      const args = argsByCall?.get(call.id)
      const readOnly = args
        ? evaluateToolFlag(tool?.isReadOnly, args, false)
        : evaluateToolFlag(tool?.isReadOnly, {}, false)
      if (readOnly) {
        readonly.push(call)
      } else {
        write.push(call)
      }
    }
    return { readonly, write }
  }

  inferRiskLevel(name: string): ToolRiskLevel {
    const lower = name.toLowerCase()
    for (const rule of this.riskRules) {
      if (rule.pattern.test(lower)) {
        return rule.riskLevel
      }
    }
    return 'standard'
  }

  inferIsReadOnly(name: string): boolean {
    const lower = name.toLowerCase()
    for (const rule of this.riskRules) {
      if (rule.isReadOnly !== undefined && rule.pattern.test(lower)) {
        return rule.isReadOnly
      }
    }
    // 无显式规则：只读关键词为 true，写关键词为 false，默认保守 false
    if (/\b(get|list|search|query|select|find|fetch|describe|show|trace)\b/.test(lower)) return true
    if (/\b(create|insert|update|modify|write|export|generate|render|build|send|start|delete|remove|drop|truncate|disable|destroy|purge|clear)\b/.test(lower)) {
      return false
    }
    return false
  }

  /**
   * 从后端能力清单加载工具目录
   */
  async loadFromBackend(systemCode?: string): Promise<void> {
    const code = systemCode ?? this.systemCode
    const items = await toolApi.capabilities(code)
    this.loadFromCatalog(items)
  }

  /**
   * 从 ToolCatalogItem 数组构建镜像
   */
  loadFromCatalog(items: ToolCatalogItem[]): void {
    this.tools.clear()
    for (const item of items) {
      const name = item.name
      const riskLevel = item.riskLevel ?? this.inferRiskLevel(name)
      const isReadOnly = item.isReadOnly ?? this.inferIsReadOnly(name)
      const isDestructive = riskLevel === 'destructive'
      const deferred = this.inferDeferred(name, item.category, item.loadStrategy, item.alwaysLoad, item.deferred)
      const tool: Tool = {
        name,
        description: item.description,
        usagePrompt: item.prompt?.trim() || undefined,
        inputSchema: item.parameters ?? {},
        riskLevel,
        isReadOnly,
        isConcurrencySafe: item.isConcurrencySafe ?? isReadOnly,
        isDestructive,
        requiredPermissions: item.requiredPermissions,
        maxResultSizeChars: item.maxResultSizeChars ?? 50000,
        // 后端元数据/配置给出的超时一路透传（v1.6 最后一跳，2026-08-13）：
        // 长链路工具（如 APS 确认排产）前端等待预算与后端执行预算对齐，
        // 不再出现后端还在跑、前端 120s 先判超时；+5s 宽限保证后端超时
        // 错误块先于前端放弃到达（用户看到后端语义化文案而非裸超时）
        timeoutMs: item.defaultTimeoutMs != null ? item.defaultTimeoutMs + 5000 : undefined,
        category: item.category,
        deferred,
        alwaysLoad: item.alwaysLoad,
        strict: item.strict,
        tier: item.tier,
        loadStrategy: item.loadStrategy,
        operationType: item.operationType,
        approvalMode: item.approvalMode,
        requiresApproval: item.requiresApproval,
        impactStatement: item.impactStatement,
        idempotent: item.idempotent,
        affectedEntityTypes: item.affectedEntityTypes,
      }
      this.register(tool)
    }
  }

  /**
   * 判断工具是否默认延迟加载。
   *
   * 规则（v1.4）：
   * - 后端显式声明 loadStrategy 时优先使用。
   * - alwaysLoad 为 true 的强制始终加载。
   * - 未声明时，文件/web 等前端本地原语始终加载；MES/SQL/MCP 类默认延迟。
   */
  private inferDeferred(
    name: string,
    category?: string,
    loadStrategy?: ToolLoadStrategy,
    alwaysLoad?: boolean,
    explicitDeferred?: boolean
  ): boolean {
    if (alwaysLoad) return false
    if (loadStrategy === 'always_load') return false
    if (loadStrategy === 'deferred') return true
    if (explicitDeferred !== undefined) return explicitDeferred

    const lowerCategory = (category || '').toLowerCase()
    if (lowerCategory === 'local') return false

    const lower = name.toLowerCase()
    // 已知前端本地原语和通用工具始终加载
    if (
      [
        'tool_search',
        'list_capabilities',
        'read_capability',
        'read_file',
        'write_file',
        'str_replace',
        'list_files',
        'glob',
        'grep',
        'delete_file',
        'web_search',
        'web_fetch',
      ].includes(lower)
    ) {
      return false
    }
    // MES、SQL、MCP、report 等后端大量工具默认延迟
    if (
      /\b(mes|mcp|sql|query|workflow|report|erp|wms|scm|api_|integration)/.test(lower) &&
      !/\b(get|list|search|describe|show)\b/.test(lower)
    ) {
      return true
    }
    return false
  }

  /**
   * 将当前 registry 中的工具导出为 Provider 可用的 tools 定义。
   *
   * - alwaysLoad 工具或已发现（read_capability 加载）的工具始终包含。
   * - 当 Provider 支持 defer_loading 时，未发现的 deferred 工具也会以
   *   defer_loading: true 形式发送，供模型经 grep /capabilities 发现。
   * - 当 Provider 不支持时，未发现的 deferred 工具会被过滤（前端兜底）。
   * - 发现原语（list_capabilities / read_capability / grep 等）始终包含（如果已注册）。
   */
  toToolDefinitions(options?: ToolDefinitionsOptions): ToolDefinition[] {
    const {
      discoveredToolNames = new Set<string>(),
      toolLastUsedAt,
      onEvict,
      supportsDeferredLoading = false,
      deniedToolNames,
      budgetChars = MIN_TOOL_DESCRIPTION_BUDGET_CHARS,
    } = options ?? {}

    const candidateTools = this.list().filter((tool) => {
      const lower = tool.name.toLowerCase()
      if (deniedToolNames?.has(lower)) return false
      if (tool.alwaysLoad) return true
      if (CORE_PRIMITIVE_NAMES.has(lower)) return true
      if (tool.deferred) {
        if (supportsDeferredLoading) return true
        return discoveredToolNames.has(lower)
      }
      return true
    })

    // 预算保护（2026-07-28 重构；2026-08-05 租约式生命周期升级）：
    // 原实现超限即丢光所有非核心工具——已加载工具被静默卸载，模型下一轮"工具不存在"死循环。
    // 第一次修复改分层贪心保留：tier 0 核心原语/alwaysLoad（无条件保留）
    // → tier 1 已发现 → tier 2 常驻普通 → tier 3 未发现延迟，按序装入直到预算耗尽。
    // 租约升级：提供 toolLastUsedAt 时，tier 1 内按"最新优先"装入——装不下的必然是最久
    // 未用的老租约，做状态性驱逐（原位降回 deferred，见 demoteToDeferred），从根上消除
    // "裁新不裁旧"死循环（新发现/刚续租的工具永远最先装入 = I1 新工具必达）；
    // 被逐工具仍留在 registry，可经 grep /capabilities + read_capability 找回（找回即最新租约）。
    const sizeOf = (tool: Tool): number =>
      JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      }).length

    const tierOf = (tool: Tool): number => {
      const lower = tool.name.toLowerCase()
      if (tool.alwaysLoad || CORE_PRIMITIVE_NAMES.has(lower)) return 0
      if (discoveredToolNames.has(lower)) return 1
      if (tool.deferred) return 3
      return 2
    }

    const leaseOf = (tool: Tool): number =>
      toolLastUsedAt?.get(tool.name.toLowerCase()) ?? 0

    const toolsToExpose: Tool[] = []
    const droppedForBudget: Tool[] = []
    const evictedLeases: Tool[] = []
    let usedChars = 0
    const sortedByTier = [...candidateTools].sort((a, b) => {
      const tierDiff = tierOf(a) - tierOf(b)
      if (tierDiff !== 0) return tierDiff
      // 租约模式：tier 1 内最新优先（只影响"保谁"的选择序，输出仍回注册表插入序）
      if (toolLastUsedAt && tierOf(a) === 1) return leaseOf(b) - leaseOf(a)
      return 0
    })
    for (const tool of sortedByTier) {
      const size = sizeOf(tool)
      if (tierOf(tool) === 0 || usedChars + size <= budgetChars) {
        toolsToExpose.push(tool)
        usedChars += size
      } else if (toolLastUsedAt && tierOf(tool) === 1) {
        evictedLeases.push(tool)
      } else {
        droppedForBudget.push(tool)
      }
    }

    // 状态性驱逐 + 滞回：触发驱逐时一次降到预算 80%（EVICTION_HYSTERESIS_RATIO），
    // 摊薄连续发现时的驱逐事件——前缀缓存断点只在事件轮移动，稳态逐字节不动（I2）。
    // 驱逐时机搭新发现的便车：断点本来就要被新工具推动，同轮降回老工具边际缓存成本≈0。
    if (evictedLeases.length > 0) {
      const hysteresisTarget = Math.floor(budgetChars * EVICTION_HYSTERESIS_RATIO)
      const exposedTier1ByAge = toolsToExpose
        .filter((t) => tierOf(t) === 1)
        .sort((a, b) => leaseOf(a) - leaseOf(b))
      for (const tool of exposedTier1ByAge) {
        if (usedChars <= hysteresisTarget) break
        toolsToExpose.splice(toolsToExpose.indexOf(tool), 1)
        usedChars -= sizeOf(tool)
        evictedLeases.push(tool)
      }
      const evictedNames: string[] = []
      for (const tool of evictedLeases) {
        if (this.demoteToDeferred(tool.name)) evictedNames.push(tool.name.toLowerCase())
      }
      if (evictedNames.length > 0) onEvict?.(evictedNames)
    }

    // 前缀缓存保序（2026-08-01 审计 P0，四路独立确认）：tier 重排只用于"预算不够时保谁"
    // 的选择优先级，输出必须回到注册表插入序。此前直接按 tier 序输出——read_capability
    // 每发现一个工具就把它从 tier3 尾部搬到 tier1 前部（~第12位），tools 段中段插入，
    // 身后全部 tools+messages 前缀缓存作废（DeepSeek tools 渲染在缓存前缀最前区，
    // 发现密集型任务每发现一次全量 miss 一次）。保序后发现的工具原地翻 defer 标志，
    // 断点推到该工具自身位置（注册靠后的业务工具=断点尽量靠后），前方大块前缀仍可命中。
    const selectedSet = new Set(toolsToExpose)
    const orderedExpose = candidateTools.filter((t) => selectedSet.has(t))

    if (evictedLeases.length > 0) {
      const names = evictedLeases.map((t) => t.name)
      const fingerprint = `evict:${names.join(',')}`
      // 驱逐集合变化才生成通知——稳定态不重复注入，避免每轮打破前缀缓存
      if (fingerprint !== this.lastBudgetDropFingerprint) {
        this.lastBudgetDropFingerprint = fingerprint
        const preview = names.slice(0, 5).join('、') + (names.length > 5 ? ` 等 ${names.length} 个` : '')
        this.pendingBudgetNotice =
          `[系统提示] 工具定义预算不足，已卸载最久未使用的 ${names.length} 个工具：${preview}。` +
          `它们的完整定义已从上下文移除以腾出预算；你此前基于这些工具的真实返回得出的结论不受影响。` +
          `如需再次使用，请经 grep 检索 /capabilities、read_capability 重新加载（重新加载后当轮即可使用）。`
      }
      console.warn(
        `[FrontendToolRegistry] 工具预算不足，驱逐最久未用的 ${evictedLeases.length} 个工具:`,
        names
      )
    } else if (droppedForBudget.length > 0) {
      const names = droppedForBudget.map((t) => t.name)
      const fingerprint = names.join(',')
      // 裁剪集合变化才生成通知——稳定态不重复注入，避免每轮打破前缀缓存
      if (fingerprint !== this.lastBudgetDropFingerprint) {
        this.lastBudgetDropFingerprint = fingerprint
        const preview = names.slice(0, 5).join('、') + (names.length > 5 ? ` 等 ${names.length} 个` : '')
        this.pendingBudgetNotice =
          `[系统提示] 工具定义总预算（${budgetChars} 字符）不足，本次请求未加载 ${names.length} 个工具：${preview}。` +
          `这些工具仍可通过 grep 检索 /capabilities 或 list_capabilities 浏览定位、read_capability 加载后恢复可用；请勿直接调用未加载的工具名。`
      }
      console.warn(
        `[FrontendToolRegistry] 工具预算超限，裁剪 ${droppedForBudget.length} 个工具:`,
        names
      )
    } else {
      this.lastBudgetDropFingerprint = ''
      this.pendingBudgetNotice = null
    }

    return orderedExpose.map((tool) => {
        const lower = tool.name.toLowerCase()
        const isDiscovered = discoveredToolNames.has(lower)
        const isDeferred = tool.deferred && !tool.alwaysLoad && !CORE_PRIMITIVE_NAMES.has(lower)
        const deferLoading = supportsDeferredLoading && isDeferred && !isDiscovered

        return {
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema ?? {},
            ...(tool.strict ? { strict: true } : {}),
            ...(deferLoading ? { defer_loading: true } : {}),
          },
        }
      })
  }

  /**
   * 获取当前可被发现链路（grep /capabilities + read_capability）加载的延迟工具列表。
   */
  getDeferredTools(): Tool<any, any>[] {
    return this.list().filter(
      (tool) =>
        tool.deferred &&
        !tool.alwaysLoad &&
        tool.name.toLowerCase() !== 'tool_search' // tool_search 已 deprecated（v1.6），防御性排除
    )
  }

  /**
   * 消费预算裁剪通知（P0-6，2026-07-28）：toToolDefinitions 发生裁剪且裁剪集合
   * 相对上次发生变化时返回一次性通知文本，由 agenticLoop 注入本请求 system 尾部；
   * 无变化或无裁剪返回 null。消费后清空，避免重复注入。
   */
  consumeBudgetDropNotice(): string | null {
    const notice = this.pendingBudgetNotice
    this.pendingBudgetNotice = null
    return notice
  }

  /**
   * 便捷工厂：创建并预加载后端目录
   */
  static async create(systemCode?: string): Promise<FrontendToolRegistry> {
    const registry = new FrontendToolRegistry({ systemCode })
    try {
      await registry.loadFromBackend(systemCode)
    } catch (err) {
      console.warn('[FrontendToolRegistry] 加载后端工具目录失败，使用空镜像:', err)
    }
    return registry
  }
}

export function createToolRegistry(options?: FrontendToolRegistryOptions): FrontendToolRegistry {
  return new FrontendToolRegistry(options)
}

export { generateId as generateToolCallId }
