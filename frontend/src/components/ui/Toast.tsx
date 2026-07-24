import { Toaster, toast } from 'sonner'

export function ToastHost() {
  return (
    <Toaster
      position="top-right"
      closeButton
      visibleToasts={3}
      duration={4000}
      gap={8}
      offset={16}
      toastOptions={{
        classNames: {
          toast:
            '!rounded-sm !border-border !bg-surface-raised !font-sans !text-ink !shadow-raised',
          title: '!text-small !font-semibold !text-ink',
          description: '!text-small !text-ink-subtle',
          closeButton:
            '!border-border !bg-surface-raised !text-ink-subtle hover:!bg-surface-muted',
          actionButton:
            '!rounded-xs !bg-primary !font-semibold !text-primary-foreground',
          cancelButton:
            '!rounded-xs !bg-surface-muted !font-semibold !text-ink-subtle',
        },
      }}
    />
  )
}

export { toast as notify }
