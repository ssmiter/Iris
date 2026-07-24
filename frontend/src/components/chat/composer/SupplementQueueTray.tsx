import { Clock3, X } from 'lucide-react'
import type { PendingSupplement } from '@/domain/chat/input'

interface SupplementQueueTrayProps {
  items: PendingSupplement[]
  onCancel: (clientRequestId: string) => void
}

export function SupplementQueueTray({
  items,
  onCancel,
}: SupplementQueueTrayProps) {
  if (items.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2 px-2 pb-2" aria-label="待送入的补充">
      {items.map((item) => (
        <div
          key={item.clientRequestId}
          className="inline-flex max-w-full items-center gap-2 rounded-full border border-primary/20 bg-primary-soft px-3 py-1.5 text-small text-primary"
        >
          <Clock3 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span className="shrink-0 text-caption">
            {item.state === 'submitting' ? '正在提交' : '待送入'}
          </span>
          <span className="truncate text-ink-subtle">{item.text}</span>
          <button
            type="button"
            className="grid h-5 w-5 shrink-0 place-items-center rounded-full hover:bg-primary/10 focus-visible:outline-none focus-visible:shadow-focus"
            aria-label={`撤回补充：${item.text}`}
            onClick={() => onCancel(item.clientRequestId)}
          >
            <X aria-hidden="true" className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
