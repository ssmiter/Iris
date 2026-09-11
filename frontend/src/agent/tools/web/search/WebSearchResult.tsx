import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, ChevronDown, ChevronRight, ExternalLink, FileText } from 'lucide-react'
import type { ToolResultRendererProps } from '@/agent/tools/toolRenderRegistry'

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

interface WebSearchHit {
  title: string
  url: string
  content?: string
  snippet?: string
  score?: number
}

interface WebSearchData {
  query: string
  results: WebSearchHit[]
  cached_path?: string
  summary?: string
  result_count?: number
}

function isWebSearchData(data: unknown): data is WebSearchData {
  if (!data || typeof data !== 'object') return false
  const obj = data as Record<string, unknown>
  if (typeof obj.query !== 'string') return false
  if (!Array.isArray(obj.results)) return false
  return obj.results.every(
    (r) =>
      r &&
      typeof r === 'object' &&
      typeof (r as Record<string, unknown>).title === 'string' &&
      typeof (r as Record<string, unknown>).url === 'string'
  )
}

export function WebSearchResult({ message }: ToolResultRendererProps) {
  const [expanded, setExpanded] = useState(true)
  const { t } = useTranslation()
  const data = message.structuredData

  if (!isWebSearchData(data)) {
    return (
      <div className="mt-2 rounded-xl border border-surface-200 bg-white p-3 text-xs text-surface-500">
        {t('chat.messageBubble.noResult')}
      </div>
    )
  }

  const { query, results } = data

  return (
    <div className="mt-2 rounded-xl border border-surface-200 overflow-hidden bg-white shadow-sm">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-surface-50 hover:bg-surface-100 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Search size={14} className="text-primary-500" />
          <span className="text-xs font-medium text-surface-700">
            {t('chat.messageBubble.webSearch')}: {query}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-surface-400">
            {t('chat.messageBubble.resultsCount', { count: results.length })}
          </span>
          {expanded ? (
            <ChevronDown size={14} className="text-surface-400" />
          ) : (
            <ChevronRight size={14} className="text-surface-400" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="p-3 space-y-3">
          {results.map((result, index) => (
            <a
              key={index}
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group block rounded-lg border border-surface-200 bg-white p-3 hover:border-primary-300 hover:shadow-sm transition-all"
            >
              <div className="flex items-start justify-between gap-2">
                <h4 className="text-sm font-medium text-primary-600 group-hover:text-primary-700 line-clamp-1">
                  {result.title || t('chat.messageBubble.noTitle')}
                </h4>
                <ExternalLink size={12} className="flex-shrink-0 text-surface-400 group-hover:text-primary-500 mt-0.5" />
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-100 text-surface-500">
                  {getDomain(result.url)}
                </span>
                {typeof result.score === 'number' && (
                  <span className="text-[10px] text-surface-400">
                    {t('chat.messageBubble.relevance', { score: result.score.toFixed(2) })}
                  </span>
                )}
              </div>
              {(result.content || result.snippet) && (
                <p className="mt-1.5 text-xs text-surface-600 line-clamp-2">
                  {result.content || result.snippet}
                </p>
              )}
            </a>
          ))}
          {data.cached_path && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-surface-200 bg-surface-50 p-2">
              <FileText size={12} className="text-surface-400 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-[10px] text-surface-400">{t('chat.messageBubble.cachedPath')}</p>
                <p className="text-xs text-surface-600 truncate" title={data.cached_path}>
                  {data.cached_path}
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
