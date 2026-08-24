import type { ReactNode } from 'react'

/**
 * 房间左导航列（docs/39 §1）：236px，surface-muted 底，右 hairline。
 * footer 槽位留给房间级入口（如设置房的分栏菜单底部动作）。
 */
export function RoomSide({
  children,
  footer,
}: {
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <aside className="flex min-h-0 w-[236px] shrink-0 flex-col border-r border-border/60 bg-surface-muted">
      <nav className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {children}
      </nav>
      {footer && (
        <div className="shrink-0 border-t border-border/60 px-2 py-2">{footer}</div>
      )}
    </aside>
  )
}
