import { ChevronRight } from 'lucide-react'
import type { RoundView } from '@/domain/chat/models'
import { cn } from '@/lib/cn'

interface ProcessSummaryProps {
  round: RoundView
  expanded: boolean
  pendingCount: number
  /** 回合刚收尾时泛一次薄光（settling 相位信号，一次性，不循环） */
  settleGlow?: boolean
  onToggle: () => void
}

function formatDuration(durationMs: number) {
  if (durationMs < 1000) return `${durationMs}ms`
  return `${(durationMs / 1000).toFixed(durationMs < 10000 ? 1 : 0)}s`
}

export function ProcessSummary({
  round,
  expanded,
  pendingCount,
  settleGlow,
  onToggle,
}: ProcessSummaryProps) {
  const processId = `round-process-${round.roundId}`

  return (
    <button
      type="button"
      className={cn(
        'group -ml-2 flex min-h-8 w-[calc(100%+0.5rem)] items-center gap-1.5 rounded-sm px-2 text-left text-small',
        'text-ink-muted transition-[color,background-color,transform,opacity] duration-fast ease-standard',
        'hover:bg-surface-muted hover:text-ink-subtle active:scale-[0.995] active:bg-surface-muted active:opacity-80',
        'focus-visible:outline-none focus-visible:shadow-focus motion-reduce:transition-none',
        settleGlow && 'animate-settle-glow motion-reduce:animate-none',
      )}
      aria-expanded={expanded}
      aria-controls={processId}
      onClick={onToggle}
    >
      <ChevronRight
        aria-hidden="true"
        className={cn(
          'h-3.5 w-3.5 shrink-0 transition-transform duration-deliberate ease-flow',
          expanded && 'rotate-90',
          'motion-reduce:transition-none',
        )}
      />
      <span>第 {round.index + 1} 轮过程</span>
      {round.stats.toolCallCount > 0 && (
        <span>· {round.stats.toolCallCount} 个工具</span>
      )}
      <span>· {formatDuration(round.stats.durationMs)}</span>
      {pendingCount > 0 && (
        <span className="ml-1 text-warning">· {pendingCount} 项待处理</span>
      )}
      {round.phase === 'failed' && (
        <span className="ml-1 text-danger">· 失败</span>
      )}
      {round.phase === 'stopped' && (
        <span className="ml-1 text-warning">· 已停止</span>
      )}
    </button>
  )
}
