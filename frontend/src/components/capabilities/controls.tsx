import { useCallback, useRef } from 'react'
import { ChevronLeft, Loader2, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui'
import { cn } from '@/lib/cn'

/** 能力管理页共享的小控件：开关、空态、编辑器标题栏、多行输入。 */

/**
 * chevron 列之后的正文缩进：chevron 按钮列宽 w-5（20px）+ 行内
 * gap-0.5（2px）= 22px = 1.375rem。用于无图标砖的卡片（MCP 连接卡）
 * 让说明行与名称左缘对齐。
 */
export const INDENT_AFTER_CHEVRON = 'ml-[1.375rem]'

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
        'press-tight relative mt-0.5 h-5 w-9 rounded-full transition-colors duration-fast',
        'focus-visible:outline-none focus-visible:shadow-focus',
        'disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-border-strong',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-4 w-4 rounded-full bg-surface-raised shadow-hairline transition-transform duration-fast',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

/**
 * 安静态（docs/36 §2-M14-A12）：loading 与 empty 两态。
 * loading 用 spinner（加载语义允许周期动效）；empty 用 40px muted
 * 图标砖作锚点 + 主句 + 次句。
 */
export function QuietState({
  loading = false,
  icon: Icon,
  title,
  hint,
}: {
  loading?: boolean
  icon?: LucideIcon
  title: string
  hint?: string
}) {
  return (
    <div
      role={loading ? 'status' : undefined}
      className="grid justify-items-center gap-2 rounded-md bg-surface-muted px-4 py-8 text-center"
    >
      {loading ? (
        <Loader2
          aria-hidden="true"
          className="h-5 w-5 animate-spin text-ink-muted motion-reduce:animate-none"
        />
      ) : Icon ? (
        <span
          aria-hidden="true"
          className="grid h-10 w-10 place-items-center rounded-lg bg-surface-raised text-ink-muted shadow-hairline"
        >
          <Icon className="h-5 w-5" />
        </span>
      ) : null}
      <p className="text-small text-ink-subtle">{title}</p>
      {hint && <p className="text-caption text-ink-muted">{hint}</p>}
    </div>
  )
}

/**
 * 子视图/编辑器标题栏（A1：与 Modal 标题同级 text-heading，不再倒挂；
 * A15：返回统一 ChevronLeft + 「返回能力树」，编辑器可传上下文文案；
 * W7：可选计数小字，与树目录「N 项」同语言）。
 */
export function EditorHeading({
  title,
  count,
  onCancel,
  backLabel = '返回能力树',
}: {
  title: string
  count?: number
  onCancel: () => void
  backLabel?: string
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
      <h3 className="flex min-w-0 items-baseline gap-2 text-heading text-ink">
        <span className="truncate">{title}</span>
        {typeof count === 'number' && (
          <span className="shrink-0 text-caption font-normal text-ink-muted">
            {count} 项
          </span>
        )}
      </h3>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        <ChevronLeft className="h-3.5 w-3.5" />
        {backLabel}
      </Button>
    </div>
  )
}

/**
 * 返回焦点管理（docs/36 §2-M14-B8）：进入子视图/编辑器前用
 * captureFocusKey 记录触发按钮的 data-focus-key，返回后 restoreFocus
 * 把焦点还给同 key 元素。列表重渲染后旧 DOM 引用已失效，故按 key
 * 查询而非保存元素本身。
 */
export function useFocusReturn<R extends HTMLElement>() {
  const rootRef = useRef<R | null>(null)
  const pendingKeyRef = useRef<string | null>(null)
  const captureFocusKey = useCallback((key: string) => {
    pendingKeyRef.current = key
  }, [])
  const restoreFocus = useCallback(() => {
    const key = pendingKeyRef.current
    pendingKeyRef.current = null
    if (!key) return
    requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`)
        ?.focus()
    })
  }, [])
  return { rootRef, captureFocusKey, restoreFocus }
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
