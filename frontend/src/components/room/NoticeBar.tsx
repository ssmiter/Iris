import type { ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * 「需要注意」聚合条（docs/39 §1/§2）：warning-soft 底、左 3px warning 边，
 * 出现在目录头下方，点击下钻（展开清单或直达详情）。正常即安静——没有问题时不渲染。
 */
export function NoticeBar({
  children,
  onClick,
  action,
  className,
}: {
  children: ReactNode
  onClick?: () => void
  /** 右侧引导（如「去看看」）。 */
  action?: ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'press-row flex w-full items-center gap-2.5 rounded-md border border-warning/30 border-l-[3px] border-l-warning',
        'bg-warning-soft px-3.5 py-2.5 text-left transition-colors duration-fast',
        'focus-visible:outline-none focus-visible:shadow-focus',
        className,
      )}
    >
      <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-warning" />
      <span className="min-w-0 flex-1 text-small text-ink-subtle">{children}</span>
      {action && (
        <span className="shrink-0 text-caption font-medium text-warning">
          {action}
        </span>
      )}
    </button>
  )
}
