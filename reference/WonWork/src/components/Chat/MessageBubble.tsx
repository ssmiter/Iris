import { memo, useMemo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { ChatMessage } from '@/types/chat'
import type { FileAttachmentDto } from '@/types/mescli'
import { cn } from '@/utils'
import { User, Bot, Loader2, CheckCircle2, XCircle, Download, FileImage, FileText, File, ChevronDown, ChevronRight, AlertTriangle, RotateCcw, Copy, ThumbsUp, ThumbsDown, Brain } from 'lucide-react'
import { useChatStore } from '@/stores/chatStore'
import { useWorkspaceFileStore } from '@/stores/workspaceFileStore'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ChartRenderer, hasChartData } from './ChartRenderer'
import { ThinkingProcess, extractPythonCode, isDocumentTool } from './ThinkingProcess'
import { ToolCallCard } from './ToolCallCard'
import { ApprovalCard } from './ApprovalCard'
import { BatchApprovalCard } from './BatchApprovalCard'
import { ArtifactSkeleton } from './ArtifactSkeleton'
import { getToolResultRenderer } from '@/agent/tools/toolRenderRegistry'
import { formatFileSize, resolveDownloadUrl } from '@/utils/fileReader'
import { formatFileSize as formatFileSizeUnified } from '@/utils/formatFileSize'
import { getFileIconInfo } from '@/utils/fileIcon'
import { normalizeMarkdown, formatStreamingMarkdown } from '@/utils/markdownNormalizer'

interface MessageBubbleProps {
  message: ChatMessage
  /** 对于 tool 消息，传入其关联的 assistant 消息，用于展示 tool_call 参数 */
  assistantMessage?: ChatMessage
}

// remarkPlugins 在流式输出期间必须保持稳定引用，否则 ReactMarkdown 会反复重新解析整棵树
const remarkPlugins = [remarkGfm, remarkBreaks]

/**
 * 从用户消息 content 中提取显示文本和附件信息。
 * 本地新消息的 attachments 存在时直接返回原 content。
 * 历史消息 content 中若包含附件标记，则截断并提示包含附件。
 */
