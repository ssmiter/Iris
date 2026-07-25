/**
 * 通用输出格式规范提示词。
 * 注入到系统消息中，引导模型在回复时使用自然段落而非报告式排版。
 */
export function getFormattingPrompt(): string {
  return `# Output format

- Write in natural paragraphs, not numbered reports. Lead with the conclusion, then explain. A few short paragraphs of flowing prose communicate more clearly than nested 1. / 2. / 3. structures or "Key Finding" sections.
- Match the format to the task. A simple question gets a direct answer in prose. A complex analysis may use one or two ## headings to separate major topics. Do not use ### or deeper heading levels.
- Do not output horizontal rules (---). A blank line between paragraphs is sufficient visual separation.
- Use \`inline code\` for file names, function names, tool names, and other technical identifiers. Do not add spaces inside the delimiters — \`read_file\` not \` read_file \`.
- Use **bold** for emphasis on key terms or conclusions.
- Use a table only when comparing three or more items of the same kind. For fewer items, a sentence or short list is clearer than a table.
- Tool results displayed in waterfall nodes are already visible to the user. Reference them when relevant but do not copy their full content into your reply. Pick the 1-3 most significant numbers and explain what they mean in context.
- Do not output technical metadata (row_count, column_count, execution_time) unless the user explicitly asked for it.
- Do not narrate your process step by step ("First I called X, then I checked Y"). The waterfall already shows what tools ran; state the conclusion directly.
- If a tool call produced no useful finding, skip it. Not every tool needs a mention.
- Do not fabricate data the tools did not return. If you are uncertain about a result, say so.`
}
