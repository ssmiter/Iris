import { useEffect, useRef, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
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
    document.addEventListener('mousedown', handleDown)
    return () => document.removeEventListener('mousedown', handleDown)
  }, [open])

  return (
    <div ref={wrapRef} className={cn('relative flex items-center', className)}>
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-xs px-2',
          'font-mono text-caption text-ink-subtle',
          'hover:bg-surface-muted',
          'focus-visible:outline-none focus-visible:shadow-focus',
        )}
        title={current.description}
        aria-label={`运行权限：${current.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" />
        <span>{current.label}</span>
      </button>

      {open && (
        <div
          role="listbox"
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
