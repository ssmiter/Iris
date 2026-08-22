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
 */
export function formatStreamingMarkdown(content: string): string {
  let text = content.replace(/\r\n/g, '\n')

  // 1. 修复标题 # 后没空格（包括行内）
  text = text.replace(/(?<![#\n])(#{1,6})([^#\s])/g, '$1 $2')

  // 2. 把被压缩到同一行的标题与前面表格行/列表项分开：|###标题、)###标题、）###标题
  text = text.replace(/(\|)\s*(#{1,6}\s)/g, '$1\n\n$2')
  text = text.replace(/([)）])\s*(#{1,6}\s)/g, '$1\n\n$2')

  // 3. 拆分表格行边界：|| -> |\n|
  text = text.replace(/\|\|/g, '|\n|')

  // 4. 把同一行内混合的表格行与文本/标题拆到不同行
  const lines = text.split('\n')
  const splitLines: string[] = []
  const tableRowPattern = /(\|[^|\n]*(?:\|[^|\n]*)+\|)/g
  for (const line of lines) {
    if (line.includes('|') && tableRowPattern.test(line)) {
      tableRowPattern.lastIndex = 0
      const segments = line.split(tableRowPattern).filter(Boolean)
      splitLines.push(...segments)
    } else {
      splitLines.push(line)
    }
  }
  text = splitLines.join('\n')

  // 5. 在标题和列表之间插入换行
  text = text.replace(/(#{1,6}\s[^\n]+?)(\n?-\s[^\n]+)/g, '$1\n$2')

  // 6. 在两个列表项之间插入换行
  text = text.replace(/(-\s[^\n]+?)(-\s[^\n]+)/g, '$1\n$2')

  // 7. 补表格前空行、标题空格
  return fixStreamingMarkdownSyntax(text)
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