function extractUserDisplayContent(content: string, attachments?: FileAttachmentDto[]) {
  if (attachments && attachments.length > 0) {
    return { displayContent: content, hasAttachments: true, attachments }
  }

  const marker = /\n\n(?:---\n\n)?\[(文件|图片):/
  const match = content.match(marker)
  if (match && match.index !== undefined) {
    return {
      displayContent: content.slice(0, match.index).trim(),
      hasAttachments: true,
      attachments: undefined,
    }
  }

  return { displayContent: content, hasAttachments: false, attachments: undefined }
}

/**
 * 创建 ReactMarkdown 自定义渲染组件。
 * 该对象必须在流式输出期间保持稳定引用，否则每次 chunk 更新都会触发整棵 Markdown DOM 树重新挂载，
 * 导致实时显示时格式闪烁/丢失，刷新后才能看到完整渲染。
 */
function createMarkdownComponents(isUser: boolean) {
  return {
    h1({ children }: { children?: ReactNode }) {
      return <h1 className={cn('text-lg font-bold mt-4 mb-2 pb-1 border-b', isUser ? 'text-white border-white/30' : 'text-surface-900 border-surface-200')}>{children}</h1>
    },
    h2({ children }: { children?: ReactNode }) {
      return <h2 className={cn('text-base font-bold mt-3 mb-2', isUser ? 'text-white' : 'text-surface-800')}>{children}</h2>
    },
    h3({ children }: { children?: ReactNode }) {
      return <h3 className={cn('text-sm font-bold mt-3 mb-1.5', isUser ? 'text-white' : 'text-surface-800')}>{children}</h3>
    },
    h4({ children }: { children?: ReactNode }) {
      return <h4 className={cn('text-sm font-semibold mt-2 mb-1', isUser ? 'text-white/90' : 'text-surface-700')}>{children}</h4>
    },
    p({ children }: { children?: ReactNode }) {
      return <p className={cn('mb-2 last:mb-0 leading-relaxed', isUser ? 'text-white/90' : 'text-surface-700')}>{children}</p>
    },
    ul({ children }: { children?: ReactNode }) {
      return <ul className={cn('pl-5 mb-2 space-y-0.5', isUser ? 'list-disc text-white/90' : 'list-disc text-surface-700')}>{children}</ul>
    },
    ol({ children }: { children?: ReactNode }) {
      return <ol className={cn('pl-5 mb-2 space-y-0.5', isUser ? 'list-decimal text-white/90' : 'list-decimal text-surface-700')}>{children}</ol>
    },
    li({ children }: { children?: ReactNode }) {
      return <li className={cn('leading-relaxed', isUser ? 'text-white/90' : 'text-surface-700')}>{children}</li>
    },
    blockquote({ children }: { children?: ReactNode }) {
      return (
        <blockquote className={cn('border-l-4 pl-3 py-1 my-2 italic rounded-r', isUser ? 'border-white/40 bg-white/10 text-white/90' : 'border-primary-300 bg-surface-50 text-surface-600')}>
          {children}
        </blockquote>
      )
    },
    hr() {
      return <hr className={cn('my-3', isUser ? 'border-white/30' : 'border-surface-200')} />
    },
    a({ href, children }: { href?: string; children?: ReactNode }) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className={cn('underline', isUser ? 'text-white hover:text-white/80' : 'text-primary-600 hover:text-primary-700')}>
          {children}
        </a>
      )
    },
    strong({ children }: { children?: ReactNode }) {
      return <strong className={cn('font-bold', isUser ? 'text-white' : 'text-surface-900')}>{children}</strong>
    },
    code({ node, className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || '')
      const text = String(children)
      // react-markdown v9 不再传 inline：带语言标记或多行内容按块级处理，其余按行内
      const isBlock = Boolean(match) || text.includes('\n')
      // Python 代码块在 ThinkingProcess 中显示，此处跳过渲染
      if (isBlock && match && match[1] === 'python') {
        return null
      }
      if (isBlock && match) {
        return (
          <SyntaxHighlighter
            style={oneLight}
            language={match[1]}
            PreTag="div"
            className="rounded-lg text-sm my-2"
            {...props}
          >
            {text.replace(/\n$/, '')}
          </SyntaxHighlighter>
        )
      }
      if (isBlock) {
        return (
          <code
            className={cn(
              'block whitespace-pre overflow-x-auto rounded-lg text-sm my-2 p-3 font-mono',
              isUser ? 'bg-white/10 text-white' : 'bg-surface-100 text-surface-800'
            )}
            {...props}
          >
            {children}
          </code>
        )
      }
      return (
        <code className={cn('px-1.5 py-0.5 rounded text-sm font-mono', isUser ? 'bg-white/20 text-white' : 'bg-surface-100 text-surface-800')} {...props}>
          {children}
        </code>
      )
    },
    table({ children }: { children?: ReactNode }) {
      return (
        <div className={cn('overflow-x-auto my-3 rounded-lg border', isUser ? 'border-white/20' : 'border-surface-200')}>
          <table className={cn('min-w-full text-sm border-collapse', isUser ? 'text-white/90' : 'text-surface-700')}>
            {children}
          </table>
        </div>
      )
    },
    thead({ children }: { children?: ReactNode }) {
      return <thead className={cn(isUser ? 'bg-white/10' : 'bg-surface-100')}>{children}</thead>
    },
    th({ children }: { children?: ReactNode }) {
      return (
        <th className={cn('px-3 py-2 border-b font-semibold text-left', isUser ? 'border-white/20 text-white' : 'border-surface-200 text-surface-700')}>
          {children}
        </th>
      )
    },
    td({ children }: { children?: ReactNode }) {
      return (
        <td className={cn('px-3 py-2 border-b', isUser ? 'border-white/20 text-white/90' : 'border-surface-200 text-surface-700')}>
          {children}
        </td>
      )
    },
    tr({ children }: { children?: ReactNode }) {
      return <tr className={cn('transition-colors', isUser ? 'hover:bg-white/10' : 'hover:bg-surface-50')}>{children}</tr>
    },
  }
}

