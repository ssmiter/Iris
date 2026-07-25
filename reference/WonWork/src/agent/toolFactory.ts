import type {
  Tool,
  ToolExecutionContext,
  ToolRiskLevel,
  ToolPermissionContext,
  PermissionResult,
} from './types'

/**
 * createTool 工厂选项
 *
 * 采用 fail-closed 默认值：未显式声明的属性默认按最保守策略处理，
 * 避免新增工具时因遗漏字段而导致并发/权限/风险判断错误。
 */
export interface CreateToolOptions<TInput, TOutput> {
  name: string
  description: string
  inputSchema: unknown
  execute: (input: TInput, ctx: ToolExecutionContext) => Promise<TOutput>
  riskLevel?: ToolRiskLevel
  isReadOnly?: boolean | ((input: TInput) => boolean)
  isConcurrencySafe?: boolean | ((input: TInput) => boolean)
  isDestructive?: boolean | ((input: TInput) => boolean)
  requiredPermissions?: string[]
  maxResultSizeChars?: number
  category?: string
  usagePrompt?: string
  examples?: Array<{ input: TInput; notes?: string }>
  /** 自定义校验函数 */
  validateInput?: (input: unknown) => { valid: boolean; error?: string }
  /** 自定义权限检查 */
  checkPermissions?: (input: TInput, context: ToolPermissionContext) => PermissionResult
  strict?: boolean
  outputSchema?: unknown
  /** 是否强制始终加载到模型上下文（覆盖延迟加载） */
  alwaysLoad?: boolean
}

const DEFAULT_MAX_RESULT_CHARS = 10_000

/**
 * 创建完整的 Tool 定义，自动填充安全默认值。
 *
 * 默认策略：
 * - riskLevel: 'standard'
 * - isReadOnly: false
 * - isConcurrencySafe: false
 * - isDestructive: false
 * - requiredPermissions: []
 * - maxResultSizeChars: 10000
 */
export function createTool<TInput, TOutput>(
  opts: CreateToolOptions<TInput, TOutput>
): Tool<TInput, TOutput> {
  return {
    riskLevel: 'standard',
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: false,
    requiredPermissions: [],
    maxResultSizeChars: DEFAULT_MAX_RESULT_CHARS,
    alwaysLoad: opts.alwaysLoad ?? false,
    ...opts,
  }
}
