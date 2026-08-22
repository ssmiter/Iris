import { CheckCircle2, ChevronDown, ChevronRight, Loader2, XCircle } from 'lucide-react'
import type { RoundView } from '@/domain/chat/models'
import { cn } from '@/lib/cn'

interface ProcessSummaryProps {
  round: RoundView
  expanded: boolean
  pendingCount: number
  /** 触发单次摘要行入场动画（active→settled 跃迁） */
  fadeIn?: boolean
  onToggle: () => void
}

function formatDuration(durationMs: number) {
  if (durationMs < 1000) return `${durationMs}ms`
  return `${(durationMs / 1000).toFixed(durationMs < 10000 ? 1 : 0)}s`
}

/**
 * 过程摘要标题行（WonWork ThinkingProcess 标题栏同款语言）：
 * 图标承载状态语义（活跃旋转、完成打勾、失败叉），文字只说事实，
 * hover 泛出浅底，无描边无卡片——与正文同一平面。
 */
export function ProcessSummary({
  round,
  expanded,
  pendingCount,
  fadeIn = false,
  onToggle,
}: ProcessSummaryProps) {
  const processId = `round-process-${round.roundId}`
  const active = round.phase === 'active'
  const failed = round.phase === 'failed'
  const stopped = round.phase === 'stopped'

  return (
    <button
      type="button"
      className={cn(
        'group -ml-2 flex min-h-9 w-[calc(100%+0.5rem)] items-center gap-2 rounded-md px-2 text-left',
        'text-small transition-colors duration-fast ease-standard',
        'hover:bg-surface-muted/70',
        'focus-visible:outline-none focus-visible:shadow-focus motion-reduce:transition-none',
        fadeIn && 'animate-node-enter motion-reduce:animate-none',
      )}
      aria-expanded={expanded}
      aria-controls={processId}
      onClick={onToggle}
    >
      {expanded ? (
        <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
      ) : (
        <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
      )}
      {active ? (
        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none" />
      ) : failed ? (
        <XCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-danger" />
      ) : (
        <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-success" />
      )}
      <span className={cn(
        'min-w-0 truncate font-medium',
        failed ? 'text-danger' : active ? 'text-ink-subtle' : 'text-ink-muted',
      )}>
        第 {round.index + 1} 轮过程
        {round.stats.toolCallCount > 0 && (
          <>，{round.stats.toolCallCount} 个工具</>
        )}
        {!active && (
          <>，{formatDuration(round.stats.durationMs)}</>
        )}
        {pendingCount > 0 && (
          <span className="text-warning">，{pendingCount} 项待处理</span>
        )}
        {stopped && <span className="text-warning">，已停止</span>}
        {failed && <>，失败</>}
      </span>
    </button>
  )
}
