import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Download, ImageOff, LoaderCircle } from 'lucide-react'
import {
  getArtifactPreview,
  type ArtifactPreviewView,
} from '@/api/irisApi'
import { Modal } from '@/components/ui'
import type { ArtifactNode } from '@/domain/chat/models'

interface ArtifactCardProps {
  node: ArtifactNode
}

export function ArtifactCard({ node }: ArtifactCardProps) {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<ArtifactPreviewView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // 图片类产物挂载即取预览并内联展示（产物区的"一眼可见"）；
  // 其余类型保持克制，点开 Modal 时才取。
  const inlineImage = node.kind === 'image' && Boolean(node.previewRef)

  useEffect(() => {
    if ((!open && !inlineImage) || preview || !node.previewRef) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    getArtifactPreview(node.previewRef, controller.signal)
      .then(setPreview)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            reason instanceof Error ? reason.message : '暂时无法读取预览',
          )
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [node.previewRef, open, preview, inlineImage])

  const inlineSrc =
    inlineImage && preview?.mode === 'image' ? preview.contentRef : null

  return (
    <>
      <div className="group overflow-hidden rounded-md border border-border bg-surface-raised">
        <div className="flex items-center gap-3 px-3.5 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-small font-medium text-ink">{node.title}</p>
            <p className="text-caption text-ink-muted">
              {node.kind}
              {node.byteCount != null
                ? `，${formatByteCount(node.byteCount)}`
                : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {node.previewRef ? (
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-sm px-2 py-1 text-small text-ink-subtle opacity-0 transition-opacity hover:bg-surface-muted hover:text-ink focus-visible:opacity-100 motion-reduce:opacity-100 group-hover:opacity-100"
                onClick={() => setOpen(true)}
              >
                查看
              </button>
            ) : null}
            {node.downloadRef ? (
              <a
                className="inline-flex shrink-0 items-center gap-1.5 rounded-sm px-2 py-1 text-small text-primary opacity-0 transition-opacity hover:bg-primary-soft focus-visible:opacity-100 motion-reduce:opacity-100 group-hover:opacity-100"
                href={node.downloadRef}
                download
              >
                下载
              </a>
            ) : null}
          </div>
        </div>
        {inlineImage && (
          <button
            type="button"
            className="block w-full border-t border-border/60 bg-surface-muted/60 p-2"
            aria-label={`查看 ${node.title} 大图`}
            onClick={() => setOpen(true)}
          >
            {inlineSrc ? (
              <img
                className="mx-auto max-h-56 rounded-xs object-contain"
                src={inlineSrc}
                alt={node.title}
                loading="lazy"
              />
            ) : (
              <span className="flex min-h-24 items-center justify-center gap-2 text-caption text-ink-muted">
                <LoaderCircle
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                />
                {error ?? '正在读取预览…'}
              </span>
            )}
          </button>
        )}
      </div>

      <Modal
        open={open}
        onOpenChange={setOpen}
        title={node.title}
        description={[
          node.kind,
          node.byteCount == null ? null : formatByteCount(node.byteCount),
        ].filter(Boolean).join('，')}
        size="lg"
        footer={node.downloadRef ? (
          <a
            className="inline-flex items-center gap-2 rounded-sm bg-primary px-3 py-2 text-small font-medium text-white transition-colors hover:bg-primary/90"
            href={node.downloadRef}
            download
          >
            <Download aria-hidden="true" className="h-4 w-4" />
            下载完整文件
          </a>
        ) : undefined}
      >
        <ArtifactPreviewBody
          preview={preview}
          loading={loading}
          error={error}
        />
      </Modal>
    </>
  )
}

function ArtifactPreviewBody({
  preview,
  loading,
  error,
}: {
  preview: ArtifactPreviewView | null
  loading: boolean
  error: string | null
}) {
  if (loading) {
    return (
      <div className="flex min-h-56 items-center justify-center gap-2 text-small text-ink-muted">
        <LoaderCircle
          aria-hidden="true"
          className="h-4 w-4 animate-spin motion-reduce:animate-none"
        />
        正在读取成果…
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex min-h-56 items-center justify-center text-small text-danger">
        {error}
      </div>
    )
  }
  if (!preview) return null

  if (preview.mode === 'image' && preview.contentRef) {
    return (
      <div className="flex min-h-56 items-center justify-center rounded-sm bg-surface-muted p-3">
        <img
          className="max-h-[62vh] max-w-full rounded-xs object-contain"
          src={preview.contentRef}
          alt={preview.title}
          loading="lazy"
        />
      </div>
    )
  }
  if (preview.mode === 'text' && preview.content != null) {
    return (
      <div className="space-y-3">
        {preview.format === 'markdown' ? (
          <div className="prose prose-sm max-w-none text-ink prose-a:text-primary prose-pre:border prose-pre:border-border prose-pre:bg-surface-muted">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                img: ({ alt }) => (
                  <span className="inline-flex items-center gap-1 text-small text-ink-muted">
                    <ImageOff aria-hidden="true" className="h-3.5 w-3.5" />
                    外部图片未自动加载{alt ? `：${alt}` : ''}
                  </span>
                ),
                a: ({ href, children }) => (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {preview.content}
            </ReactMarkdown>
          </div>
        ) : (
          <pre className="scrollbar-subtle max-h-[62vh] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-surface-muted p-4 font-mono text-small text-ink">
            {preview.content}
          </pre>
        )}
        {preview.truncated ? (
          <p className="text-caption text-ink-muted">
            {preview.message ?? '预览已截断，请下载查看完整内容。'}
          </p>
        ) : null}
      </div>
    )
  }
  return (
    <div className="flex min-h-56 items-center justify-center px-8 text-center text-small text-ink-subtle">
      {preview.message ?? '该格式暂不支持安全预览，请下载后查看。'}
    </div>
  )
}

function formatByteCount(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}
