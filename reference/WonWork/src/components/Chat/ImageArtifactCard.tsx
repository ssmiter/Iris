import { memo, useMemo } from 'react'
import { Download, FolderOpen, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArtifactCardShell } from './ArtifactCardShell'
import { useWorkspaceFileStore } from '@/stores/workspaceFileStore'
import { resolveDownloadUrl } from '@/utils/fileReader'
import { formatFileSize } from '@/utils/formatFileSize'
import { cn } from '@/utils'
import type { ImageArtifact } from '@/types/artifact'

interface ImageArtifactCardProps {
  artifact: ImageArtifact
}

export const ImageArtifactCard = memo(function ImageArtifactCard({
  artifact,
}: ImageArtifactCardProps) {
  const { t } = useTranslation()
  const { selectPath, expandPath, previewFile } = useWorkspaceFileStore()

  const fileName = useMemo(
    () => artifact.fileName || artifact.path.split('/').pop() || artifact.path,
    [artifact.fileName, artifact.path]
  )

  const metaParts = useMemo(() => {
    const parts: string[] = []
    if (artifact.width && artifact.height) {
      parts.push(`${artifact.width} × ${artifact.height}`)
    }
    if (artifact.sizeBytes > 0) {
      parts.push(formatFileSize(artifact.sizeBytes))
    }
    return parts
  }, [artifact])

  const handleLocate = () => {
    selectPath(artifact.path)
    const parts = artifact.path.split('/').filter(Boolean)
    let acc = ''
    for (const part of parts.slice(0, -1)) {
      acc += '/' + part
      expandPath(acc)
    }
    previewFile(artifact.path)
  }

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(artifact.path)
      toast.success(t('chat.artifactCard.copied'))
    } catch {
      toast.error(t('chat.artifactCard.copyFailed'))
    }
  }

  return (
    <ArtifactCardShell>
      <img
        src={resolveDownloadUrl(artifact.previewUrl)}
        alt={artifact.caption || fileName}
        className="max-h-64 w-full rounded-lg border border-surface-200 object-contain bg-surface-50"
        loading="lazy"
      />

      {(artifact.caption || metaParts.length > 0) && (
        <div className="mt-3 space-y-1">
          {artifact.caption && (
            <p className="text-base font-semibold text-surface-900 leading-snug">{artifact.caption}</p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-surface-500">
            <span className="truncate max-w-[240px]" title={fileName}>{fileName}</span>
            {metaParts.map((part, i) => (
              <span key={i}>{part}</span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <a
          href={resolveDownloadUrl(artifact.previewUrl)}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium',
            'bg-surface-100 text-surface-700 hover:bg-surface-200 transition-colors'
          )}
          title={t('chat.artifactCard.download')}
        >
          <Download size={14} />
          {t('chat.artifactCard.download')}
        </a>
        <button
          type="button"
          onClick={handleCopyPath}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium',
            'bg-surface-100 text-surface-700 hover:bg-surface-200 transition-colors'
          )}
        >
          <Copy size={14} />
          {t('chat.artifactCard.copyPath')}
        </button>
        <button
          type="button"
          onClick={handleLocate}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium',
            'bg-primary-50 text-primary-700 hover:bg-primary-100 transition-colors'
          )}
        >
          <FolderOpen size={14} />
          {t('chat.artifactCard.locateInWorkspace')}
        </button>
      </div>
    </ArtifactCardShell>
  )
})
