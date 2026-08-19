import { useEffect, useState } from 'react'
import { getToolOutput, type ToolOutputWindow } from '@/api/irisApi'
import { cn } from '@/lib/cn'
import { useConversationStore } from '@/stores/conversationStore'

interface ToolResultTextProps {
  /** tool 节点的 resultRef，形如 tool-result://{toolExecutionId} */
  resultRef: string
  /** 只在节点展开时惰性解析，折叠态零请求 */
  expanded: boolean
  /** 附加到 pre 的类名，用于限高可滚等场景 */
  className?: string
}

/**
 * 工具输出解析（docs/24 §13 第三轮）。
 *
 * 后端把工具输出收进 tool-result:// 引用（ToolOutputController 文本窗口端点），
 * 之前前端把内部 URI 原样摊给用户。此处展开节点时惰性取首窗口（4000 字符），
 * 过长输出由 ClampText 软截断兜底。
 */
export function ToolResultText({ resultRef, expanded, className }: ToolResultTextProps) {
  const conversationId = useConversationStore(
    (state) => state.currentConversationId,
  )
  const [window_, setWindow] = useState<ToolOutputWindow | null>(null)
  const [failed, setFailed] = useState(false)
  const executionId = /^tool-result:\/\/(.+)$/.exec(resultRef)?.[1]

  useEffect(() => {
    if (!expanded || !conversationId || !executionId || window_ || failed) {
      return
    }
    const controller = new AbortController()
    getToolOutput(conversationId, executionId, controller.signal)
      .then(setWindow)
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
  }, [conversationId, executionId, expanded, window_, failed])

  if (!executionId) return null
  if (failed) {
    return (
      <p className="text-caption text-ink-muted">工具输出暂时无法读取。</p>
    )
  }
  if (!window_) {
    return expanded ? (
      <p className="text-caption text-ink-muted">正在读取工具输出…</p>
    ) : null
  }
  if (!window_.content) return null

  return (
    <div>
      <pre
        className={cn(
          'scrollbar-subtle whitespace-pre-wrap break-words rounded-xs bg-surface-muted px-3 py-2 font-mono text-caption text-ink-subtle',
          className,
        )}
      >
        {window_.content}
      </pre>
      {window_.truncated && (
        <p className="mt-1 text-caption text-ink-muted">
          输出共 {window_.totalCharacters} 字符，此处为开头片段。
        </p>
      )}
    </div>
  )
}
