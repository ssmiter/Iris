import { useEffect, useState } from 'react'
import { Monitor, ChevronDown, ChevronRight, FileText, CheckCircle2, XCircle, ImageIcon } from 'lucide-react'
import type { ToolResultRendererProps } from '@/agent/tools/toolRenderRegistry'
import { readFile } from '@/services/fileSystem'
import { getWorkspaceAdapter } from '@/services/workspaceAdapters'

interface ActionResultItem {
  step: number
  action: string
  success: boolean
  data_summary: string
  error?: string
}

interface WebBridgeExecuteData {
  success: boolean
  workflow_name: string
  success_count: number
  total_actions: number
  summary: string
  screenshot_paths?: string[]
  results?: ActionResultItem[]
}

function isWebBridgeExecuteData(data: unknown): data is WebBridgeExecuteData {
  if (!data || typeof data !== 'object') return false
  const obj = data as Record<string, unknown>
  return typeof obj.workflow_name === 'string' && typeof obj.summary === 'string'
}

function ScreenshotPreview({ path }: { path: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isBackend = getWorkspaceAdapter().kind === 'backend'

  useEffect(() => {
    // 后端模式下文件以二进制形式落在磁盘，直接走 /workspace 静态文件 endpoint 渲染，
    // 避免 readFile 对二进制文件返回占位文本导致无法显示。
    if (isBackend) {
      // screenshot_path 本身已以 /workspace 开头，不要双写
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

export function WebBridgeExecuteResult({ message }: ToolResultRendererProps) {
  const [expanded, setExpanded] = useState(true)
  const data = message.structuredData

  if (!isWebBridgeExecuteData(data)) {
    return (
      <div className="mt-2 rounded-xl border border-surface-200 bg-white p-3 text-xs text-surface-500">
        WebBridge 执行结果
      </div>
    )
  }

  const { workflow_name, success_count, total_actions, summary, screenshot_paths, results } = data

  return (
    <div className="mt-2 rounded-xl border border-surface-200 overflow-hidden bg-white shadow-sm">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-surface-50 hover:bg-surface-100 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Monitor size={14} className="text-primary-500" />
          <span className="text-xs font-medium text-surface-700">
            WebBridge：{workflow_name}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-surface-400">
            {success_count}/{total_actions} 成功
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
          <pre className="text-xs text-surface-600 whitespace-pre-wrap font-sans">{summary}</pre>

          {screenshot_paths && screenshot_paths.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] text-surface-400">截图</p>
              {screenshot_paths.map((path, idx) => (
                <ScreenshotPreview key={idx} path={path} />
              ))}
            </div>
          )}

          {results && results.length > 0 && (
            <div className="space-y-2">
              {results.map((item, idx) => (
                <div key={idx} className="rounded-lg border border-surface-200 p-2">
                  <div className="flex items-center gap-2">
                    {item.success ? (
                      <CheckCircle2 size={12} className="text-green-500" />
                    ) : (
                      <XCircle size={12} className="text-red-500" />
                    )}
                    <span className="text-xs font-medium text-surface-700">
                      步骤 {item.step}：{item.action}
                    </span>
                  </div>
                  <pre className="mt-1 text-xs text-surface-600 whitespace-pre-wrap font-sans">
                    {item.error ? `❌ ${item.error}` : item.data_summary}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
