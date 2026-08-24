import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * 通用房间骨架（docs/39 §1）：全屏覆盖房，bg-canvas 不透明、无圆角无遮罩，
 * 房间即应用；下层对话只遮不卸。淡入上限 duration-fast，无滑入转场（docs/37 §1）。
 */
export function RoomShell({
  label,
  visible,
  children,
}: {
  label: string
  visible: boolean
  children: ReactNode
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className={cn(
        'fixed inset-0 z-50 flex flex-col overflow-hidden bg-canvas',
        'transition-opacity duration-fast ease-standard motion-reduce:transition-none',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    >
      {children}
    </div>
  )
}
