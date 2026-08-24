import type { ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui'

/**
 * 房间顶栏（docs/39 §1）：52px，← 返回 + 房间名 / 居中搜索 / 右侧动作。
 * 三列 grid 保证搜索在房间几何中心，与左右内容宽度无关。
 */
export function RoomTopBar({
  title,
  onBack,
  backLabel = '返回',
  search,
  actions,
}: {
  title: string
  onBack: () => void
  backLabel?: string
  search?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="grid h-[52px] shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-border/70 bg-canvas px-4">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="press h-9 rounded-md px-2.5"
          onClick={onBack}
        >
          <ChevronLeft className="h-4 w-4" />
          {backLabel}
        </Button>
        <h2 className="truncate text-heading font-semibold text-ink">{title}</h2>
      </div>
      <div className="w-[min(420px,36vw)]">{search}</div>
      <div className="flex min-w-0 items-center justify-end gap-1.5">{actions}</div>
    </header>
  )
}
