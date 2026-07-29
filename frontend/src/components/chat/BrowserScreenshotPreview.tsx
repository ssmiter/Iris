import { useState } from 'react'
import { ExternalLink, ImageOff } from 'lucide-react'
import type { BrowserScreenshotPreview as Preview } from '@/domain/chat/models'
import { cn } from '@/lib/cn'

interface BrowserScreenshotPreviewProps {
  preview: Preview
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function BrowserScreenshotPreview({
  preview,
}: BrowserScreenshotPreviewProps) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>(
    'loading',
  )

  return (
    <figure className="overflow-hidden rounded-sm border border-border bg-surface-muted">
      <div className="relative flex min-h-48 items-center justify-center">
        {state === 'loading' && (
          <span className="absolute text-caption text-ink-muted">
            正在读取视觉证据…
          </span>
        )}
        {state === 'failed' ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-2 text-ink-muted">
            <ImageOff aria-hidden="true" className="h-5 w-5" />
            <span className="text-caption">截图暂时无法读取</span>
          </div>
        ) : (
          <img
            src={preview.url}
            alt="浏览器页面截图"
            loading="lazy"
            decoding="async"
            onLoad={() => setState('ready')}
            onError={() => setState('failed')}
            className={cn(
              'max-h-[32rem] w-full object-contain transition-opacity duration-normal',
              state === 'ready' ? 'opacity-100' : 'opacity-0',
              'motion-reduce:transition-none',
            )}
          />
        )}
      </div>
      <figcaption className="flex items-center gap-2 border-t border-border px-3 py-2 text-caption text-ink-muted">
        <span className="min-w-0 flex-1 truncate">
          页面 {preview.pageId} · {formatBytes(preview.byteCount)}
        </span>
        <a
          href={preview.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1 rounded-xs px-1.5 py-1 text-ink-subtle transition-colors hover:bg-surface-raised hover:text-ink"
        >
          查看原图
          <ExternalLink aria-hidden="true" className="h-3 w-3" />
        </a>
      </figcaption>
    </figure>
  )
}
