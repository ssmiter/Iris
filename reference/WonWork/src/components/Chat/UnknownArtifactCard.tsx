import { memo, useMemo } from 'react'
import { Download, FolderOpen, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArtifactCardShell } from './ArtifactCardShell'
import { useWorkspaceFileStore } from '@/stores/workspaceFileStore'
import { resolveDownloadUrl } from '@/utils/fileReader'
import { formatFileSize } from '@/utils/formatFileSize'
import { getFileIconInfo } from '@/utils/fileIcon'
import { cn } from '@/utils'
import type { BaseArtifact } from '@/types/artifact'

interface UnknownArtifactCardProps {
  artifact: BaseArtifact
}

export const UnknownArtifactCard = memo(function UnknownArtifactCard({
  artifact,
}: UnknownArtifactCardProps) {
  const { t } = useTranslation()
  const { selectPath, expandPath, previewFile } = useWorkspaceFileStore()

  const fileName = useMemo(
    () => artifact.fileName || artifact.path.split('/').pop() || artifact.path,
    [artifact.fileName, artifact.path]
  )

  const iconInfo = useMemo(() => getFileIconInfo(fileName), [fileName])

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
      <div className="flex items-start gap-3">
        <div className={cn('flex h-10 w-10 items-center justify-center rounded-lg bg-surface-100', iconInfo.colorClass)}>
          <iconInfo.icon size={20} />
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          {artifact.caption && (
            <p className="text-base font-semibold text-surface-900 leading-snug">{artifact.caption}</p>
          )}
          <p className="text-sm text-surface-700 truncate" title={fileName}>{fileName}</p>
          <div className="text-xs text-surface-500">
            <span className="inline-block mr-3">{iconInfo.label}</span>
            <span className="inline-block mr-3">{artifact.mimeType}</span>
            {artifact.sizeBytes > 0 && <span>{formatFileSize(artifact.sizeBytes)}</span>}
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <a
          href={resolveDownloadUrl(artifact.previewUrl)}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium',
            'bg-surface-100 text-surface-700 hover:bg-surface-200 transition-colors'
          )}
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
