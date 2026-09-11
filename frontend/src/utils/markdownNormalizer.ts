/**
 * 对 LLM 输出的 Markdown 做规范化，修复常见排版错误，让 react-markdown + remark-gfm 能正确渲染。
 * 注意：normalizeMarkdown 会做去重等重写操作，因此只适合在流式输出结束后的最终渲染中使用。
 */
export function normalizeMarkdown(content: string): string {
  return dedupeConsecutiveBlocks(formatStreamingMarkdown(content))
}

/**
 * 流式输出期间的 Markdown 格式化。
 * LLM 有时会把表格行、标题、列表全部输出在同一行内（例如 `文本|表头|...||行|...|###标题- 列表`），
 * 导致 ReactMarkdown 无法识别 block 元素。该函数会把这种被压缩的结构拆回标准 Markdown，
 * 同时保留已经格式良好的内容。
 *
 * 围栏保护：代码块（```）内和行内代码（`...`）段一律不改动——
 * 否则 `a || b` 会被规则 3 拆成 `a |\n| b`、`##temp` 会被规则 1 插空格，显示出来的代码是错的。
 */
export function formatStreamingMarkdown(content: string): string {
  const text = content.replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const result: string[] = []
  let inCodeBlock = false

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock
      result.push(line)
      continue
    }
    if (inCodeBlock) {
      result.push(line)
      continue
    }
    result.push(applyStreamingRulesToLine(line))
  }

  // 7. 补表格前空行、标题空格（fixStreamingMarkdownSyntax 自身已有围栏跟踪）
  return fixStreamingMarkdownSyntax(result.join('\n'))
}

/** 对单行应用结构修复规则 1-6；行内代码段（`...`）原样保留 */
function applyStreamingRulesToLine(line: string): string {
  const segments = line.split(/(`[^`\n]*`)/)
  return segments
    .map((segment, index) => (index % 2 === 1 ? segment : applyStreamingRulesToPlain(segment)))
    .join('')
}

function applyStreamingRulesToPlain(text: string): string {
  // 0. 保护整行表格行：以 | 开头并以 | 结尾且至少包含两个 | 的行，
  //    只拆分被压缩到同一行的表格边界 ||，避免内部的 # / - 被规则 1-6 误改。
  const trimmed = text.trim()
  const pipeCount = (trimmed.match(/\|/g) ?? []).length
  if (trimmed.startsWith('|') && trimmed.endsWith('|') && pipeCount >= 2) {
    return text.replace(/\|\|/g, '|\n|')
  }

  let out = text

  // 1. 修复行内标题 # 后没空格（行首标题由 fixStreamingMarkdownSyntax 兜底）
  out = out.replace(/(?<![#\n])(#{1,6})([^#\s])/g, '$1 $2')

  // 2. 把被压缩到同一行的标题与前面表格行/列表项分开：|###标题、)###标题、）###标题
  //    排除标题后同一行还出现 | 的情况（如 | # | 表格单元格）
  out = out.replace(/(\|)\s*(#{1,6}\s)(?![^\n]*\|)/g, '$1\n\n$2')
  out = out.replace(/([)）])\s*(#{1,6}\s)/g, '$1\n\n$2')

  // 3. 拆分表格行边界：|| -> |\n|
  out = out.replace(/\|\|/g, '|\n|')

  // 4. 把同一行内混合的表格行与文本/标题拆到不同行
  const tableRowPattern = /(\|[^|\n]*(?:\|[^|\n]*)+\|)/g
  if (out.includes('|') && tableRowPattern.test(out)) {
    tableRowPattern.lastIndex = 0
    out = out.split(tableRowPattern).filter(Boolean).join('\n')
  }

  // 5. 在标题和列表之间插入换行
  out = out.replace(/(#{1,6}\s[^\n]+?)(\n?-\s[^\n]+)/g, '$1\n$2')

  // 6. 在两个列表项之间插入换行
  out = out.replace(/(-\s[^\n]+?)(-\s[^\n]+)/g, '$1\n$2')

  return out
}

/**
 * 轻量级 Markdown 语法修复。
 * 只做两件事：
 * 1. 标题 `#` 后补空格（`##标题` -> `## 标题`）
 * 2. 表格行前补空行（让 remark-gfm 能识别表格）
 */
function fixStreamingMarkdownSyntax(content: string): string {
  const raw = content.replace(/\r\n/g, '\n')
  const lines = raw.split('\n')
  const result: string[] = []
  let inCodeBlock = false
  let prevNonBlank: string | null = null

  for (const original of lines) {
    const trimmed = original.trim()

    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock
      result.push(original)
      if (trimmed !== '') prevNonBlank = original
      continue
    }

    if (inCodeBlock) {
      result.push(original)
      continue
    }

    let line = original

    const headingMatch = line.match(/^(#{1,6})([^#\s].*)$/)
    if (headingMatch) {
      line = `${headingMatch[1]} ${headingMatch[2]}`
    }

    if (trimmed.startsWith('|') && prevNonBlank !== null && !prevNonBlank.trim().startsWith('|')) {
      result.push('')
    }

    result.push(line)
    if (trimmed !== '') {
      prevNonBlank = line
    }
  }

  return result.join('\n')
}

/** 去掉连续重复的内容块（LLM 有时会重复输出同一个表格/段落） */
function dedupeConsecutiveBlocks(content: string): string {
  const blocks = content.split(/\n{2,}/)
  const deduped: string[] = []

  for (const block of blocks) {
    const trimmed = block.trim()
    if (!trimmed) continue
    const last = deduped[deduped.length - 1]?.trim()
    if (last !== trimmed) {
      deduped.push(block)
    }
  }

  return deduped.join('\n\n')
}
