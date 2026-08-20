import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Button } from './Button'
import { Tooltip } from './Tooltip'

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl'

export interface ModalProps {
  trigger?: ReactNode
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: ModalSize
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /**
   * body 是否由 Modal 自己滚动（默认 true）。置 false 时 body 不滚动，
   * 由子内容自行分列滚动（如能力中心的两列各滚，docs/36 §2-M14-B3）。
   */
  bodyScroll?: boolean
}

const sizeClass: Record<ModalSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
}

export function Modal({
  trigger,
  title,
  description,
  children,
  footer,
  size = 'md',
  open,
  defaultOpen,
  onOpenChange,
  bodyScroll = true,
}: ModalProps) {
  return (
    <Dialog.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
    >
      {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-ink/30 backdrop-blur-[2px]',
            'data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out',
            'motion-reduce:animate-none',
          )}
        />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
            'flex max-h-[min(84vh,760px)] w-[calc(100%-2rem)] flex-col',
            sizeClass[size],
            'overflow-hidden rounded-lg border border-border bg-surface-raised shadow-floating',
            'focus:outline-none',
            'data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out',
            'motion-reduce:animate-none',
          )}
        >
          <header className="flex items-start justify-between gap-5 border-b border-border/70 px-5 py-4 sm:px-6">
            <div className="grid gap-1">
              <Dialog.Title className="text-heading text-ink">
                {title}
              </Dialog.Title>
              {description && (
                <Dialog.Description className="text-small text-ink-subtle">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Tooltip content="关闭" placement="bottom">
              <Dialog.Close asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="-mr-2 -mt-1 h-9 w-9"
                  aria-label="关闭对话框"
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                </Button>
              </Dialog.Close>
            </Tooltip>
          </header>
          <div
            className={cn(
              'min-h-0 flex-1 px-5 py-5 sm:px-6',
              bodyScroll
                ? 'scrollbar-subtle overflow-y-auto'
                : 'flex flex-col overflow-hidden',
            )}
          >
            {children}
          </div>
          {footer && (
            <footer className="flex flex-wrap justify-end gap-2 border-t border-border/70 bg-surface px-5 py-4 sm:px-6">
              {footer}
            </footer>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export const ModalClose = Dialog.Close
