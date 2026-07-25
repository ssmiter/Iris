import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, ChevronDown, ChevronRight, ExternalLink, FileText } from 'lucide-react'
import type { ToolResultRendererProps } from '@/agent/tools/toolRenderRegistry'

interface WebFetchData {
  url: string
  title?: string
  content: string
  cached_path?: string
  summary?: string
  totalLines: number
  totalChars: number
  isTruncated: boolean
  returnedOffset: number
  returnedLimit: number
}

function isWebFetchData(data: unknown): data is WebFetchData {
  if (!data || typeof data !== 'object') return false
  const obj = data as Record<string, unknown>
  return typeof obj.url === 'string' && typeof obj.content === 'string'
}

export function WebFetchResult({ message }: ToolResultRendererProps) {
  const [expanded, setExpanded] = useState(true)
  const { t } = useTranslation()
  const data = message.structuredData

  if (!isWebFetchData(data)) {
    return (
      <div className="mt-2 rounded-xl border border-surface-200 bg-white p-3 text-xs text-surface-500">
        {t('chat.messageBubble.noResult')}
      </div>
    )
  }

  const { url, title, content, totalLines, totalChars, isTruncated, returnedOffset, returnedLimit } = data

  return (
    <div className="mt-2 rounded-xl border border-surface-200 overflow-hidden bg-white shadow-sm">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-surface-50 hover:bg-surface-100 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Globe size={14} className="text-primary-500 flex-shrink-0" />
          <div className="text-left min-w-0">
            <span className="text-xs font-medium text-surface-700 block truncate">
              {title || t('chat.messageBubble.webFetch')}
            </span>
            <span className="text-[10px] text-surface-400 block truncate">{url}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {expanded ? (
            <ChevronDown size={14} className="text-surface-400" />
          ) : (
            <ChevronRight size={14} className="text-surface-400" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] text-surface-400">
              {t('chat.messageBubble.webFetchRange', {
                offset: returnedOffset,
                limit: returnedLimit,
                totalLines,
                totalChars,
              })}
            </span>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-[10px] text-primary-600 hover:text-primary-700"
            >
              {t('chat.messageBubble.openPage')}
              <ExternalLink size={10} />
            </a>
          </div>
          {data.cached_path && (
            <div className="mb-2 flex items-center gap-2 rounded-lg border border-surface-200 bg-surface-50 p-2">
              <FileText size={12} className="text-surface-400 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-[10px] text-surface-400">{t('chat.messageBubble.cachedPath')}</p>
                <p className="text-xs text-surface-600 truncate" title={data.cached_path}>
                  {data.cached_path}
                </p>
              </div>
            </div>
          )}

          <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs text-surface-700 bg-surface-50 border border-surface-200 rounded-lg p-3 font-mono leading-relaxed">
            {content}
          </pre>
          {isTruncated && (
            <p className="mt-2 text-[10px] text-amber-600">
              {t('chat.messageBubble.webFetchTruncated')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
