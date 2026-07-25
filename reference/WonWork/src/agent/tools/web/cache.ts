import { writeFile } from '@/services/fileSystem'

export interface WebCacheEntry {
  cachedPath: string
  summary: string
}

/**
 * 将 web_search / web_fetch 的完整结果写入 workspace scratch 缓存，
 * 返回供模型引用的虚拟路径与简短摘要。
 */
export async function writeWebCache(
  kind: 'search' | 'fetch',
  key: string,
  payload: Record<string, unknown>
): Promise<WebCacheEntry> {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const sanitizedKey = key
    .replace(/https?:\/\//g, '')
    .replace(/[^a-zA-Z0-9一-龥_-]/g, '_')
    .slice(0, 80)
  const filename = `${Date.now()}_${sanitizedKey}.json`
  const cachedPath = `/workspace/scratch/web_cache/${kind === 'search' ? 'search' : 'pages'}/${today}/${filename}`

  const content = JSON.stringify(
    {
      ...payload,
      _cachedAt: new Date().toISOString(),
      _kind: kind,
    },
    null,
    2
  )

  await writeFile(cachedPath, content, { encoding: 'utf-8' })

  const summary = buildSummary(kind, payload)

  return { cachedPath, summary }
}

function buildSummary(kind: 'search' | 'fetch', payload: Record<string, unknown>): string {
  if (kind === 'search') {
    const query = String(payload.query || '')
    const results = Array.isArray(payload.results) ? payload.results : []
    return `搜索 "${query}" 的 ${results.length} 条结果已缓存。`
  }

  const url = String(payload.url || '')
  const title = String(payload.title || '')
  const totalChars = typeof payload.totalChars === 'number' ? payload.totalChars : 0
  return `页面 ${title ? `"${title}"` : url}（${totalChars} 字符）已缓存。`
}
