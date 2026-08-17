import type { ReactNode } from 'react'
import { Button } from '@/components/ui'
import { cn } from '@/lib/cn'

/** 能力管理页共享的小控件：开关、空态、编辑器标题栏、多行输入。 */

export function EnableSwitch({
  checked,
  disabled,
  label,
  onClick,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'relative mt-0.5 h-5 w-9 rounded-full transition-colors duration-fast disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-border-strong',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-hairline transition-transform duration-fast',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

export function QuietState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md bg-surface-muted px-4 py-8 text-center text-small text-ink-muted">
      {children}
    </div>
  )
}

export function EditorHeading({
  title,
  onCancel,
  backLabel = '返回列表',
}: {
  title: string
  onCancel: () => void
  backLabel?: string
}) {
  return (
    <div className="flex items-center justify-between border-b border-border pb-3">
      <h3 className="text-title font-semibold text-ink">{title}</h3>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        {backLabel}
      </Button>
    </div>
  )
}

export function TextArea({
  label,
  value,
  onChange,
  rows,
  description,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  rows: number
  description?: string
}) {
  return (
    <label className="grid gap-1.5 text-small font-semibold text-ink">
      {label}
      <textarea
        required
        value={value}
        rows={rows}
        onChange={(event) => onChange(event.target.value)}
        className="w-full resize-y rounded-sm border border-border bg-surface-raised px-3.5 py-2.5 text-body font-normal leading-relaxed text-ink shadow-hairline outline-none transition-[border-color,box-shadow] hover:border-border-strong focus:border-focus focus:shadow-focus"
      />
      {description && (
        <span className="font-normal text-ink-muted">{description}</span>
      )}
    </label>
  )
}
