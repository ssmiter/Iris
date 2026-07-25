import { memo, useState, type ReactNode, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, CheckCircle2, XCircle, ChevronDown, ChevronRight, Wrench, Ban } from 'lucide-react'
import { cn } from '@/utils'
import type { ChatMessage } from '@/types/chat'
import { useChatStore } from '@/stores/chatStore'

interface ToolCallCardProps {
  message: ChatMessage
  /** 关联的 assistant 消息，用于读取 toolCalls 中的参数 */
  assistantMessage?: ChatMessage
  /** 自定义结果渲染；未提供时显示原始 content / structuredData */
  children?: ReactNode
}

function parseArguments(args?: string | Record<string, unknown>): Record<string, unknown> | null {
  if (!args) return null
  if (typeof args === 'object') return args
  try {
    return JSON.parse(args)
  } catch {
    return null
  }
}

function formatArguments(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

function summarizeResult(content?: string, structuredData?: unknown): string {
  if (!content && !structuredData) return ''
  if (content) {
    const trimmed = content.trim()
    if (trimmed.length > 120) return trimmed.slice(0, 120) + '...'
    return trimmed
  }
  const text = JSON.stringify(structuredData)
  if (text.length > 120) return text.slice(0, 120) + '...'
  return text
}

export const ToolCallCard = memo(function ToolCallCard({ message, assistantMessage, children }: ToolCallCardProps) {
  const { t } = useTranslation()
  const { cancelToolCall } = useChatStore()
  const [expanded, setExpanded] = useState(false)

  const toolName = message.toolCallName || t('chat.toolCallCard.unknownTool')
  const status = message.toolCallStatus || 'done'
  const isCalling = status === 'calling'
  const isError = status === 'error'
  const isCancelled = status === 'cancelled'

  // 从 assistantMessage.toolCalls 中匹配参数
  const matchedCall = assistantMessage?.toolCalls?.find((c) => c.id === message.toolCallId)
  const args = parseArguments(matchedCall?.function?.arguments)

  const resultSummary = summarizeResult(message.content, message.structuredData)

  const handleCancel = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    if (message.toolCallId && isCalling) {
      cancelToolCall(message.toolCallId)
    }
  }

  return (
    <div
      className={cn(
        'mt-2 rounded-xl border overflow-hidden bg-white shadow-sm',
        isError || isCancelled ? 'border-red-200' : 'border-surface-200'
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'w-full flex items-center justify-between px-3 py-2.5 hover:bg-surface-50 transition-colors',
          (isError || isCancelled) && 'hover:bg-red-50'
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div
            className={cn(
              'flex-shrink-0 w-6 h-6 rounded-lg flex items-center justify-center',
              isCalling
                ? 'bg-primary-50'
                : isError || isCancelled
                  ? 'bg-red-50'
                  : 'bg-green-50'
            )}
          >
            {isCalling ? (
              <Loader2 size={14} className="animate-spin text-primary-500" />
            ) : isError || isCancelled ? (
              <XCircle size={14} className="text-red-500" />
            ) : (
              <CheckCircle2 size={14} className="text-green-500" />
            )}
          </div>
          <Wrench size={14} className="flex-shrink-0 text-surface-400" />
          <span className="text-xs font-medium text-surface-700 truncate">
            {t('chat.toolCallCard.tool')}: {toolName}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isCalling && (
            <button
              type="button"
              onClick={handleCancel}
              title={t('chat.toolCallCard.cancel')}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
            >
              <Ban size={10} />
              {t('chat.toolCallCard.cancel')}
            </button>
          )}
          <span
            className={cn(
              'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
              isCalling
                ? 'bg-primary-50 text-primary-600'
                : isError || isCancelled
                  ? 'bg-red-50 text-red-600'
                  : 'bg-green-50 text-green-600'
            )}
          >
            {isCalling
              ? t('chat.toolCallCard.calling')
              : isError
                ? t('chat.toolCallCard.error')
                : isCancelled
                  ? t('chat.toolCallCard.cancelled')
                  : t('chat.toolCallCard.done')}
          </span>
          {expanded ? (
            <ChevronDown size={14} className="text-surface-400" />
          ) : (
            <ChevronRight size={14} className="text-surface-400" />
          )}
        </div>
      </button>

      {!expanded && resultSummary && (
        <div className="px-3 py-2 border-t border-surface-100 bg-surface-50/50">
          <p className="text-[11px] text-surface-500 line-clamp-1">{resultSummary}</p>
        </div>
      )}

      {expanded && (
        <div className="border-t border-surface-100">
          {args && (
            <div className="border-b border-surface-100">
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-50 border-b border-surface-100">
                <span className="text-[10px] font-medium text-surface-500">{t('chat.toolCallCard.arguments')}</span>
              </div>
              <pre className="p-3 text-[11px] font-mono text-surface-700 bg-white overflow-x-auto">
                {formatArguments(args)}
              </pre>
            </div>
          )}

          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-50 border-b border-surface-100">
            <span className="text-[10px] font-medium text-surface-500">{t('chat.toolCallCard.result')}</span>
          </div>
          <div className="p-3 text-[11px] text-surface-700 bg-white">
            {isCalling ? (
              <div className="flex items-center gap-2 text-surface-400">
                <Loader2 size={12} className="animate-spin" />
                {t('chat.toolCallCard.waitingForResult')}
              </div>
            ) : isCancelled ? (
              <div className="flex items-center gap-2 text-red-500">
                <Ban size={12} />
                {t('chat.toolCallCard.cancelledByUser')}
              </div>
            ) : children ? (
              children
            ) : message.structuredData ? (
              <pre className="font-mono text-[11px] overflow-x-auto">
                {JSON.stringify(message.structuredData, null, 2)}
              </pre>
            ) : message.content ? (
              <p className="whitespace-pre-wrap">{message.content}</p>
            ) : (
              <span className="text-surface-400">{t('chat.toolCallCard.noResult')}</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
})
