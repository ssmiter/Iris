import { memo, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ShieldAlert,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
  Clock,
  Sparkles,
} from 'lucide-react'
import { cn } from '@/utils'
import { safeStringify } from '@/utils/safeSerialize'
import { useChatStore } from '@/stores/chatStore'
import type { ApprovalRequest, ToolRiskLevel } from '@/agent/types'
import { isSqlWriteOperation } from '@/agent/pipelines/approvalExplain/sqlClassifier'

type ApprovalCardStatus = 'pending' | 'approved' | 'rejected' | 'expired'

interface ApprovalCardProps {
  request: ApprovalRequest
  status?: ApprovalCardStatus
  onApprove?: (toolCallId: string, reason?: string) => void
  onReject?: (toolCallId: string, reason?: string) => void
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

const statusConfig: Record<
  ApprovalCardStatus,
  { icon: React.ElementType; textClass: string; labelKey: string }
> = {
  pending: { icon: ShieldAlert, textClass: 'text-[#9C4A38]', labelKey: 'chat.approvalCard.pending' },
  approved: { icon: CheckCircle2, textClass: 'text-[#3C7A6B]', labelKey: 'chat.approvalCard.approved' },
  rejected: { icon: XCircle, textClass: 'text-surface-500', labelKey: 'chat.approvalCard.rejected' },
  expired: { icon: Clock, textClass: 'text-surface-500', labelKey: 'chat.approvalCard.expired' },
}

function formatRawParams(params: Record<string, unknown>): string {
  try {
    return JSON.stringify(params, null, 2)
  } catch {
    return safeStringify(params) ?? '{}'
  }
}

export const ApprovalCard = memo(function ApprovalCard({
  request,
  status = 'pending',
  onApprove,
  onReject,
  disabled = false,
}: ApprovalCardProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [isRejecting, setIsRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [explainLoading, setExplainLoading] = useState(false)
  const [explainError, setExplainError] = useState(false)
  const isPending = status === 'pending'

  const config = riskLevelConfig[request.riskLevel]
  const statusCfg = statusConfig[status]
  const StatusIcon = statusCfg.icon

  const impactStatement = request.impactStatement || request.reason
  const hasRawParams = Object.keys(request.rawParams).length > 0

  const sql = typeof request.rawParams?.sql === 'string' ? request.rawParams.sql : ''
  const showSqlExplainButton =
    isPending && request.toolName === 'execute_sql_query' && isSqlWriteOperation(sql)
  const hasSqlExplainSummary = !!request.sqlExplainSummary

  // 本地过期防御：基于 expiresAt 自动置为 expired
  useEffect(() => {
    if (!isPending || !request.expiresAt) return
    const delay = request.expiresAt - Date.now()
    if (delay <= 0) {
      useChatStore.getState().expireToolCall(request.toolCallId)
      return
    }
    const timer = setTimeout(() => {
      useChatStore.getState().expireToolCall(request.toolCallId)
    }, delay)
    return () => clearTimeout(timer)
  }, [isPending, request.expiresAt, request.toolCallId])

  const handleReject = () => {
    if (!isRejecting) {
      setIsRejecting(true)
      return
    }
    onReject?.(request.toolCallId, rejectReason.trim() || undefined)
    setIsRejecting(false)
    setRejectReason('')
  }

  const handleCancelReject = () => {
    setIsRejecting(false)
    setRejectReason('')
  }

  const handleExplainSql = async () => {
    if (explainLoading || !showSqlExplainButton) return
    setExplainLoading(true)
    setExplainError(false)
    try {
      await useChatStore.getState().requestSqlExplain(request.toolCallId)
      if (!request.sqlExplainSummary) {
        setExplainError(true)
      }
    } catch {
      setExplainError(true)
    } finally {
      setExplainLoading(false)
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
        {/* 顶部行：徽标 + 风险等级 + 右上角状态标签 */}
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
          </div>
          <span
            className={cn(
              'flex items-center gap-1 text-[11px] font-medium',
              statusCfg.textClass
            )}
          >
            <StatusIcon size={12} aria-hidden="true" />
            {t(statusCfg.labelKey)}
          </span>
        </div>

        {/* 影响陈述句：签名元素 */}
        <div className="mt-2.5">
          <p className="text-base font-semibold text-surface-900 leading-snug">
            {impactStatement}
          </p>
          <p className="text-xs text-surface-500 mt-1">
            {t('chat.approvalCard.tool')}: <span className="font-medium text-surface-700">{request.toolName}</span>
          </p>
        </div>

        {/* SQL 写操作影响解释（approval_explain 试点） */}
        {showSqlExplainButton && (
          <div className="mt-2.5 rounded-lg bg-amber-50/60 border border-amber-200/60 p-2.5">
            {!hasSqlExplainSummary ? (
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs text-amber-800 leading-relaxed">
                  {t('chat.approvalCard.sqlWriteHint')}
                </p>
                <button
                  type="button"
                  disabled={explainLoading || disabled}
                  onClick={handleExplainSql}
                  className={cn(
                    'flex-shrink-0 flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md',
                    'bg-white border border-amber-200 text-amber-800 hover:bg-amber-50',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    'transition-colors duration-150 motion-reduce:transition-none'
                  )}
                >
                  <Sparkles size={12} aria-hidden="true" />
                  {explainLoading
                    ? t('chat.approvalCard.explainLoading')
                    : t('chat.approvalCard.explainSql')}
                </button>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-xs font-medium text-amber-900">
                  {t('chat.approvalCard.sqlImpactLabel')}
                </p>
                <p className="text-xs text-amber-800 leading-relaxed">
                  {request.sqlExplainSummary}
                </p>
              </div>
            )}
            {explainError && !hasSqlExplainSummary && (
              <p className="mt-1.5 text-[11px] text-red-600">
                {t('chat.approvalCard.explainError')}
              </p>
            )}
          </div>
        )}

        {/* 操作行 / 拒绝理由输入 */}
        {isPending ? (
          <div className="mt-3 space-y-2">
            {isRejecting ? (
              <div className="space-y-2">
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder={t('chat.approvalCard.rejectReasonPlaceholder')}
                  rows={2}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-surface-200 bg-white text-surface-700 placeholder:text-surface-400 focus:outline-none focus:ring-2 focus:ring-surface-300 resize-none"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={handleReject}
                    className={cn(
                      'flex-1 px-3 py-2 rounded-lg text-xs font-medium',
                      'bg-[#9C4A38] text-white hover:bg-[#7D3A2C] focus:outline-none focus:ring-2 focus:ring-[#9C4A38]/40',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                      'transition-colors duration-150 motion-reduce:transition-none'
                    )}
                  >
                    {t('chat.approvalCard.confirmReject')}
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelReject}
                    className={cn(
                      'flex-1 px-3 py-2 rounded-lg text-xs font-medium',
                      'bg-white text-surface-700 border border-surface-200 hover:bg-surface-50',
                      'focus:outline-none focus:ring-2 focus:ring-surface-300',
                      'transition-colors duration-150 motion-reduce:transition-none'
                    )}
                  >
                    {t('chat.approvalCard.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onApprove?.(request.toolCallId)}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium',
                    'bg-[#3C7A6B] text-white hover:bg-[#2F6155] focus:outline-none focus:ring-2 focus:ring-[#3C7A6B]/40',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    'transition-colors duration-150 motion-reduce:transition-none'
                  )}
                >
                  <CheckCircle2 size={14} aria-hidden="true" />
                  {t('chat.approvalCard.approve')}
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={handleReject}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium',
                    'bg-white text-surface-700 border border-surface-200 hover:bg-surface-50',
                    'focus:outline-none focus:ring-2 focus:ring-surface-300',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    'transition-colors duration-150 motion-reduce:transition-none'
                  )}
                >
                  <XCircle size={14} aria-hidden="true" />
                  {t('chat.approvalCard.reject')}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div
            className={cn(
              'mt-3 flex items-center gap-1.5 text-xs',
              status === 'approved' ? 'text-[#3C7A6B]' : 'text-surface-500'
            )}
            aria-live="polite"
          >
            <StatusIcon size={14} aria-hidden="true" />
            <span>
              {status === 'approved'
                ? t('chat.approvalCard.approvedHint')
                : status === 'rejected'
                ? t('chat.approvalCard.rejectedHint')
                : t('chat.approvalCard.expiredHint')}
            </span>
          </div>
        )}

        {/* 展开/收起完整参数 */}
        {hasRawParams && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-1 text-xs text-surface-500 hover:text-surface-700 focus:outline-none focus:underline"
              aria-expanded={expanded}
            >
              {expanded ? (
                <>
                  <ChevronUp size={14} aria-hidden="true" />
                  {t('chat.approvalCard.hideParams')}
                </>
              ) : (
                <>
                  <ChevronDown size={14} aria-hidden="true" />
                  {t('chat.approvalCard.viewParams')}
                </>
              )}
            </button>
            {expanded && (
              <div className="mt-2 rounded-lg bg-surface-50 border border-surface-200 p-3 overflow-x-auto">
                <div className="text-[10px] text-surface-400 mb-1">
                  {t('chat.approvalCard.rawParams')}
                </div>
                <pre className="text-xs font-mono text-surface-700 whitespace-pre-wrap break-all">
                  {formatRawParams(request.rawParams)}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
})
