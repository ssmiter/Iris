import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
} from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/cn'

const cardVariants = cva('rounded-md text-ink', {
  variants: {
    variant: {
      plain: 'bg-transparent',
      // 一整块画布收敛：默认描边降权（/75）并去掉 hairline 投影，
      // 卡片靠留白与底色分层，不靠边线划格。
      outlined: 'border border-border/75 bg-surface',
      raised: 'border border-border/60 bg-surface-raised shadow-raised',
    },
    padding: {
      none: '',
      sm: 'p-3',
      md: 'p-4',
      lg: 'p-5 sm:p-6',
    },
  },
  defaultVariants: {
    variant: 'outlined',
    padding: 'md',
  },
})

export interface CardProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant, padding, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(cardVariants({ variant, padding }), className)}
      {...props}
    />
  ),
)

Card.displayName = 'Card'

export const CardAction = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, type = 'button', ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(
      cardVariants({ variant: 'outlined', padding: 'md' }),
      'w-full text-left',
      'transition-[background-color,border-color,box-shadow,transform] duration-fast ease-standard',
      'hover:border-border-strong hover:bg-surface-raised hover:shadow-raised',
      'focus-visible:outline-none focus-visible:shadow-focus',
      'active:translate-y-px motion-reduce:transform-none motion-reduce:transition-none',
      'disabled:pointer-events-none disabled:opacity-45',
      className,
    )}
    {...props}
  />
))

CardAction.displayName = 'CardAction'

export const CardHeader = ({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('grid gap-1.5', className)} {...props} />
)

export const CardTitle = ({
  className,
  ...props
}: HTMLAttributes<HTMLHeadingElement>) => (
  <h3 className={cn('text-heading text-ink', className)} {...props} />
)

export const CardDescription = ({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn('text-small text-ink-subtle', className)} {...props} />
)

export const CardContent = ({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('mt-4', className)} {...props} />
)

export const CardFooter = ({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('mt-5 flex items-center gap-2', className)} {...props} />
)
