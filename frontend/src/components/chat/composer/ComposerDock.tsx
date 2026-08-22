import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  ArrowUp,
  GitBranch,
  Paperclip,
  Square,
  Upload,
  X,
} from 'lucide-react'
import type {
  PendingSupplement,
  PermissionMode,
} from '@/domain/chat/input'
import { permissionModeOptions } from '@/domain/chat/input'
import { Button, notify } from '@/components/ui'
import { Tooltip } from '@/components/ui/Tooltip'
import { cn } from '@/lib/cn'
import { ComposerTextarea } from './ComposerTextarea'
import { PermissionModeSelect } from './PermissionModeSelect'
import { SupplementQueueTray } from './SupplementQueueTray'
import { ConversationWidthToggle } from './ConversationWidthToggle'

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
  quotes?: Array<{ id: string; text: string }>
  onRemoveQuote?: (id: string) => void
  onClearQuotes?: () => void
  onSendTurn: (text: string, attachmentRefs: string[]) => void | Promise<void>
  onSendSupplement: (text: string, attachmentRefs: string[]) => void | Promise<void>
  onStop: () => void | Promise<void>
  onAttachmentRequest: (files: File[]) => void | Promise<void>
  replacementMode?: {
    onCancel: () => void
  }
  contextUsage?: {
    used: number
    limit: number
    percent: number
  } | null
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
  quotes = [],
  onRemoveQuote,
  onClearQuotes,
  onSendTurn,
  onSendSupplement,
  onStop,
  onAttachmentRequest,
  replacementMode,
  contextUsage,
}: ComposerDockProps) {
  const [submitting, setSubmitting] = useState(false)
  const [supplementReady, setSupplementReady] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const dropCounter = useRef(0)
  const canSubmit = (value.trim().length > 0 || quotes.length > 0) && !submitting

  // 运行满 5s 才把 placeholder 切到「可补充」态，避免发送瞬间文案跳变
  useEffect(() => {
    if (!activeTurn) {
      setSupplementReady(false)
      return
    }
    const timer = window.setTimeout(() => setSupplementReady(true), 5000)
    return () => window.clearTimeout(timer)
  }, [activeTurn])

  const submit = async () => {
    const text = value.trim()
    if ((!text && quotes.length === 0) || submitting) return

    const quoteBlock = quotes.length
      ? quotes
          .map((quote) =>
            quote.text
              .split('\n')
              .map((line) => `> ${line}`)
              .join('\n'),
          )
          .join('\n\n') + (text ? '\n\n' : '')
      : ''
    const messageText = quoteBlock + text

    setSubmitting(true)
    try {
      const refs = attachments.map((attachment) => attachment.artifactRef)
      if (activeTurn) await onSendSupplement(messageText, refs)
      else await onSendTurn(messageText, refs)
      onValueChange('')
      onClearQuotes?.()
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

  const cyclePermissionMode = useCallback(() => {
    const values = permissionModeOptions.map((option) => option.value)
    const nextIndex =
      (values.indexOf(permissionMode) + 1) % values.length
    onPermissionModeChange(values[nextIndex])
  }, [permissionMode, onPermissionModeChange])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Tab' && event.shiftKey) {
        event.preventDefault()
        cyclePermissionMode()
      }
    },
    [cyclePermissionMode],
  )

  const handleDragEnter = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    dropCounter.current++
    if (event.dataTransfer.types.includes('Files')) {
      setIsDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    dropCounter.current--
    if (dropCounter.current <= 0) {
      dropCounter.current = 0
      setIsDragOver(false)
    }
  }, [])

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
  }, [])

  const handleDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault()
      dropCounter.current = 0
      setIsDragOver(false)
      const files = Array.from(event.dataTransfer.files)
      if (files.length > 0) {
        await onAttachmentRequest(files)
      }
    },
    [onAttachmentRequest],
  )

  const placeholder = (() => {
    if (activeTurn && supplementReady) {
      return '可补充当前任务，将在下一个安全边界送入…'
    }
    if (activeTurn) {
      return '告诉 Iris 你想处理什么…'
    }
    if (replacementMode) {
      return '修改提问并从这里继续…'
    }
    return '告诉 Iris 你想处理什么…'
  })()

  // 有 token 统计时至少显示 1%；>90% 危险红档，>70% 警告黄档（docs/36 M15 P1-7）
  const ctxPercent = contextUsage ? Math.max(1, contextUsage.percent) : 0
  const ctxDanger = ctxPercent > 90
  const ctxWarn = !ctxDanger && ctxPercent > 70

  return (
    <div
      className="composer-dock-scrim shrink-0 px-[var(--page-gutter)] pb-3 pt-4"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="mx-auto w-full max-w-conversation px-[var(--conversation-pad)]">
        {(replacementMode || pendingSupplements.length > 0) && (
          <div className="mb-2 grid gap-2">
            {replacementMode && (
              <div className="flex items-center justify-between gap-3 rounded-md border border-primary/25 bg-primary-soft px-3 py-2 text-small text-ink">
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
          </div>
        )}

        {/*
          单胶囊形态（第二波收敛）：靠 shadow-floating 托起而非边框——
          焦点只叠加 1px primary 色环，不切换阴影层级。textarea 无边框
          融入胶囊；attach / 权限 / 宽度 / 水位 / 发送全部收进同一行。
        */}
        <div className="relative rounded-xl border border-border/60 bg-surface-raised shadow-floating transition-[border-color,box-shadow] duration-fast focus-within:border-primary/35 focus-within:shadow-[var(--shadow-floating),0_0_0_1px_rgb(var(--color-primary)/0.3)] motion-reduce:transition-none"
        >
          {isDragOver && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/50 bg-surface/80 text-small text-ink-subtle">
              <Upload aria-hidden="true" className="h-6 w-6" />
              拖放文件到此处添加附件
            </div>
          )}

          {(quotes.length > 0 || attachments.length > 0) && (
            <div className="flex flex-wrap gap-1.5 px-2 pt-2">
              {quotes.map((quote) => (
                <span
                  key={quote.id}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-primary/25 bg-primary-soft px-2 py-1 text-caption text-ink"
                >
                  <span className="truncate">{quote.text}</span>
                  <button
                    type="button"
                    className="rounded-sm text-ink-muted hover:text-ink"
                    aria-label="移除引用"
                    onClick={() => onRemoveQuote?.(quote.id)}
                  >
                    <X aria-hidden="true" className="h-3.5 w-3.5" />
                  </button>
                </span>
              ))}
              {attachments.map((attachment) => (
                <span
                  key={attachment.artifactRef}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-muted px-2 py-1 text-caption text-ink"
                >
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

          <div className="flex items-end gap-1 p-1.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full"
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
            <ComposerTextarea
              value={value}
              disabled={submitting}
              placeholder={placeholder}
              aria-label={activeTurn ? '补充当前任务' : '发送消息给 Iris'}
              className="py-1"
              onChange={(event) => onValueChange(event.target.value)}
              onSubmit={submit}
              onKeyDown={handleKeyDown}
            />

            {/* 运行中提示：借胶囊内同一行的空余，空闲态不渲染、不占视觉 */}
            {activeTurn && (
              <span className="hidden min-w-0 shrink truncate px-1 py-2 text-caption text-ink-muted sm:block">
                {supplementReady
                  ? 'Enter 发送补充，Shift+Enter 换行'
                  : '任务已开始…'}
              </span>
            )}

            <PermissionModeSelect
              value={permissionMode}
              onChange={onPermissionModeChange}
            />
            <ConversationWidthToggle />

            {/* 上下文水位：常态细环托在发送钮旁；>70% 展开为琥珀细条 + 百分比，
                >90% 红档——判定沿用 docs/36 M15 P1-7，只改呈现 */}
            {contextUsage && (
              <Tooltip
                content={`上下文用量 ${contextUsage.used.toLocaleString()} / ${contextUsage.limit.toLocaleString()} tokens`}
              >
              <span
                className="flex items-center gap-1.5 px-0.5 py-2 font-mono text-caption text-ink-muted"
              >
                {ctxWarn || ctxDanger ? (
                  <>
                    <span
                      className={cn(
                        'tabular-nums',
                        ctxDanger ? 'text-danger' : 'text-warning',
                      )}
                    >
                      {ctxPercent}%
                    </span>
                    <span
                      className={cn(
                        'inline-block h-1 w-9 rounded-full',
                        ctxDanger ? 'bg-danger/25' : 'bg-warning/25',
                      )}
                      aria-hidden="true"
                    >
                      <span
                        className={cn(
                          'block h-full rounded-full',
                          ctxDanger ? 'bg-danger' : 'bg-warning',
                        )}
                        style={{ width: `${Math.min(ctxPercent, 100)}%` }}
                      />
                    </span>
                  </>
                ) : (
                  <svg
                    viewBox="0 0 16 16"
                    className="h-3.5 w-3.5 -rotate-90"
                    aria-hidden="true"
                  >
                    <circle
                      cx="8"
                      cy="8"
                      r="6"
                      fill="none"
                      strokeWidth="2.5"
                      className="stroke-surface-muted"
                    />
                    <circle
                      cx="8"
                      cy="8"
                      r="6"
                      fill="none"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      className="stroke-success"
                      strokeDasharray={`${(Math.min(ctxPercent, 100) / 100) * 37.7} 37.7`}
                    />
                  </svg>
                )}
              </span>
              </Tooltip>
            )}

            {activeTurn && (
              <Button
                variant="primary"
                size="icon"
                className="h-8 w-8 rounded-full bg-ink text-canvas hover:bg-ink/85"
                aria-label="停止当前任务"
                disabled={stopRequested}
                onClick={onStop}
              >
                <Square aria-hidden="true" className="h-3 w-3 fill-current" />
              </Button>
            )}
            <Button
              size="icon"
              className="h-8 w-8 rounded-full"
              disabled={!canSubmit}
              isLoading={submitting}
              aria-label={activeTurn ? '补充当前任务' : '发送消息'}
              onClick={submit}
            >
              {!submitting && (
                <ArrowUp aria-hidden="true" className="h-4 w-4" />
              )}
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
