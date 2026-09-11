import { buildToolUsagePrompt } from './toolUsage'
import { buildFileHandlingPrompt } from './fileHandling'
import { buildSafetyPrompt } from './safety'
import type { PromptContext } from './types'

export type { PromptContext, PromptSectionDef } from './types'
export { composeSections } from './compose'
export { buildAnswerLanguageNote } from './answerLanguage'
export {
  buildSubagentDiscoveryNote,
  buildSubagentSqlNote,
  buildSubagentFeedbackNatureNote,
} from './subagentNotes'
export type { SubagentSqlVariant } from './subagentNotes'

/**
 * 生成完整的工具/文件/安全系统提示片段（供 systemPromptBuilder 使用）。
 * 签名与旧 localToolPrompt.buildToolPromptSections 保持一致，接线零改动。
 */
export function buildToolPromptSections(
  ctx: PromptContext
): Array<{ section: 'tool_usage' | 'file_handling' | 'safety'; content: string }> {
  return [
    { section: 'tool_usage', content: buildToolUsagePrompt(ctx) },
    { section: 'file_handling', content: buildFileHandlingPrompt(ctx.mode) },
    { section: 'safety', content: buildSafetyPrompt(ctx.mode) },
  ]
}
