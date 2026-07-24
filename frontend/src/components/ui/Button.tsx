import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/cn'

export const buttonVariants = cva(
  [
    'relative inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap',
    'font-semibold select-none',
    'border border-transparent',
    'transition-[color,background-color,border-color,box-shadow,transform]',
    'duration-fast ease-standard',
    'focus-visible:outline-none focus-visible:shadow-focus',
    'active:translate-y-px motion-reduce:transform-none motion-reduce:transition-none',
    'disabled:pointer-events-none disabled:opacity-45',
  ],
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-primary-foreground shadow-hairline hover:bg-primary-hover',
        secondary:
          'border-border bg-surface-raised text-ink shadow-hairline hover:border-border-strong hover:bg-surface-muted',
        ghost: 'text-ink-subtle hover:bg-surface-muted hover:text-ink',
        danger:
          'bg-danger text-danger-contrast shadow-hairline hover:brightness-90',
      },
      size: {
        sm: 'h-8 rounded-xs px-3 text-small',
        md: 'h-10 rounded-sm px-4 text-small',
        lg: 'h-[2.875rem] rounded-sm px-5 text-body',
        icon: 'h-10 w-10 rounded-sm p-0',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  isLoading?: boolean
  loadingLabel?: string
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      children,
      disabled,
      isLoading = false,
      loadingLabel,
      type = 'button',
      variant,
      size,
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      {...props}
    >
      {isLoading && (
        <LoaderCircle
          aria-hidden="true"
          className="h-4 w-4 animate-spin motion-reduce:animate-none"
        />
      )}
      <span>{isLoading && loadingLabel ? loadingLabel : children}</span>
    </button>
  ),
)

Button.displayName = 'Button'
