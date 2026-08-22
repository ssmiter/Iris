import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import {
  permissionModeOptions,
  type PermissionMode,
} from '@/domain/chat/input'
import { cn } from '@/lib/cn'

interface PermissionModeSelectProps {
  value: PermissionMode
  onChange: (value: PermissionMode) => void
  className?: string
}

export function PermissionModeSelect({
  value,
  onChange,
  className,
}: PermissionModeSelectProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const current =
    permissionModeOptions.find((option) => option.value === value) ??
    permissionModeOptions[1]

  useEffect(() => {
    if (!open) return
    const handleDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    // Esc 关闭并还焦到触发钮；stopPropagation 避免连带关掉外层浮层
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', handleDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  // 方向键在选项间移动焦点（listbox 语义）
  const handleListKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const options = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')
        ?? [],
    )
    if (options.length === 0) return
    const index = options.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === 'ArrowDown'
        ? (index + 1) % options.length
        : (index - 1 + options.length) % options.length
    options[next]?.focus()
  }

  return (
    <div ref={wrapRef} className={cn('relative flex items-center', className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        className={cn(
          'inline-flex h-8 items-center gap-1 rounded-xs px-1.5',
          'font-mono text-caption text-ink-muted',
          'hover:bg-surface-muted hover:text-ink-subtle',
          'focus-visible:outline-none focus-visible:shadow-focus',
        )}
        title={`${current.description}（Shift+Tab 快速切换）`}
        aria-label={`运行权限：${current.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{current.label}</span>
        <ChevronDown aria-hidden="true" className="h-3 w-3 opacity-60" />
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          onKeyDown={handleListKeyDown}
          className={cn(
            'absolute right-0 bottom-full z-50 mb-1.5 min-w-[11rem]',
            'rounded-md border border-border bg-surface-raised p-1',
            'shadow-floating',
            'animate-overlay-in motion-reduce:animate-none',
          )}
        >
          {permissionModeOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-center justify-between gap-3 rounded-sm px-2.5 py-1.5',
                'text-left text-small text-ink',
                'hover:bg-surface-muted',
                option.value === value && 'bg-surface-muted font-medium',
              )}
            >
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    option.value === value
                      ? 'bg-primary'
                      : 'bg-transparent',
                  )}
                  aria-hidden="true"
                />
                {option.label}
              </span>
              <span className="truncate text-caption text-ink-muted">
                {option.description}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
