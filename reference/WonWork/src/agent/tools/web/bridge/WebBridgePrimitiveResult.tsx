import { useEffect, useState } from 'react'
import { Monitor, ChevronDown, ChevronRight, ImageIcon, CheckCircle2, XCircle } from 'lucide-react'
import type { ToolResultRendererProps } from '@/agent/tools/toolRenderRegistry'
import { readFile } from '@/services/fileSystem'
import { getWorkspaceAdapter } from '@/services/workspaceAdapters'

interface CandidateItem {
  selector: string
  text: string
  tag: string
}

interface WebBridgePrimitiveData {
  success: boolean
  url: string
  title: string
  summary: string
  screenshot_path?: string
  cached_path?: string
  candidates?: CandidateItem[]
  error?: string
}

function isWebBridgePrimitiveData(data: unknown): data is WebBridgePrimitiveData {
  if (!data || typeof data !== 'object') return false
  const obj = data as Record<string, unknown>
  return typeof obj.summary === 'string' && typeof obj.url === 'string'
}

function ScreenshotPreview({ path }: { path: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const isBackend = getWorkspaceAdapter().kind === 'backend'

  useEffect(() => {
    if (isBackend) {
      // buildArtifactPath 返回的路径本身已以 /workspace 开头，不要双写
      setDataUrl(path.startsWith('/workspace') ? path : `/workspace${path}`)
      return
    }

    let cancelled = false
    readFile(path)
      .then((entry) => {
        if (!entry) {
          setError('无法读取截图')
          return
        }
        const content = entry.content.trim()
        const url = content.startsWith('data:') ? content : `data:image/png;base64,${content}`
        if (!cancelled) setDataUrl(url)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '读取截图失败')
      })
    return () => {
      cancelled = true
    }
  }, [path, isBackend])

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-600">
        {error}
      </div>
    )
  }

  if (!dataUrl) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-surface-200 bg-surface-50 p-2 text-xs text-surface-500">
        <ImageIcon size={12} />
        <span className="truncate">{path}</span>
        <span>（加载中…）</span>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-surface-200 bg-surface-50 p-2">
      <div className="flex items-center gap-2 text-xs text-surface-500 mb-1">
        <ImageIcon size={12} />
        <span className="truncate">{path}</span>
      </div>
      <img
        src={dataUrl}
        alt={`截图 ${path}`}
        className="max-w-full rounded border border-surface-200"
      />
    </div>
  )
}

export function WebBridgePrimitiveResult({ message }: ToolResultRendererProps) {
  const [expanded, setExpanded] = useState(true)
  const data = message.structuredData

  if (!isWebBridgePrimitiveData(data)) {
    return (
      <div className="mt-2 rounded-xl border border-surface-200 bg-white p-3 text-xs text-surface-500">
        WebBridge 操作结果
      </div>
    )
  }

  const { success, url, title, summary, screenshot_path, cached_path, candidates, error } = data

  return (
    <div className="mt-2 rounded-xl border border-surface-200 overflow-hidden bg-white shadow-sm">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-surface-50 hover:bg-surface-100 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Monitor size={14} className="text-primary-500" />
          <span className="text-xs font-medium text-surface-700 truncate">
            WebBridge：{title || '浏览器操作'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {success ? (
            <CheckCircle2 size={14} className="text-green-500" />
          ) : (
            <XCircle size={14} className="text-red-500" />
          )}
          {expanded ? (
            <ChevronDown size={14} className="text-surface-400" />
          ) : (
            <ChevronRight size={14} className="text-surface-400" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="p-3 space-y-3">
          <div className="text-[10px] text-surface-400 space-y-0.5">
            <div className="truncate">{url}</div>
            {error && <div className="text-red-500">❌ {error}</div>}
          </div>

          <pre className="text-xs text-surface-600 whitespace-pre-wrap font-sans">{summary}</pre>

          {cached_path && (
            <div className="text-xs text-surface-500">
              产物：<code className="bg-surface-100 px-1 py-0.5 rounded">{cached_path}</code>
            </div>
          )}

          {candidates && candidates.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] text-surface-400">定位候选</p>
              <ul className="text-xs text-surface-600 space-y-0.5">
                {candidates.map((c, idx) => (
                  <li key={idx} className="font-mono">
                    <span className="text-surface-400">#{idx + 1}</span>{' '}
                    &lt;{c.tag}&gt; {c.selector} — {c.text.slice(0, 80)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {screenshot_path && <ScreenshotPreview path={screenshot_path} />}
        </div>
      )}
    </div>
  )
}
