import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'
import { cn } from '@/lib/cn'

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: ReactNode
  description?: ReactNode
  error?: ReactNode
  containerClassName?: string
  /** 可选前导图标（W3：搜索/过滤框语义锚点）；不传时渲染与此前完全一致。 */
  leadingIcon?: ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      id,
      label,
      description,
      error,
      className,
      containerClassName,
      leadingIcon,
      disabled,
      readOnly,
      'aria-describedby': ariaDescribedBy,
      ...props
    },
    ref,
  ) => {
    const generatedId = useId()
    const inputId = id ?? generatedId
    const descriptionId = description ? `${inputId}-description` : undefined
    const errorId = error ? `${inputId}-error` : undefined
    const describedBy = [ariaDescribedBy, descriptionId, errorId]
      .filter(Boolean)
      .join(' ')

    const input = (
      <input
        ref={ref}
        id={inputId}
        disabled={disabled}
        readOnly={readOnly}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={cn(
          'h-10 w-full rounded-sm border border-border bg-surface-raised px-3.5',
          leadingIcon && 'pl-9',
          'text-body text-ink placeholder:text-ink-muted',
          'shadow-hairline outline-none',
          'transition-[border-color,background-color,box-shadow] duration-fast ease-standard',
          'hover:border-border-strong',
          'focus-visible:border-focus focus-visible:shadow-focus',
          'read-only:bg-surface-muted read-only:text-ink-subtle',
          'disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-55',
          'aria-[invalid=true]:border-danger aria-[invalid=true]:focus-visible:shadow-[0_0_0_3px_rgb(var(--color-danger)/0.16)]',
          'motion-reduce:transition-none',
          className,
        )}
        {...props}
      />
    )

    return (
      <div className={cn('grid gap-1.5', containerClassName)}>
        {label && (
          <label htmlFor={inputId} className="text-small font-semibold text-ink">
            {label}
          </label>
        )}
        {leadingIcon ? (
          <div className="relative">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-ink-muted"
            >
              {leadingIcon}
            </span>
            {input}
          </div>
        ) : (
          input
        )}
        {description && (
          <p id={descriptionId} className="text-small text-ink-muted">
            {description}
          </p>
        )}
        {error && (
          <p id={errorId} role="alert" className="text-small font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    )
  },
)

Input.displayName = 'Input'
