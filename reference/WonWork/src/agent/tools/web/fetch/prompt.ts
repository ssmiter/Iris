export const WEB_FETCH_TOOL_NAME = 'web_fetch'

export function getWebFetchPrompt(): string {
  return `## web_fetch 工具使用规范

- 当你需要读取某个具体 URL 的原文内容时，调用 web_fetch。
- 典型场景：web_search 返回的摘要不足以回答用户问题，需要查看页面正文、表格、代码示例等细节。
- 完整页面内容会写入 /workspace/scratch/web_cache/pages/...，工具返回摘要 + cached_path；如需深读，可用 read_file 读取 cached_path。
- 优先使用 selector 参数提取页面中的相关部分，例如 article、.main-content、#content，避免把整页无关内容塞进上下文。
- 如果返回内容被截断（结果中会出现 [内容已截断] 提示），可以再次调用 web_fetch，使用更大的 offset 继续阅读。
- raw=true 仅在需要分析 HTML 结构时使用；默认返回可读文本。
- 最终回答必须基于实际抓取到的内容，不要编造未在页面中出现的信息。

### 使用示例

1. 读取整页正文：
   { "url": "https://example.com/article" }

2. 只读取文章主体：
   { "url": "https://example.com/article", "selector": "article" }

3. 长文分页继续阅读：
   { "url": "https://example.com/article", "offset": 201, "limit": 200 }
`
}
