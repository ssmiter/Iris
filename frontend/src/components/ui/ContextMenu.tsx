import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface ContextMenuItem {
  key: string
  label: ReactNode
  icon?: LucideIcon
  danger?: boolean
  disabled?: boolean
  onSelect?: () => void
}

export type ContextMenuSlot =
  | ContextMenuItem
  | { type: 'separator'; key: string }

export interface ContextMenuProps {
  open: boolean
  x: number
  y: number
  items: ContextMenuSlot[]
  onClose: () => void
}

const VIEWPORT_PAD = 8

/**
 * 自绘右键菜单（docs/37 §2.2）。
 *
 * 设计语言对齐 Tooltip 暗色胶囊：近墨色底、反转文字、紧凑项高；
 * fixed 定位在触发点，视口边缘自动压入；键盘 ↑↓ 循环焦点、Enter 选中、
 * Esc / 点外关闭；opacity + scale 淡入（duration-fast），无位移动画。
 */
export function ContextMenu({ open, x, y, items, onClose }: ContextMenuProps) {
  const id = useId()
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(
    null,
  )
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!open) {
      setVisible(false)
      setPosition(null)
      return
    }
    const tick = requestAnimationFrame(() => {
      const menu = menuRef.current
      if (!menu) return
      const rect = menu.getBoundingClientRect()
      const left = Math.min(
        Math.max(x + 2, VIEWPORT_PAD),
        Math.max(VIEWPORT_PAD, window.innerWidth - rect.width - VIEWPORT_PAD),
      )
      const top = Math.min(
        Math.max(y + 2, VIEWPORT_PAD),
        Math.max(VIEWPORT_PAD, window.innerHeight - rect.height - VIEWPORT_PAD),
      )
      setPosition({ left, top })
      requestAnimationFrame(() => setVisible(true))
    })
    return () => cancelAnimationFrame(tick)
  }, [open, x, y])

  useEffect(() => {
    if (!open || !position) return
    const menu = menuRef.current
    if (!menu) return
    const first = menu.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not([aria-disabled="true"])',
    )
    first?.focus()
  }, [open, position])

  useEffect(() => {
    if (!open) return
    const handleDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', handleDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open, onClose])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const menu = menuRef.current
    if (!menu) return
    const options = Array.from(
      menu.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not([aria-disabled="true"])',
      ),
    )
    const index = options.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      options[(index + 1) % options.length]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      options[(index - 1 + options.length) % options.length]?.focus()
    } else if (event.key === 'Enter' && index >= 0) {
      event.preventDefault()
      options[index]?.click()
    }
  }

  if (!open) return null

  return createPortal(
    <div
      ref={menuRef}
      id={id}
      role="menu"
      aria-orientation="vertical"
      onKeyDown={handleKeyDown}
      style={position ?? { left: -9999, top: -9999 }}
      className={cn(
        'fixed z-[70] min-w-[11rem] origin-top-left overflow-hidden',
        'rounded-md border border-tooltip-foreground/10 bg-tooltip p-1',
        'text-small text-tooltip-foreground shadow-raised',
        'transition-[opacity,transform] duration-fast ease-standard motion-reduce:transition-none',
        visible ? 'scale-100 opacity-100' : 'scale-[0.97] opacity-0',
      )}
    >
      {items.map((slot) => {
        if ('type' in slot && slot.type === 'separator') {
          return (
            <div
              key={slot.key}
              role="separator"
              className="my-1.5 h-px bg-tooltip-foreground/10"
            />
          )
        }
        // interface 可被声明合并，'type' in 守卫无法窄化联合，此处显式断言
        const item = slot as ContextMenuItem
        const Icon = item.icon
        return (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            aria-disabled={item.disabled || undefined}
            tabIndex={-1}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return
              item.onSelect?.()
              onClose()
            }}
            className={cn(
              'press flex min-h-[2rem] w-full items-center rounded-sm px-3 py-2 text-left',
              'transition-colors duration-fast motion-reduce:transition-none',
              'focus-visible:outline-none',
              item.disabled && 'pointer-events-none opacity-45',
              item.danger && !item.disabled
                ? 'text-danger hover:bg-danger/10 focus-visible:bg-danger/10'
                : !item.disabled &&
                    'text-tooltip-foreground hover:bg-tooltip-foreground/10 focus-visible:bg-tooltip-foreground/10',
            )}
          >
            {Icon ? (
              <Icon className="mr-2 h-4 w-4 shrink-0 opacity-80" />
            ) : (
              <span className="mr-2 w-5 shrink-0" aria-hidden="true" />
            )}
            <span className="truncate">{item.label}</span>
          </button>
        )
      })}
    </div>,
    document.body,
  )
}
