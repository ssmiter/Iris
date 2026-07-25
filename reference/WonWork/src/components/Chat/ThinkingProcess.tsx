import { useMemo, useRef, useEffect, useState } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { cn } from '@/utils'
import { ChevronDown, ChevronRight, Loader2, CheckCircle2, XCircle, Terminal, Search, Globe, Presentation, FileSpreadsheet, FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { getToolThinkingRenderer } from '@/agent/tools/toolRenderRegistry'

export const DOCUMENT_TOOL_NAMES = ['create_pptx_document', 'create_excel_document', 'create_word_document'] as const

export function isDocumentTool(toolCallName?: string): toolCallName is (typeof DOCUMENT_TOOL_NAMES)[number] {
  return DOCUMENT_TOOL_NAMES.includes(toolCallName as (typeof DOCUMENT_TOOL_NAMES)[number])
}

function documentToolIcon(toolCallName?: string) {
  switch (toolCallName) {
    case 'create_pptx_document':
      return <Presentation size={14} className="text-surface-400" />
    case 'create_excel_document':
      return <FileSpreadsheet size={14} className="text-surface-400" />
    case 'create_word_document':
      return <FileText size={14} className="text-surface-400" />
    default:
      return <Terminal size={14} className="text-surface-400" />
  }
}

export type ThinkingStatus = 'planning' | 'coding' | 'running' | 'completed' | 'error'

interface ThinkingProcessProps {
  content: string
  executionLog: string
  status: ThinkingStatus
  initialExpanded?: boolean
  toolCallName?: string
  webBridgeState?: {
    stepIndex: number
    totalSteps: number
    url?: string
    title?: string
    screenshot?: string
    lastAction?: string
  }
}

export function extractPythonCode(content: string): string {
  const matches: string[] = []
  // 严格匹配：只提取显式标记 ```python 的代码块；
  // 裸 ``` 块（普通示例代码、其他语言）不能被当成 Python 抽走
  const regex = /```python\s*\n?([\s\S]*?)```/gi
  let m: RegExpExecArray | null
  while ((m = regex.exec(content)) !== null) {
    matches.push(m[1].trim())
  }
  // 如果没有闭合代码块，但存在未闭合的 ```python（流式中间态），也提取
  if (matches.length === 0) {
    const unclosed = content.match(/```python\s*\n?([\s\S]*)$/i)
    if (unclosed) {
      matches.push(unclosed[1].trim())
    }
  }
  return matches.join('\n\n# ---\n\n')
}

function StatusIcon({ status, toolCallName }: { status: ThinkingStatus; toolCallName?: string }) {
  if (toolCallName === 'web_search') {
    switch (status) {
      case 'running':
        return <Loader2 size={14} className="animate-spin text-primary-500" />
      case 'completed':
        return <CheckCircle2 size={14} className="text-green-500" />
      case 'error':
        return <XCircle size={14} className="text-red-500" />
      default:
        return <Search size={14} className="text-surface-400" />
    }
  }

  if (toolCallName === 'webbridge') {
    switch (status) {
      case 'running':
        return <Loader2 size={14} className="animate-spin text-primary-500" />
      case 'completed':
        return <CheckCircle2 size={14} className="text-green-500" />
      case 'error':
        return <XCircle size={14} className="text-red-500" />
      default:
        return <Globe size={14} className="text-surface-400" />
    }
  }

  if (isDocumentTool(toolCallName)) {
    switch (status) {
      case 'running':
        return <Loader2 size={14} className="animate-spin text-primary-500" />
      case 'completed':
        return <CheckCircle2 size={14} className="text-green-500" />
      case 'error':
        return <XCircle size={14} className="text-red-500" />
      default:
        return documentToolIcon(toolCallName)
    }
  }

  switch (status) {
    case 'running':
      return <Loader2 size={14} className="animate-spin text-primary-500" />
    case 'completed':
      return <CheckCircle2 size={14} className="text-green-500" />
    case 'error':
      return <XCircle size={14} className="text-red-500" />
    default:
      return <Terminal size={14} className="text-surface-400" />
  }
}

function StatusLabel({ status, toolCallName }: { status: ThinkingStatus; toolCallName?: string }) {
  const { t } = useTranslation()
  const isWebSearch = toolCallName === 'web_search'
  const isWebBridge = toolCallName === 'webbridge'
  const isDocument = isDocumentTool(toolCallName)
  const labels: Record<ThinkingStatus, string> = isWebSearch
    ? {
        planning: t('chat.thinkingProcess.preparingSearch'),
        coding: t('chat.thinkingProcess.searching'),
        running: t('chat.thinkingProcess.searching'),
        completed: t('chat.thinkingProcess.searchCompleted'),
        error: t('chat.thinkingProcess.searchFailed'),
      }
    : isWebBridge
      ? {
          planning: t('chat.thinkingProcess.webBridge.preparingWorkflow'),
          coding: t('chat.thinkingProcess.webBridge.executingWorkflow'),
          running: t('chat.thinkingProcess.webBridge.executingWorkflow'),
          completed: t('chat.thinkingProcess.webBridge.workflowCompleted'),
          error: t('chat.thinkingProcess.webBridge.workflowFailed'),
        }
      : isDocument
        ? {
            planning: t('chat.thinkingProcess.document.preparing'),
            coding: t('chat.thinkingProcess.document.generating'),
            running: t('chat.thinkingProcess.document.generating'),
            completed: t('chat.thinkingProcess.document.completed'),
            error: t('chat.thinkingProcess.document.failed'),
          }
        : {
            planning: t('chat.thinkingProcess.analyzing'),
            coding: t('chat.thinkingProcess.coding'),
            running: t('chat.thinkingProcess.running'),
            completed: t('chat.thinkingProcess.completed'),
            error: t('chat.thinkingProcess.executionError'),
          }
  const classes: Record<ThinkingStatus, string> = {
    planning: 'bg-surface-100 text-surface-500',
    coding: 'bg-primary-50 text-primary-600',
    running: 'bg-primary-50 text-primary-600 animate-pulse',
    completed: 'bg-green-50 text-green-600',
    error: 'bg-red-50 text-red-600',
  }
  return (
    <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium', classes[status])}>
      {labels[status]}
    </span>
  )
}

export function ThinkingProcess({ content, executionLog, status, initialExpanded = true, toolCallName, webBridgeState }: ThinkingProcessProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(initialExpanded)
  const [isScreenshotExpanded, setIsScreenshotExpanded] = useState(false)
  const code = useMemo(() => extractPythonCode(content), [content])
  const logRef = useRef<HTMLDivElement>(null)

  // 若该工具注册了专属 thinking 渲染器，优先使用，避免在组件内硬编码工具分支
  const ToolThinkingRenderer = toolCallName ? getToolThinkingRenderer(toolCallName) : undefined
  if (ToolThinkingRenderer) {
    return (
      <ToolThinkingRenderer
        content={content}
        executionLog={executionLog}
        status={status}
        initialExpanded={initialExpanded}
        toolCallName={toolCallName}
      />
    )
  }

  // 执行日志自动滚动到底部
  useEffect(() => {
    if (logRef.current && isExpanded) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [executionLog, isExpanded])

  const isWebSearch = toolCallName === 'web_search'
  const isWebBridge = toolCallName === 'webbridge'
  const isDocument = isDocumentTool(toolCallName)

  const hasCode = !isWebSearch && !isWebBridge && code.length > 0
  const hasLog = !isWebSearch && !isWebBridge && executionLog.length > 0

  if (!hasCode && !hasLog && status !== 'running') {
    // 联网搜索/WebBridge/文档生成完成或失败后仍保留折叠面板，便于用户查看过程
    if (!isWebSearch && !isWebBridge && !isDocument) return null
  }

  const title = isWebSearch
    ? t('chat.thinkingProcess.webSearch')
    : isWebBridge
      ? t('chat.thinkingProcess.webBridge.webBridge')
      : isDocument
        ? t(`chat.thinkingProcess.document.${toolCallName === 'create_pptx_document' ? 'ppt' : toolCallName === 'create_excel_document' ? 'excel' : 'word'}`)
        : hasLog
          ? t('chat.thinkingProcess.pythonRuntime')
          : t('chat.thinkingProcess.generatedCode')

  return (
    <div className="mb-3 rounded-xl border border-surface-200 overflow-hidden bg-white shadow-sm">
      {/* 标题栏 */}
      <button
        onClick={() => setIsExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-surface-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <ChevronDown size={14} className="text-surface-400" />
          ) : (
            <ChevronRight size={14} className="text-surface-400" />
          )}
          <StatusIcon status={status} toolCallName={toolCallName} />
          <span className="text-xs font-medium text-surface-700">{title}</span>
        </div>
        <StatusLabel status={status} toolCallName={toolCallName} />
      </button>

      {/* 展开内容 */}
      {isExpanded && (
        <div className="border-t border-surface-100">
          {/* WebBridge 实时预览 */}
          {isWebBridge && webBridgeState && webBridgeState.totalSteps > 0 && (
            <div className="border-b border-surface-100 p-3 bg-surface-50/50">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-medium text-surface-500">
                  {t('chat.thinkingProcess.webBridge.stepNofM', {
                    current: webBridgeState.stepIndex + 1,
                    total: webBridgeState.totalSteps,
                  })}
                </span>
                {webBridgeState.lastAction && (
                  <span className="text-[10px] text-surface-400">{webBridgeState.lastAction}</span>
                )}
              </div>
              {(webBridgeState.url || webBridgeState.title) && (
                <div className="mb-2 text-[10px] text-surface-500 space-y-0.5">
                  {webBridgeState.title && <p className="truncate">{webBridgeState.title}</p>}
                  {webBridgeState.url && <p className="truncate text-surface-400">{webBridgeState.url}</p>}
                </div>
              )}
              {webBridgeState.screenshot && (
                <div>
                  <button
                    onClick={() => setIsScreenshotExpanded((v) => !v)}
                    className="block w-full text-left"
                  >
                    <img
                      src={webBridgeState.screenshot}
                      alt="WebBridge screenshot"
                      className={cn(
                        'rounded border border-surface-200 transition-all',
                        isScreenshotExpanded ? 'w-full' : 'h-24 w-auto'
                      )}
                    />
                  </button>
                  <p className="mt-1 text-[10px] text-surface-400">
                    {isScreenshotExpanded
                      ? t('chat.thinkingProcess.webBridge.clickToShrink')
                      : t('chat.thinkingProcess.webBridge.clickToExpand')}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* 代码区域 */}
          {hasCode && (
            <div className="border-b border-surface-100">
              <div className="flex items-center justify-between px-3 py-1.5 bg-surface-50 border-b border-surface-100">
                <div className="flex items-center gap-1.5">
                  <Terminal size={12} className="text-surface-400" />
                  <span className="text-[10px] font-medium text-surface-500">{t('chat.thinkingProcess.generatedPython')}</span>
                </div>
                <span className="text-[10px] text-surface-400">{t('chat.thinkingProcess.linesCount', { count: code.split('\n').length })}</span>
              </div>
              <div className="max-h-80 overflow-y-auto">
                <SyntaxHighlighter
                  language="python"
                  style={oneLight}
                  customStyle={{
                    margin: 0,
                    padding: '12px 16px',
                    fontSize: '12px',
                    lineHeight: '1.6',
                    background: '#fafafa',
                  }}
                  showLineNumbers
                  lineNumberStyle={{
                    fontSize: '11px',
                    color: '#999',
                    minWidth: '28px',
                    paddingRight: '12px',
                  }}
                >
                  {code}
                </SyntaxHighlighter>
              </div>
            </div>
          )}

          {/* 执行日志区域 */}
          {hasLog && (
            <div>
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-50 border-b border-surface-100">
                <Terminal size={12} className="text-surface-400" />
                <span className="text-[10px] font-medium text-surface-500">{t('chat.thinkingProcess.executionLog')}</span>
              </div>
              <div
                ref={logRef}
                className="max-h-48 overflow-y-auto p-3 bg-slate-900 text-slate-100 font-mono text-xs leading-relaxed"
              >
                {executionLog.split('\n').map((line, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="text-slate-500 select-none flex-shrink-0">
                      {String(i + 1).padStart(3, '0')}
                    </span>
                    <span className={cn(
                      line.startsWith('[stderr]') && 'text-red-300',
                      line.startsWith('>') && 'text-primary-300',
                    )}>
                      {line || ' '}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 联网搜索空状态 */}
          {isWebSearch && status === 'running' && (
            <div className="px-3 py-6 text-center text-xs text-surface-400">
              <Loader2 size={16} className="animate-spin mx-auto mb-2 text-primary-400" />
              {t('chat.thinkingProcess.searchingWeb')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
