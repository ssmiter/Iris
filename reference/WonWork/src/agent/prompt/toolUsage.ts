import { composeSections } from './compose'
import { MAIN_SECTIONS } from './sections'
import type { PromptContext } from './types'

/**
 * 工具使用元认知提示（主提示词 tool_usage 段）。
 *
 * 让模型清楚：自己有哪些工具、何时调用、如何串并行、何时停止、出错怎么办。
 * 不绑定具体工具 schema，schema 由运行时 registry 动态注入（callable-tools 节）。
 * 小节体系见 sections/index.ts——顺序即编号，交叉引用用 {ref:id}。
 */
export function buildToolUsagePrompt(ctx: PromptContext): string {
  return `## 工具使用原则（元认知）

你是一个智能体助手。你的目标是通过合理调用工具，一步步解决用户问题。请始终保持对自身状态、可用工具、用户目标和已执行步骤的清晰认知。

${composeSections(ctx, MAIN_SECTIONS)}`
}
