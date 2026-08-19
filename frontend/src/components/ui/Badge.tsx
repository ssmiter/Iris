import { type HTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/cn'

const badgeVariants = cva(
  'inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-caption',
  {
    variants: {
      tone: {
        neutral: '',
        info: '',
        success: '',
        warning: '',
        danger: '',
        violet: '',
        teal: '',
      },
      appearance: {
        soft: '',
        outline: 'bg-transparent',
      },
    },
    compoundVariants: [
      {
        tone: 'neutral',
        appearance: 'soft',
        className: 'border-transparent bg-surface-muted text-ink-subtle',
      },
      {
        tone: 'neutral',
        appearance: 'outline',
        className: 'border-border text-ink-subtle',
      },
      {
        tone: 'info',
        appearance: 'soft',
        className: 'border-transparent bg-info-soft text-info-foreground',
      },
      {
        tone: 'info',
        appearance: 'outline',
        className: 'border-info/40 text-info',
      },
      {
        tone: 'success',
        appearance: 'soft',
        className: 'border-transparent bg-success-soft text-success-foreground',
      },
      {
        tone: 'success',
        appearance: 'outline',
        className: 'border-success/40 text-success',
      },
      {
        tone: 'warning',
        appearance: 'soft',
        className: 'border-transparent bg-warning-soft text-warning-foreground',
      },
      {
        tone: 'warning',
        appearance: 'outline',
        className: 'border-warning/40 text-warning',
      },
      {
        tone: 'danger',
        appearance: 'soft',
        className: 'border-transparent bg-danger-soft text-danger-foreground',
      },
      {
        tone: 'danger',
        appearance: 'outline',
        className: 'border-danger/40 text-danger',
      },
      {
        tone: 'violet',
        appearance: 'soft',
        className: 'border-transparent bg-violet-soft text-violet-foreground',
      },
      {
        tone: 'violet',
        appearance: 'outline',
        className: 'border-violet/40 text-violet',
      },
      {
        tone: 'teal',
        appearance: 'soft',
        className: 'border-transparent bg-teal-soft text-teal-foreground',
      },
      {
        tone: 'teal',
        appearance: 'outline',
        className: 'border-teal/40 text-teal',
      },
    ],
    defaultVariants: {
      tone: 'neutral',
      appearance: 'soft',
    },
  },
)

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  showDot?: boolean
}

const dotTone: Record<NonNullable<BadgeProps['tone']>, string> = {
  neutral: 'bg-ink-muted',
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  violet: 'bg-violet',
  teal: 'bg-teal',
}

export function Badge({
  className,
  children,
  tone = 'neutral',
  appearance,
  showDot = false,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(badgeVariants({ tone, appearance }), className)}
      {...props}
    >
      {showDot && (
        <span
          aria-hidden="true"
          className={cn('h-1.5 w-1.5 rounded-full', dotTone[tone ?? 'neutral'])}
        />
      )}
      {children}
    </span>
  )
}
