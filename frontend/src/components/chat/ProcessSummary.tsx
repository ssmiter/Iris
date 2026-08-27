import { ChevronRight, Loader2, XCircle } from 'lucide-react'
import type { RenderNode, RoundView } from '@/domain/chat/models'
import { cn } from '@/lib/cn'

interface ProcessSummaryProps {
  round: RoundView
  /** 链上节点（已滤 artifact/supplement）：动词短语聚合的数据源 */
  nodes: RenderNode[]
  expanded: boolean
  pendingCount: number
  /** 触发单次摘要行入场动画（active→settled 跃迁） */
  fadeIn?: boolean
  onToggle: () => void
}

function formatDuration(durationMs: number) {
  if (durationMs < 1000) return `${durationMs} 毫秒`
  return `${(durationMs / 1000).toFixed(durationMs < 10000 ? 1 : 0)} 秒`
}

/**
 * 过程摘要标题行（docs/42 §6 P0）：动词短语聚合 + 耗时，文字只说事实。
 * 正常零标记——成功不打勾；活跃靠旋转图标锚定注意力，失败才动用颜色。
 * hover 泛出浅底，无描边无卡片——与正文同一平面。
 */
export function ProcessSummary({
  round,
  nodes,
  expanded,
  pendingCount,
  fadeIn = false,
  onToggle,
}: ProcessSummaryProps) {
  const processId = `round-process-${round.roundId}`
  const active = round.phase === 'active'
  const failed = round.phase === 'failed'
  const stopped = round.phase === 'stopped'

  const thinkingCount = nodes.filter((node) => node.type === 'thinking').length
  const childRunCount = nodes.filter((node) => node.type === 'run').length
  const toolCallCount = round.stats.toolCallCount

  const phrases: string[] = []
  if (thinkingCount > 0) phrases.push('思考')
  if (toolCallCount > 0) phrases.push(`调用 ${toolCallCount} 个工具`)
  if (childRunCount > 0) phrases.push(`派出 ${childRunCount} 个子任务`)

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
      <ChevronRight
        aria-hidden="true"
        className={cn(
          'h-3.5 w-3.5 shrink-0 text-ink-muted',
          'transition-[opacity,transform] duration-deliberate ease-flow',
          expanded
            ? 'rotate-90 opacity-100'
            : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
          'motion-reduce:transition-none',
        )}
      />
      {active ? (
        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none" />
      ) : failed ? (
        <XCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-danger" />
      ) : null}
      <span className={cn(
        'min-w-0 truncate font-medium',
        failed ? 'text-danger' : active ? 'text-ink-subtle' : 'text-ink-muted',
      )}>
        {active ? (
          <>
            第 {round.index + 1} 轮进行中
            {toolCallCount > 0 && <>，已调用 {toolCallCount} 个工具</>}
          </>
        ) : (
          <>
            第 {round.index + 1} 轮
            {phrases.length > 0 && <>：{phrases.join('，')}</>}
            <>，{formatDuration(round.stats.durationMs)}</>
          </>
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
