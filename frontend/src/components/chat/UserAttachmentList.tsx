import { useEffect, useState } from 'react'
import { FileText } from 'lucide-react'
import {
  artifactContentUrl,
  getArtifactMetadata,
  type UploadedArtifact,
} from '@/api/irisApi'

interface UserAttachmentListProps {
  references: string[]
}

const metadataCache = new Map<string, Promise<UploadedArtifact>>()

function metadata(reference: string) {
  const cached = metadataCache.get(reference)
  if (cached) return cached
  const pending = getArtifactMetadata(reference)
  metadataCache.set(reference, pending)
  return pending
}

function byteLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function UserAttachmentList({
  references,
}: UserAttachmentListProps) {
  const [items, setItems] = useState<UploadedArtifact[]>([])

  useEffect(() => {
    let active = true
    Promise.all(references.map(metadata))
      .then((resolved) => {
        if (active) setItems(resolved)
      })
      .catch(() => {
        if (active) setItems([])
      })
    return () => {
      active = false
    }
  }, [references])

  if (references.length === 0) return null

  return (
    <div className="mb-2 flex flex-wrap justify-end gap-1.5">
      {items.length > 0
        ? items.map((item) => (
            <a
              key={item.artifactRef}
              href={artifactContentUrl(item.artifactRef) ?? undefined}
              className="inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-caption text-ink shadow-hairline hover:border-border-strong"
            >
              <FileText aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
              <span className="truncate">{item.name}</span>
              <span className="shrink-0 text-ink-muted">
                {byteLabel(item.byteCount)}
              </span>
            </a>
          ))
        : references.map((reference, index) => (
            <span
              key={reference}
              className="rounded-md border border-border px-2.5 py-1.5 text-caption text-ink-muted"
            >
              附件 {index + 1}
            </span>
          ))}
    </div>
  )
}
