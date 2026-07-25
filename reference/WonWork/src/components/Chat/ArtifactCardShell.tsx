import { memo, type ReactNode } from 'react'
import { cn } from '@/utils'

interface ArtifactCardShellProps {
  children: ReactNode
  className?: string
}

/**
 * Artifact 卡片共享中性外壳。
 *
 * 与审批卡片最关键的分野：**没有左侧强调条**，外壳颜色也不使用风险色。
 * 卡片个性完全来自内容本身（图表数据、表格数字）。
 */
export const ArtifactCardShell = memo(function ArtifactCardShell({
  children,
  className,
}: ArtifactCardShellProps) {
  return (
    <div
      className={cn(
        'mt-2 rounded-xl border border-surface-200 bg-white shadow-sm overflow-hidden',
        'transition-colors duration-200 motion-reduce:transition-none',
        className
      )}
    >
      <div className="p-4">{children}</div>
    </div>
  )
})
