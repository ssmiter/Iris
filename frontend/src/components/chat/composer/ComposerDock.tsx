import { useState } from 'react'
import { Paperclip, Send, Square } from 'lucide-react'
import type {
  PendingSupplement,
  PermissionMode,
} from '@/domain/chat/input'
import { Button } from '@/components/ui'
import { ComposerTextarea } from './ComposerTextarea'
import { PermissionModeSelect } from './PermissionModeSelect'
import { SupplementQueueTray } from './SupplementQueueTray'

interface ComposerDockProps {
  value: string
  onValueChange: (value: string) => void
  activeTurn: boolean
  permissionMode: PermissionMode
  onPermissionModeChange: (value: PermissionMode) => void
  pendingSupplements: PendingSupplement[]
  onCancelSupplement: (clientRequestId: string) => void
  onSendTurn: (text: string) => void | Promise<void>
  onSendSupplement: (text: string) => void | Promise<void>
  onStop: () => void | Promise<void>
  onAttachmentRequest: () => void
}

export function ComposerDock({
  value,
  onValueChange,
  activeTurn,
  permissionMode,
  onPermissionModeChange,
  pendingSupplements,
  onCancelSupplement,
  onSendTurn,
  onSendSupplement,
  onStop,
  onAttachmentRequest,
}: ComposerDockProps) {
  const [submitting, setSubmitting] = useState(false)
  const canSubmit = value.trim().length > 0 && !submitting

  const submit = async () => {
    const text = value.trim()
    if (!text || submitting) return

    setSubmitting(true)
    try {
      if (activeTurn) await onSendSupplement(text)
      else await onSendTurn(text)
      onValueChange('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="shrink-0 border-t border-border bg-canvas/92 px-[var(--page-gutter)] pb-3 pt-2 backdrop-blur-md">
      <div className="mx-auto w-full max-w-conversation">
        <SupplementQueueTray
          items={pendingSupplements}
          onCancel={onCancelSupplement}
        />

        <div className="rounded-xl border border-border bg-surface-raised p-2 shadow-raised focus-within:border-border-strong">
          <div className="flex items-end gap-2 px-2 pt-1">
            <ComposerTextarea
              value={value}
              disabled={submitting}
              placeholder={
                activeTurn
                  ? '补充当前任务，将在下一个安全边界送入…'
                  : '告诉 Iris 你想处理什么…'
              }
              aria-label={activeTurn ? '补充当前任务' : '发送消息给 Iris'}
              onChange={(event) => onValueChange(event.target.value)}
              onSubmit={submit}
            />
          </div>

          <div className="mt-2 flex min-h-9 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label="添加附件（尚未接入）"
              onClick={onAttachmentRequest}
            >
              <Paperclip aria-hidden="true" className="h-4 w-4" />
            </Button>
            <PermissionModeSelect
              value={permissionMode}
              onChange={onPermissionModeChange}
            />

            <span className="hidden min-w-0 flex-1 truncate px-1 text-caption text-ink-muted sm:block">
              {activeTurn
                ? 'Enter 补充 · Shift+Enter 换行'
                : 'Enter 发送 · Shift+Enter 换行'}
            </span>
            <span className="flex-1 sm:hidden" />

            {activeTurn && (
              <Button
                variant="secondary"
                size="icon"
                className="h-9 w-9 rounded-full"
                aria-label="停止当前任务"
                onClick={onStop}
              >
                <Square aria-hidden="true" className="h-3.5 w-3.5 fill-current" />
              </Button>
            )}
            <Button
              size="icon"
              className="h-9 w-9 rounded-full"
              disabled={!canSubmit}
              isLoading={submitting}
              aria-label={activeTurn ? '补充当前任务' : '发送消息'}
              onClick={submit}
            >
              {!submitting && <Send aria-hidden="true" className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        <p className="sr-only" aria-live="polite">
          {activeTurn
            ? '当前任务仍在运行，输入内容会作为补充等待后端确认注入边界。'
            : '当前可以开始一个新任务。'}
        </p>
      </div>
    </div>
  )
}
