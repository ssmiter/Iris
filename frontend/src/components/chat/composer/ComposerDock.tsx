import { useRef, useState } from 'react'
import { GitBranch, Paperclip, Send, Square, X } from 'lucide-react'
import type {
  PendingSupplement,
  PermissionMode,
} from '@/domain/chat/input'
import { Button, notify } from '@/components/ui'
import { ComposerTextarea } from './ComposerTextarea'
import { PermissionModeSelect } from './PermissionModeSelect'
import { SupplementQueueTray } from './SupplementQueueTray'

interface ComposerDockProps {
  value: string
  onValueChange: (value: string) => void
  activeTurn: boolean
  stopRequested?: boolean
  permissionMode: PermissionMode
  onPermissionModeChange: (value: PermissionMode) => void
  pendingSupplements: PendingSupplement[]
  onCancelSupplement: (clientRequestId: string) => void
  attachments?: Array<{
    artifactRef: string
    name: string
    byteCount: number
  }>
  onRemoveAttachment?: (artifactRef: string) => void
  onSendTurn: (text: string, attachmentRefs: string[]) => void | Promise<void>
  onSendSupplement: (text: string, attachmentRefs: string[]) => void | Promise<void>
  onStop: () => void | Promise<void>
  onAttachmentRequest: (files: File[]) => void | Promise<void>
  replacementMode?: {
    onCancel: () => void
  }
}

export function ComposerDock({
  value,
  onValueChange,
  activeTurn,
  stopRequested = false,
  permissionMode,
  onPermissionModeChange,
  pendingSupplements,
  onCancelSupplement,
  attachments = [],
  onRemoveAttachment,
  onSendTurn,
  onSendSupplement,
  onStop,
  onAttachmentRequest,
  replacementMode,
}: ComposerDockProps) {
  const [submitting, setSubmitting] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const canSubmit = value.trim().length > 0 && !submitting

  const submit = async () => {
    const text = value.trim()
    if (!text || submitting) return

    setSubmitting(true)
    try {
      const refs = attachments.map((attachment) => attachment.artifactRef)
      if (activeTurn) await onSendSupplement(text, refs)
      else await onSendTurn(text, refs)
      onValueChange('')
    } catch (error) {
      notify.error(
        activeTurn ? '补充消息没有送入' : '消息没有发送',
        {
          description:
            error instanceof Error
              ? error.message
              : '请稍后重试。',
        },
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="composer-dock-scrim shrink-0 px-[var(--page-gutter)] pb-3 pt-4">
      <div className="mx-auto w-full max-w-conversation px-[var(--conversation-pad)]">
        {replacementMode && (
          <div className="mb-2 flex items-center justify-between gap-3 rounded-md border border-primary/25 bg-primary-soft px-3 py-2 text-small text-ink">
            <span className="inline-flex min-w-0 items-center gap-2">
              <GitBranch
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-primary"
              />
              <span className="truncate">
                修改这条提问会保留原对话，并从这里创建新分支
              </span>
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label="取消从这里改问"
              onClick={replacementMode.onCancel}
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </Button>
          </div>
        )}
        <SupplementQueueTray
          items={pendingSupplements}
          onCancel={onCancelSupplement}
        />
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((attachment) => (
              <span
                key={attachment.artifactRef}
                className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-raised px-2 py-1 text-caption text-ink"
              >
                <Paperclip aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                <span className="truncate">{attachment.name}</span>
                <button
                  type="button"
                  className="rounded-sm text-ink-muted hover:text-ink"
                  aria-label={`移除附件 ${attachment.name}`}
                  onClick={() => onRemoveAttachment?.(attachment.artifactRef)}
                >
                  <X aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* 焦点双环：浮起阴影 + 1px primary 色环——输入位被锚定，不靠边框变粗 */}
        <div className="rounded-xl border border-border/70 bg-surface-raised/95 p-2 shadow-hairline backdrop-blur-md transition-[border-color,box-shadow] duration-fast focus-within:border-primary/35 focus-within:shadow-[var(--shadow-raised),0_0_0_1px_rgb(var(--color-primary)/0.3)] motion-reduce:transition-none">
          <div className="flex items-end gap-2 px-2 pt-1">
            <ComposerTextarea
              value={value}
              disabled={submitting}
              placeholder={
                activeTurn
                  ? '补充当前任务，将在下一个安全边界送入…'
                  : replacementMode
                    ? '修改提问并从这里继续…'
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
              aria-label="添加附件"
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip aria-hidden="true" className="h-4 w-4" />
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                event.target.value = ''
                if (files.length > 0) void onAttachmentRequest(files)
              }}
            />
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
                disabled={stopRequested}
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
