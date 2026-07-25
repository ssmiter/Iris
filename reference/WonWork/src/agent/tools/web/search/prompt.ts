import { getLocalMonthYear } from '@/utils/date'

export const WEB_SEARCH_TOOL_NAME = 'web_search'

export function getWebSearchPrompt(): string {
  const currentMonthYear = getLocalMonthYear()
  return `
## web_search 工具使用规范

- 当你需要获取模型知识截止点之后的最新信息、实时数据或外部资料时，调用 web_search。
- 返回的搜索结果包含标题、URL 和摘要；完整结果会写入 /workspace/scratch/web_cache/search/...，工具返回摘要 + cached_path。你的最终回答必须基于这些结果或后续抓取的页面原文，不得编造。
- 如需深读某条搜索结果的完整缓存，可用 read_file 读取 cached_path。
- 调用时请在 query 中使用准确、具体的关键词；如果涉及近期事件、文档或数据，务必包含当前年份。
- 当搜索结果中的摘要不足以回答用户问题时，必须调用 web_fetch 读取相关结果页面，基于实际页面原文作答。
- 读取页面时优先使用 web_fetch 的 selector 参数提取相关部分（如 article、.main-content），避免整页无关内容进入上下文。
- 如果 web_fetch 返回内容被截断，可以再次调用并增大 offset 继续阅读。

### 典型流程

1. web_search 获取相关结果。
2. 分析摘要，选择最相关的 1-3 个 URL。
3. 用 web_fetch 读取这些 URL 的原文（优先带 selector）。
4. 基于搜索结果和抓取内容回答用户，并标注 Sources。

### 强制要求：必须标注来源

回答用户问题后，必须在末尾添加一个 **Sources:** 章节，列出你引用的所有相关 URL，格式为 markdown 超链接：

\`\`\`
[你的回答]

Sources:
- [Source Title 1](https://example.com/1)
- [Source Title 2](https://example.com/2)
\`\`\`

### 时间要求

- 当前月份是 ${currentMonthYear}。搜索近期信息时，必须使用当前年份，不要默认使用去年或更早的年份。
- 示例：用户问 "React 最新文档"，应搜索 "React documentation ${currentMonthYear}"，而不是 "React documentation 2025"。
`
}
