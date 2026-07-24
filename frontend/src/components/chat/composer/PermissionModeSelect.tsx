import type { SelectHTMLAttributes } from 'react'
import { ShieldCheck } from 'lucide-react'
import {
  permissionModeOptions,
  type PermissionMode,
} from '@/domain/chat/input'
import { cn } from '@/lib/cn'

interface PermissionModeSelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'> {
  value: PermissionMode
  onChange: (value: PermissionMode) => void
}

export function PermissionModeSelect({
  value,
  onChange,
  className,
  ...props
}: PermissionModeSelectProps) {
  const current =
    permissionModeOptions.find((option) => option.value === value) ??
    permissionModeOptions[1]

  return (
    <label
      className={cn(
        'relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-xs px-2',
        'text-caption text-ink-subtle hover:bg-surface-muted',
        'focus-within:shadow-focus',
        className,
      )}
      title={current.description}
    >
      <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" />
      <span aria-hidden="true">{current.label}</span>
      <select
        value={value}
        className="absolute inset-0 cursor-pointer opacity-0"
        aria-label="运行权限偏好"
        onChange={(event) => onChange(event.target.value as PermissionMode)}
        {...props}
      >
        {permissionModeOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}：{option.description}
          </option>
        ))}
      </select>
    </label>
  )
}
