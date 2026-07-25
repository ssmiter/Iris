import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert, CheckCircle2, XCircle, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/utils'
import { ApprovalCard } from './ApprovalCard'
import type { ApprovalRequest, ToolRiskLevel } from '@/agent/types'

interface BatchApprovalCardProps {
  requests: ApprovalRequest[]
  onApproveItem?: (toolCallId: string, reason?: string) => void
  onRejectItem?: (toolCallId: string, reason?: string) => void
  disabled?: boolean
}

interface RiskConfig {
  label: string
  accentColor: string
  badgeTextClass: string
  badgeBorderClass: string
  emphasisWidth: string
}

const riskLevelConfig: Record<ToolRiskLevel, RiskConfig> = {
  read_only: {
    label: '只读',
    accentColor: '#2563EB',
    badgeTextClass: 'text-blue-700',
    badgeBorderClass: 'border-blue-200',
    emphasisWidth: 'border-l-[3px]',
  },
  standard: {
    label: '标准',
    accentColor: '#2563EB',
    badgeTextClass: 'text-blue-700',
    badgeBorderClass: 'border-blue-200',
    emphasisWidth: 'border-l-[3px]',
  },
  elevated: {
    label: '需要确认的写入操作',
    accentColor: '#9A7B2F',
    badgeTextClass: 'text-[#9A7B2F]',
    badgeBorderClass: 'border-[#9A7B2F]/40',
    emphasisWidth: 'border-l-[3px]',
  },
  destructive: {
    label: '破坏性操作',
    accentColor: '#9C4A38',
    badgeTextClass: 'text-[#9C4A38]',
    badgeBorderClass: 'border-[#9C4A38]/40',
    emphasisWidth: 'border-l-4',
  },
}

export const BatchApprovalCard = memo(function BatchApprovalCard({
  requests,
  onApproveItem,
  onRejectItem,
  disabled = false,
}: BatchApprovalCardProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  const first = requests[0]
  const count = requests.length
  const config = riskLevelConfig[first.riskLevel]

  const handleApproveAll = () => {
    for (const req of requests) {
      onApproveItem?.(req.toolCallId)
    }
  }

  const handleRejectAll = () => {
    for (const req of requests) {
      onRejectItem?.(req.toolCallId)
    }
  }

  return (
    <div
      className={cn(
        'mt-2 rounded-xl border border-surface-200 bg-white shadow-sm overflow-hidden',
        config.emphasisWidth,
        'transition-colors duration-200 motion-reduce:transition-none'
      )}
      style={{ borderLeftColor: config.accentColor }}
      role="region"
      aria-label={t('chat.approvalCard.title')}
    >
      <div className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <ShieldAlert
              size={16}
              className={cn('flex-shrink-0', config.badgeTextClass)}
              aria-hidden="true"
            />
            <span
              className={cn(
                'text-[11px] px-1.5 py-0.5 rounded-full border bg-white/60',
                config.badgeTextClass,
                config.badgeBorderClass
              )}
            >
              {config.label}
            </span>
            <span className="text-[11px] text-surface-500">
              {t('chat.approvalCard.batchItems', { count })}
            </span>
          </div>
          <span className="flex items-center gap-1 text-[11px] font-medium text-[#9C4A38]">
            <ShieldAlert size={12} aria-hidden="true" />
            {t('chat.approvalCard.pending')}
          </span>
        </div>

        <div className="mt-2.5">
          <p className="text-base font-semibold text-surface-900 leading-snug">
            {t('chat.approvalCard.batchImpact', { toolName: first.toolName, count })}
          </p>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={handleApproveAll}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium',
              'bg-[#3C7A6B] text-white hover:bg-[#2F6155] focus:outline-none focus:ring-2 focus:ring-[#3C7A6B]/40',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'transition-colors duration-150 motion-reduce:transition-none'
            )}
          >
            <CheckCircle2 size={14} aria-hidden="true" />
            {t('chat.approvalCard.approveAll')}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={handleRejectAll}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium',
              'bg-[#9C4A38] text-white hover:bg-[#7D3A2C] focus:outline-none focus:ring-2 focus:ring-[#9C4A38]/40',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'transition-colors duration-150 motion-reduce:transition-none'
            )}
          >
            <XCircle size={14} aria-hidden="true" />
            {t('chat.approvalCard.rejectAll')}
          </button>
        </div>

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-3 flex items-center gap-1 text-xs text-surface-500 hover:text-surface-700 focus:outline-none focus:underline"
          aria-expanded={expanded}
        >
          {expanded ? (
            <>
              <ChevronUp size={14} aria-hidden="true" />
              {t('chat.approvalCard.hideItems')}
            </>
          ) : (
            <>
              <ChevronDown size={14} aria-hidden="true" />
              {t('chat.approvalCard.reviewItemByItem')}
            </>
          )}
        </button>

        {expanded && (
          <div className="mt-2 space-y-2 pl-2 border-l-2 border-surface-100">
            {requests.map((req) => (
              <ApprovalCard
                key={req.toolCallId}
                request={req}
                status="pending"
                onApprove={onApproveItem}
                onReject={onRejectItem}
                disabled={disabled}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
})
