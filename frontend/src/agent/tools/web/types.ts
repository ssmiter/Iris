/**
 * Web 工具子系统共享类型
 *
 * 包含 web_search 与 web_fetch 的输入输出、适配器接口与进度事件。
 */

// ==================== web_search ====================

export interface WebSearchHit {
  title: string
  url: string
  snippet?: string
  /** 命中来自哪个搜索引擎（由适配器填充，用于缓存元数据） */
  engine?: string
}

export interface WebSearchResult {
  query: string
  results: WebSearchHit[]
  /** 返回给模型的简短摘要 */
  summary: string
  /** 完整搜索结果的缓存路径 */
  cached_path: string
  /** 实际结果数 */
  result_count: number
}

export interface WebSearchOptions {
  query: string
  /** 最多返回多少条结果，默认 5 */
  top_n?: number
}

// ==================== web_fetch ====================

export interface WebFetchOptions {
  /** 要读取的页面 URL */
  url: string
  /** 可选 CSS 选择器，只提取匹配元素的内容 */
  selector?: string
  /** 起始行号（1-based），用于长页面分页 */
  offset?: number
  /** 最多返回行数，默认 200 */
  limit?: number
  /** 是否返回原始 HTML；默认 false 返回提取后的文本 */
  raw?: boolean
}

export interface WebFetchAdapterResult {
  url: string
  title?: string
  /** 按 offset/limit 分页后返回给模型的内容 */
  content: string
  /** 完整页面内容（未分页），用于写入缓存供 read_file 深读 */
  fullContent: string
  totalLines: number
  totalChars: number
  isTruncated: boolean
  returnedOffset: number
  returnedLimit: number
  error?: string
}

export interface WebFetchResult extends WebFetchAdapterResult {
  /** 返回给模型的简短摘要 */
  summary: string
  /** 完整页面内容的缓存路径 */
  cached_path: string
}

// ==================== 适配器共享 ====================

export interface WebSearchProgress {
  type: 'query_update' | 'search_results_received' | 'error'
  query?: string
  resultCount?: number
  message?: string
}

export interface AdapterOptions {
  signal?: AbortSignal
  onProgress?: (progress: WebSearchProgress) => void
}

export interface WebSearchAdapter {
  search(query: string, options: AdapterOptions): Promise<WebSearchHit[]>
}

export interface WebFetchAdapter {
  fetch(options: WebFetchOptions, opts: AdapterOptions): Promise<WebFetchAdapterResult>
}
