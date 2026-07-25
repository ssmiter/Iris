import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Loader2, CheckCircle2, XCircle, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/utils'
import type { ToolThinkingRendererProps } from '@/agent/tools/toolRenderRegistry'

export function WebSearchThinking({
  status,
  initialExpanded = true,
}: ToolThinkingRendererProps) {
  const [isExpanded, setIsExpanded] = useState(initialExpanded)
  const { t } = useTranslation()

  const statusConfig = {
    planning: {
      label: t('chat.thinkingProcess.preparingSearch'),
      icon: <Search size={14} className="text-surface-400" />,
      badgeClass: 'bg-surface-100 text-surface-500',
    },
    coding: {
      label: t('chat.thinkingProcess.searching'),
      icon: <Loader2 size={14} className="animate-spin text-primary-500" />,
      badgeClass: 'bg-primary-50 text-primary-600',
    },
    running: {
      label: t('chat.thinkingProcess.searching'),
      icon: <Loader2 size={14} className="animate-spin text-primary-500" />,
      badgeClass: 'bg-primary-50 text-primary-600 animate-pulse',
    },
    completed: {
      label: t('chat.thinkingProcess.searchCompleted'),
      icon: <CheckCircle2 size={14} className="text-green-500" />,
      badgeClass: 'bg-green-50 text-green-600',
    },
    error: {
      label: t('chat.thinkingProcess.searchFailed'),
      icon: <XCircle size={14} className="text-red-500" />,
      badgeClass: 'bg-red-50 text-red-600',
    },
  }

  const current = statusConfig[status]

  return (
    <div className="mb-3 rounded-xl border border-surface-200 overflow-hidden bg-white shadow-sm">
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
          {current.icon}
          <span className="text-xs font-medium text-surface-700">
            {t('chat.thinkingProcess.webSearch')}
          </span>
        </div>
        <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium', current.badgeClass)}>
          {current.label}
        </span>
      </button>

      {isExpanded && status === 'running' && (
        <div className="border-t border-surface-100 px-3 py-6 text-center text-xs text-surface-400">
          <Loader2 size={16} className="animate-spin mx-auto mb-2 text-primary-400" />
          {t('chat.thinkingProcess.searchingWeb')}
        </div>
      )}
    </div>
  )
}