function groupApprovalRequests(
  requests: ReturnType<typeof useChatStore.getState>['pendingApprovals']
): Array<{ type: 'single'; request: (typeof requests)[0] } | { type: 'batch'; requests: typeof requests }> {
  const result: Array<{ type: 'single'; request: (typeof requests)[0] } | { type: 'batch'; requests: typeof requests }> = []
  let i = 0
  while (i < requests.length) {
    const req = requests[i]
    if (req.status !== 'pending') {
      result.push({ type: 'single', request: req })
      i++
      continue
    }
    let j = i + 1
    while (
      j < requests.length &&
      requests[j].status === 'pending' &&
      requests[j].toolName === req.toolName &&
      requests[j].riskLevel === req.riskLevel
    ) {
      j++
    }
    const run = requests.slice(i, j)
    if (run.length >= 3) {
      result.push({ type: 'batch', requests: run })
    } else {
      for (const r of run) {
        result.push({ type: 'single', request: r })
      }
    }
    i = j
  }
  return result
}

export const MessageBubble = memo(function MessageBubble({ message, assistantMessage }: MessageBubbleProps) {
  const { t } = useTranslation()
  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'
  const isTool = message.role === 'tool'
  const isStreaming = message.isStreaming

  const { pendingApprovals, approveToolCall, rejectToolCall } = useChatStore(
    (state) => ({
      pendingApprovals: state.pendingApprovals,
      approveToolCall: state.approveToolCall,
      rejectToolCall: state.rejectToolCall,
    })
  )

  // 为当前助手消息匹配待审批的工具调用
  const messageApprovalRequests = useMemo(() => {
    if (!isAssistant || !message.toolCalls || message.toolCalls.length === 0) return []
    const ids = new Set(message.toolCalls.map((tc) => tc.id))
    return pendingApprovals.filter((req) => ids.has(req.toolCallId))
  }, [isAssistant, message.toolCalls, pendingApprovals])

  // 用户消息：提取纯净显示内容
  const userDisplay = isUser
    ? extractUserDisplayContent(message.content, message.attachments)
    : null

  // 助手消息：如果有显式 ```python 代码块（包括未闭合的），从 Markdown 渲染中移除代码部分，
  // 避免与 ThinkingProcess 重复显示；裸 ``` 块（普通示例、其他语言）正常留在气泡里渲染
  const assistantDisplayContent = useMemo(() => {
    if (!isAssistant || !message.content) return message.content || ''
    const hasCode = extractPythonCode(message.content).length > 0
    if (!hasCode) return message.content
    let content = message.content
    // 先移除已闭合的 ```python 代码块
    content = content.replace(/```python\s*\n?[\s\S]*?```/gi, '')
    // 再移除未闭合的 ```python 块（从最后一个 ```python 到结尾）
    const unclosed = content.match(/```python\s*\n?[\s\S]*$/i)
    if (unclosed && unclosed.index !== undefined) {
      content = content.slice(0, unclosed.index)
    }
    return content.trim()
  }, [isAssistant, message.content])

  // 最终渲染内容：流式输出期间使用轻量级格式化把被 LLM 压缩到同一行的表格/标题/列表拆回标准 Markdown，
  // 流结束后再做完整规范化（去重、补空行等），保证刷新后图表也能正确渲染。
  const renderContent = useMemo(() => {
    const raw = isUser && userDisplay
      ? userDisplay.displayContent
      : isAssistant
        ? assistantDisplayContent
        : message.content || ''
    return isStreaming ? formatStreamingMarkdown(raw) : normalizeMarkdown(raw)
  }, [isUser, userDisplay, isAssistant, assistantDisplayContent, message.content, isStreaming])

  // Markdown 渲染组件按用户/助手区分，必须在流式输出期间保持稳定，否则每次 chunk 都会导致整棵 DOM 树重新挂载，格式会闪烁/丢失
  const markdownComponents = useMemo(() => createMarkdownComponents(isUser), [isUser])

  // 工具消息：优先渲染结构化数据（图表/下载链接），无结构化数据但有内容时显示文本（通常是错误信息）
  if (isTool) {
    const hasData = !!message.structuredData
    const hasContent = !!message.content
    const isSearchCalling = message.toolCallName === 'web_search' && message.toolCallStatus === 'calling'
    const isPresentArtifactCalling = message.toolCallName === 'present_artifact' && message.toolCallStatus === 'calling'
    if (!hasData && !hasContent && !isSearchCalling && !isPresentArtifactCalling) return null

    const ToolResultRenderer = message.toolCallName
      ? getToolResultRenderer(message.toolCallName)
      : undefined

    return (
      <div className="flex gap-3 flex-row">
        <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center mt-1 bg-amber-100">
          {message.toolCallStatus === 'calling' ? (
            <Loader2 size={16} className="animate-spin text-amber-600" />
          ) : message.toolCallStatus === 'error' || message.toolCallStatus === 'cancelled' ? (
            <XCircle size={16} className="text-red-500" />
          ) : (
            <CheckCircle2 size={16} className="text-green-600" />
          )}
        </div>
        <div className="max-w-[80%] w-full">
          {/* 已注册专属渲染器的工具结果 */}
          {hasData && ToolResultRenderer && (
            <ToolResultRenderer message={message} assistantMessage={assistantMessage} />
          )}
          {/* 有结构化数据时渲染图表/表格/下载链接 */}
          {hasData && !ToolResultRenderer && hasChartData(message.structuredData) && (
            <ToolCallCard message={message} assistantMessage={assistantMessage}>
              <ChartRenderer structuredData={message.structuredData} />
            </ToolCallCard>
          )}
          {hasData && !ToolResultRenderer && !hasChartData(message.structuredData) && (
            <ToolCallCard message={message} assistantMessage={assistantMessage}>
              <StructuredDataPreview data={message.structuredData} />
            </ToolCallCard>
          )}
          {/* 无结构化数据但有内容时显示文本（通常是错误信息） */}
          {!hasData && hasContent && (
            <ToolCallCard message={message} assistantMessage={assistantMessage}>
              <div className="text-xs text-surface-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {message.content}
              </div>
            </ToolCallCard>
          )}
          {/* 联网搜索执行中 */}
          {isSearchCalling && (
            <div className="flex items-center gap-2 text-xs text-surface-500 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <Loader2 size={14} className="animate-spin text-primary-500" />
              {t('chat.messageBubble.searchingWeb')}
            </div>
          )}
          {/* present_artifact 调用中骨架屏 */}
          {isPresentArtifactCalling && (
            <ArtifactSkeleton variant="image" />
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex gap-3 group',
        isUser ? 'flex-row-reverse' : 'flex-row'
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center mt-1',
          isUser && 'bg-primary-500',
          isAssistant && 'bg-surface-200',
          isTool && 'bg-amber-100'
        )}
      >
        {isUser && <User size={16} className="text-white" />}
        {isAssistant && <img src="./iris-logo.svg" alt="Iris" className="w-5 h-5 object-contain" />}
        {isTool && <span className="text-amber-600 text-xs">⚙</span>}
      </div>

      {/* Content */}
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-4 py-3',
          isUser && 'bg-primary-500 text-white rounded-br-md',
          isAssistant && 'bg-white border border-surface-200 rounded-bl-md shadow-sm',
          isTool && 'bg-amber-50 border border-amber-200 rounded-bl-md'
        )}
      >
        {/* Thinking Process：Python 代码、联网搜索、WebBridge、文档生成工具或工作流 Agent 执行时显示折叠面板 */}
        {isAssistant && (extractPythonCode(message.content || '').length > 0 || message.toolCallName === 'web_search' || message.toolCallName === 'webbridge' || message.toolCallName === 'dag_execution' || isDocumentTool(message.toolCallName) || !!message.thinkingProcess) && (
          <ThinkingProcess
            content={message.content || ''}
            executionLog={message.thinkingProcess?.executionLog || ''}
            status={message.thinkingProcess?.status || (message.isStreaming ? 'coding' : 'completed')}
            initialExpanded={message.thinkingProcess?.isExpanded ?? true}
            toolCallName={message.toolCallName}
            webBridgeState={message.webBridgeState}
          />
        )}

        {/* Reasoning：模型中间推理过程 */}
        {isAssistant && message.reasoningContent && <ReasoningBlock content={message.reasoningContent} />}

        {/* Streaming / Thinking / Error / Cancelled indicator */}
        {isAssistant && (
          <>
            {message.status === 'thinking' && (
              <div className="flex items-center gap-1.5 mb-2">
                <Loader2 size={14} className="animate-spin text-primary-500" />
                <span className="text-xs text-surface-400">{t('chat.messageBubble.thinking')}</span>
              </div>
            )}
            {message.status === 'streaming' && (
              <div className="flex items-center gap-1.5 mb-2">
                <Loader2 size={14} className="animate-spin text-primary-500" />
                <span className="text-xs text-surface-400">{t('chat.messageBubble.writing')}</span>
              </div>
            )}
            {message.status === 'calling_tools' && (
              <div className="flex items-center gap-1.5 mb-2">
                <Loader2 size={14} className="animate-spin text-amber-500" />
                <span className="text-xs text-surface-400">{t('chat.messageBubble.callingTools')}</span>
              </div>
            )}
            {message.status === 'awaiting_approval' && (
              <div className="flex items-center gap-1.5 mb-2 px-2 py-1.5 bg-amber-50 border border-amber-200 rounded-lg">
                <AlertTriangle size={14} className="text-amber-500 flex-shrink-0" />
                <span className="text-xs text-amber-600">{t('chat.messageBubble.awaitingApproval')}</span>
              </div>
            )}
            {message.status === 'error' && (
              <div className="flex flex-col gap-2 mb-2">
                <div className="flex items-center gap-1.5 px-2 py-1.5 bg-red-50 border border-red-200 rounded-lg">
                  <XCircle size={14} className="text-red-500 flex-shrink-0" />
                  <span className="text-xs text-red-600">{message.errorMessage || t('chat.messageBubble.error')}</span>
                </div>
                <button
                  onClick={() => {
                    // 重试：重新发送用户消息
                    const store = useChatStore.getState()
                    const messages = store.messages
                    const currentIndex = messages.findIndex((m) => m.id === message.id)
                    if (currentIndex > 0) {
                      const userMessage = messages[currentIndex - 1]
                      if (userMessage.role === 'user') {
                        store.sendMessage(userMessage.content)
                      }
                    }
                  }}
                  className="flex items-center gap-1.5 self-start px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors"
                >
                  <RotateCcw size={12} />
                  {t('chat.messageBubble.retry')}
                </button>
              </div>
            )}
            {message.status === 'cancelled' && (
              <div className="flex items-center gap-1.5 mb-2 px-2 py-1.5 bg-amber-50 border border-amber-200 rounded-lg">
                <AlertTriangle size={14} className="text-amber-500 flex-shrink-0" />
                <span className="text-xs text-amber-600">{t('chat.messageBubble.cancelled')}</span>
              </div>
            )}
          </>
        )}

        {/* 审批工具调用卡片（支持批量聚合） */}
        {isAssistant && messageApprovalRequests.length > 0 && (
          <div className="mb-2 space-y-2">
            {groupApprovalRequests(messageApprovalRequests).map((item) =>
              item.type === 'batch' ? (
                <BatchApprovalCard
                  key={`batch-${item.requests[0].toolCallId}`}
                  requests={item.requests}
                  onApproveItem={approveToolCall}
                  onRejectItem={rejectToolCall}
                />
              ) : (
                <ApprovalCard
                  key={item.request.toolCallId}
                  request={item.request}
                  status={item.request.status}
                  onApprove={item.request.status === 'pending' ? approveToolCall : undefined}
                  onReject={item.request.status === 'pending' ? rejectToolCall : undefined}
                />
              )
            )}
          </div>
        )}

        {/* Message content */}
        <div
          className={cn(
            'prose prose-sm max-w-none',
            isUser ? 'text-white' : 'text-surface-700'
          )}
        >
          {isStreaming && !message.content ? (
            <span className="text-surface-400">...</span>
          ) : (
            <ReactMarkdown
              remarkPlugins={remarkPlugins}
              components={markdownComponents}
            >
              {renderContent}
            </ReactMarkdown>
          )}

          {/* 助手消息中的图表 */}
          {isAssistant && !!message.structuredData && hasChartData(message.structuredData) && (
            <ChartRenderer structuredData={message.structuredData} />
          )}
        </div>

        {/* 助手消息反馈按钮 */}
        {isAssistant && message.status === 'done' && message.content && (
          <FeedbackButtons message={message} />
        )}

        {/* 用户消息附件预览 / 历史附件提示 */}
        {isUser && userDisplay && userDisplay.hasAttachments && (
          <div className="flex flex-wrap gap-2 mt-2">
            {userDisplay.attachments ? (
              // 本地新消息：显示具体附件预览
              userDisplay.attachments.map((att) => (
                <div key={att.id}>
                  {att.type === 'image' && att.previewUrl ? (
                    <img
                      src={att.previewUrl}
                      alt={att.name}
                      className="max-h-48 rounded-lg border border-surface-200"
                    />
                  ) : (
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/20 border border-white/30 text-xs">
                      {att.type === 'image' ? (
                        <FileImage size={12} />
                      ) : att.type === 'text' ? (
                        <FileText size={12} />
                      ) : (
                        <File size={12} />
                      )}
                      <span className="max-w-[120px] truncate">{att.name}</span>
                      <span className="opacity-70">{formatFileSize(att.size)}</span>
                    </div>
                  )}
                </div>
              ))
            ) : (
              // 历史消息：仅提示包含附件
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/20 border border-white/30 text-xs">
                <File size={12} />
                <span>{t('chat.messageBubble.containsFile')}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

/**
 * 助手消息反馈按钮：复制、点赞、点踩
 */
function FeedbackButtons({ message }: { message: ChatMessage }) {
  const { t } = useTranslation()
  const { setMessageFeedback } = useChatStore()
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content || '')
      setCopied(true)
      toast.success(t('chat.messageBubble.copied'))
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(t('chat.messageBubble.copyFailed'))
    }
  }

  const handleLike = () => {
    setMessageFeedback(message.id, message.feedback === 'like' ? null : 'like')
  }

  const handleDislike = () => {
    setMessageFeedback(message.id, message.feedback === 'dislike' ? null : 'dislike')
  }

  return (
    <div className="flex items-center gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
      <button
        onClick={handleCopy}
        className={cn(
          'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] transition-colors',
          copied
            ? 'bg-green-50 text-green-600'
            : 'text-surface-400 hover:text-surface-600 hover:bg-surface-100'
        )}
        title={t('chat.messageBubble.copy')}
      >
        <Copy size={12} />
        <span>{copied ? t('chat.messageBubble.copied') : t('chat.messageBubble.copy')}</span>
      </button>
      <button
        onClick={handleLike}
        className={cn(
          'p-1.5 rounded-md transition-colors',
          message.feedback === 'like'
            ? 'bg-green-50 text-green-600'
            : 'text-surface-400 hover:text-surface-600 hover:bg-surface-100'
        )}
        title={t('chat.messageBubble.like')}
      >
        <ThumbsUp size={12} />
      </button>
      <button
        onClick={handleDislike}
        className={cn(
          'p-1.5 rounded-md transition-colors',
          message.feedback === 'dislike'
            ? 'bg-red-50 text-red-600'
            : 'text-surface-400 hover:text-surface-600 hover:bg-surface-100'
        )}
        title={t('chat.messageBubble.dislike')}
      >
        <ThumbsDown size={12} />
      </button>
    </div>
  )
}

/**
 * 模型 reasoning / thinking 内容折叠面板
 * 用于展示 DeepSeek-R1 / Claude thinking 等模型产生的中间推理过程。
 */
function ReasoningBlock({ content }: { content: string }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  if (!content || !content.trim()) return null

  return (
    <div className="mb-3 rounded-xl border border-[#BFDBFE] bg-[#DBEAFE] overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[#BFDBFE]/30"
      >
        <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-[#BFDBFE]">
          <Brain className="h-3.5 w-3.5 text-[#2563EB]" />
        </div>
        <span className="text-xs font-medium text-[#2563EB]">{t('chat.messageBubble.reasoning')}</span>
        {expanded ? (
          <ChevronDown size={14} className="ml-auto text-[#3B82F6]" />
        ) : (
          <ChevronRight size={14} className="ml-auto text-[#3B82F6]" />
        )}
      </button>
      {expanded && (
        <div className="border-t border-[#BFDBFE] px-3 pb-3">
          <div className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-[#1E40AF]">
            {content}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 将结构化数据导出为 CSV 并触发下载
 */
function exportToCsv(data: unknown[], fileName?: string) {
  if (!Array.isArray(data) || data.length === 0) return
  const firstRow = data[0] as Record<string, unknown>
  const columns = Object.keys(firstRow)
  const csvRows: string[] = []
  // BOM for Excel UTF-8
  csvRows.push('﻿' + columns.map(escapeCsv).join(','))
  for (const row of data) {
    const r = row as Record<string, unknown>
    csvRows.push(columns.map((c) => escapeCsv(r[c])).join(','))
  }
  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${fileName || 'export'}_${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function escapeCsv(val: unknown): string {
  const str = val == null ? '' : String(val)
  if (str.includes(',') || str.includes('\n') || str.includes('"')) {
    return '"' + str.replace(/"/g, '""') + '"'
  }
  return str
}

interface WorkspaceFileItem {
  path: string
  sizeBytes: number
  mimeType?: string
  sourceTool?: string
  createdAt?: string
}

function isWorkspaceFilesData(data: unknown): data is { workspaceFiles: WorkspaceFileItem[] } {
  if (!data || typeof data !== 'object') return false
  const files = (data as Record<string, unknown>).workspaceFiles
  return Array.isArray(files) && files.length > 0 && typeof files[0] === 'object' && files[0] !== null && 'path' in files[0]
}

function WorkspaceFileCard({ file }: { file: WorkspaceFileItem }) {
  const { t } = useTranslation()
  const { selectPath, expandPath, previewFile } = useWorkspaceFileStore()
  const iconInfo = getFileIconInfo(file.path)
  const fileName = file.path.split('/').pop() || file.path

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(file.path)
      toast.success(t('chat.workspaceFilesPanel.copied'))
    } catch {
      toast.error(t('chat.workspaceFilesPanel.copyFailed'))
    }
  }

  const handleOpen = () => {
    selectPath(file.path)
    const parts = file.path.split('/').filter(Boolean)
    let acc = ''
    for (const part of parts.slice(0, -1)) {
      acc += '/' + part
      expandPath(acc)
    }
    previewFile(file.path)
  }

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg border border-surface-200 bg-white hover:border-primary-300 transition-colors">
      <iconInfo.icon size={32} className={cn('flex-shrink-0 mt-0.5', iconInfo.colorClass)} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-surface-800 truncate" title={fileName}>{fileName}</div>
        <div className="text-xs text-surface-500 truncate mt-0.5" title={file.path}>{file.path}</div>
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-[10px] text-surface-400">{formatFileSizeUnified(file.sizeBytes)}</span>
          {file.sourceTool && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary-50 text-primary-700">
              {file.sourceTool}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={handleOpen}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] bg-primary-50 text-primary-700 hover:bg-primary-100 transition-colors"
          >
            {t('chat.workspaceFilesPanel.openInWorkspace')}
          </button>
          <a
            href={resolveDownloadUrl(file.path)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-surface-600 hover:bg-surface-100 transition-colors"
          >
            <Download size={12} />
            {t('chat.messageBubble.download')}
          </a>
          <button
            onClick={handleCopyPath}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-surface-600 hover:bg-surface-100 transition-colors"
          >
            <Copy size={12} />
            {t('chat.workspaceFilesPanel.copyPath')}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 从后端结构化数据中提取可表格化的行数组
 * 支持 { rows: [...] } / { data: [...] } / 直接数组
 */
function extractRows(data: unknown): Record<string, unknown>[] | null {
  if (!data || typeof data !== 'object') return null
  if (Array.isArray(data) && data.length > 0) {
    return data as Record<string, unknown>[]
  }
  const obj = data as Record<string, unknown>
  if (Array.isArray(obj.rows) && obj.rows.length > 0) {
    return obj.rows as Record<string, unknown>[]
  }
  if (Array.isArray(obj.data) && obj.data.length > 0) {
    return obj.data as Record<string, unknown>[]
  }
  return null
}

/**
 * 结构化数据预览（非图表数据时显示为表格）
 */
function StructuredDataPreview({ data }: { data: unknown }) {
  const { t } = useTranslation()
  if (!data || typeof data !== 'object') return null

  const rows = extractRows(data)

  // 如果是数组，显示为表格
  if (rows && rows.length > 0) {
    const firstRow = rows[0]
    const columns = Object.keys(firstRow).slice(0, 8) // 最多显示8列

    return (
      <div className="mt-2 rounded-lg border border-surface-200 overflow-hidden bg-white">
        <div className="flex items-center justify-between px-3 py-2 bg-surface-50 border-b border-surface-200">
          <span className="text-xs text-surface-500">{t('chat.messageBubble.queryResult')}</span>
          <button
            onClick={() => exportToCsv(rows, 'query_result')}
            className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 transition-colors"
            title={t('chat.messageBubble.exportFile')}
          >
            <Download size={12} />
            {t('chat.messageBubble.export')}
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="bg-surface-100">
                {columns.map((col) => (
                  <th key={col} className="px-2 py-1.5 text-left font-medium text-surface-600 border-b border-surface-200">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 10).map((row, i) => (
                <tr key={i} className="hover:bg-surface-50">
                  {columns.map((col) => (
                    <td key={col} className="px-2 py-1.5 border-b border-surface-100 text-surface-700">
                      {String(row[col] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > 10 && (
          <div className="px-2 py-1 text-xs text-surface-400 bg-surface-50">
            {t('chat.messageBubble.totalData', { count: rows.length })}
          </div>
        )}
      </div>
    )
  }

  const obj = data as Record<string, unknown>

  // 后端生成文件元数据（workspaceFiles）
  if (isWorkspaceFilesData(data)) {
    return (
      <div className="mt-2 space-y-2">
        {data.workspaceFiles.map((file) => (
          <WorkspaceFileCard key={file.path} file={file} />
        ))}
      </div>
    )
  }

  // 后端导出返回的 downloadUrl
  if ('downloadUrl' in obj && typeof obj.downloadUrl === 'string') {
    return (
      <div className="mt-2 rounded-lg border border-surface-200 overflow-hidden bg-white">
        <div className="flex items-center justify-between px-3 py-2 bg-surface-50 border-b border-surface-200">
          <span className="text-xs text-surface-500">{t('chat.messageBubble.exportFile')}</span>
          <a
            href={resolveDownloadUrl(obj.downloadUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 transition-colors"
          >
            <Download size={12} />
            {t('chat.messageBubble.download')}
          </a>
        </div>
        {'fileName' in obj && (
          <div className="px-3 py-2 text-xs text-surface-600">
            {String(obj.fileName)}
            {'expiresIn' in obj && <span className="text-surface-400 ml-2">({t('chat.messageBubble.validWithin', { time: String(obj.expiresIn) })})</span>}
          </div>
        )}
      </div>
    )
  }

  // 如果是对象，显示为键值对
  const keys = Object.keys(obj).slice(0, 20)
  if (keys.length === 0) return null

  return (
    <div className="mt-2 rounded-lg border border-surface-200 overflow-hidden bg-white">
      <table className="min-w-full text-xs">
        <tbody>
          {keys.map((key) => (
            <tr key={key} className="hover:bg-surface-50">
              <td className="px-2 py-1.5 border-b border-surface-100 font-medium text-surface-600 w-1/3">
                {key}
              </td>
              <td className="px-2 py-1.5 border-b border-surface-100 text-surface-700">
                {typeof obj[key] === 'object'
                  ? JSON.stringify(obj[key]).slice(0, 200)
                  : String(obj[key] ?? '')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
