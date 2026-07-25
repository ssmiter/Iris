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
  /** 已通过 tool_search 发现的延迟加载工具名 */
  discoveredToolNames?: Set<string>
  /** Provider 是否支持 defer_loading beta（Anthropic 协议） */
  supportsDeferredLoading?: boolean
  /** 被权限规则拒绝、不应暴露给模型的工具名 */
  deniedToolNames?: Set<string>
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

/** 工具描述字符数预算上限（保守值，后续可按模型上下文精确调整） */
const MAX_TOOL_DESCRIPTION_CHARS = 16000

/** 核心前端本地原语：即使未显式标记 alwaysLoad，也不应在预算保护时被丢弃 */
const CORE_PRIMITIVE_NAMES = new Set([
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
])

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export class FrontendToolRegistry {
  private tools = new Map<string, Tool<any, any>>()
  private riskRules: RiskInferenceRule[]
  private systemCode?: string

  constructor(options?: FrontendToolRegistryOptions) {
    this.systemCode = options?.systemCode
    this.riskRules = options?.riskRules?.length
      ? [...options.riskRules, ...DEFAULT_RISK_RULES]
      : [...DEFAULT_RISK_RULES]
  }

  register(tool: Tool<any, any>): void {
    this.tools.set(tool.name.toLowerCase(), tool)
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
        inputSchema: item.parameters ?? {},
        riskLevel,
        isReadOnly,
        isConcurrencySafe: item.isConcurrencySafe ?? isReadOnly,
        isDestructive,
        requiredPermissions: item.requiredPermissions,
        maxResultSizeChars: item.maxResultSizeChars ?? 50000,
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
    if (lowerCategory === 'demo' || lowerCategory === 'local') return false

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
   * - alwaysLoad 工具或 discoverable 工具始终包含。
   * - 当 Provider 支持 defer_loading 时，未发现的 deferred 工具也会以
   *   defer_loading: true 形式发送，供模型通过 tool_search 发现。
   * - 当 Provider 不支持时，未发现的 deferred 工具会被过滤（前端兜底）。
   * - tool_search 自身始终包含（如果已注册）。
   */
  toToolDefinitions(options?: ToolDefinitionsOptions): ToolDefinition[] {
    const {
      discoveredToolNames = new Set<string>(),
      supportsDeferredLoading = false,
      deniedToolNames,
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

    // 简单字符数预算保护：超过上限时仅保留 alwaysLoad 与核心原语
    const estimatedChars = JSON.stringify(
      candidateTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      }))
    ).length

    const toolsToExpose =
      estimatedChars > MAX_TOOL_DESCRIPTION_CHARS
        ? candidateTools.filter(
            (tool) =>
              tool.alwaysLoad ||
              CORE_PRIMITIVE_NAMES.has(tool.name.toLowerCase())
          )
        : candidateTools

    return toolsToExpose.map((tool) => {
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
   * 获取当前可被 tool_search 发现的延迟加载工具列表。
   */
  getDeferredTools(): Tool<any, any>[] {
    return this.list().filter(
      (tool) =>
        tool.deferred &&
        !tool.alwaysLoad &&
        tool.name.toLowerCase() !== 'tool_search'
    )
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
