import type { FrontendToolRegistry } from '@/agent/toolRegistry'
import type { CapabilityRegistry } from '@/utils/capabilityRegistry'
import type { RuntimeMode } from '@/utils/runtimeMode'

/**
 * 主提示词元认知体系的构建上下文（与旧 localToolPrompt 的 ToolPromptContext 同形）。
 */
export interface PromptContext {
  mode: RuntimeMode
  registry: FrontendToolRegistry
  capabilities: CapabilityRegistry
}

/**
 * 一个提示词小节 = 自治的 builder：自己的标题、注入条件、正文。
 * 编号与排序由组合器按 sections 数组顺序统一生成（见 compose.ts）。
 *
 * 新增主题的流程：在 sections/ 下加一个 def + 在 sections/index.ts 数组里加一行，
 * 不需要碰其他任何小节；交叉引用写 {ref:目标id} 或 {ref:目标id|目标未注入时的兜底文案}。
 */
export interface PromptSectionDef {
  /** 稳定 id，供 {ref:id} 交叉引用 */
  id: string
  /** 节标题（不含编号——编号由组合器生成） */
  title: string
  /**
   * 缓存纪律（对齐 claude-code 的 static/dynamic 边界思想）：
   * static = 逐字节稳定，同模式下不随会话/日期变化；
   * session = 含日期目录、项目路径等会话级变量。
   * session 节不允许排在 static 节之前（组合器会告警），保护 DeepSeek 前缀缓存。
   */
  stability: 'static' | 'session'
  /** 条件注入：缺省恒注入 */
  when?: (ctx: PromptContext) => boolean
  /** 正文（不含 ### 标题行；可含 {ref:其他节id} 占位，组合时替换为实际节号） */
  build: (ctx: PromptContext) => string
}
