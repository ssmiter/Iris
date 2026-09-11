import { useFileStore } from '@/stores/fileStore'
import { cn } from '@/utils'
import { formatFileSize } from '@/utils/fileReader'
import { X, FileImage, FileText, File, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function FileAttachmentBar() {
  const { pendingAttachments, removePendingFile, isReadingFiles } = useFileStore()
  const { t } = useTranslation()

  if (pendingAttachments.length === 0 && !isReadingFiles) return null

  return (
    <div className="flex flex-wrap gap-2 mb-2">
      {pendingAttachments.map((att) => (
        <div
          key={att.id}
          className={cn(
            'group flex items-center gap-1.5 px-2 py-1 rounded-lg border text-xs',
            att.type === 'image'
              ? 'border-primary-200 bg-primary-50'
              : att.type === 'text'
                ? 'border-[var(--wf-ok-line)] bg-[var(--wf-ok-bg)]'
                : att.type === 'document'
                  ? 'border-[var(--wf-warn-line)] bg-[var(--wf-warn-bg)]'
                  : 'border-[var(--wf-line)] bg-[var(--wf-mono-bg)]'
          )}
        >
          {att.type === 'image' ? (
            <FileImage size={12} className="text-primary-500" />
          ) : att.type === 'text' ? (
            <FileText size={12} className="text-[var(--wf-ok-ink)]" />
          ) : (
            <File size={12} className="text-[var(--wf-mut)]" />
          )}
          {att.isWorkspaceUpload && (
            <span className="px-1 rounded bg-primary-100 text-primary-700 text-[10px]">W</span>
          )}
          <span className="max-w-[120px] truncate text-[var(--wf-sub)]">{att.name}</span>
          <span className="text-[var(--wf-faint)]">{formatFileSize(att.size)}</span>
          <button
            onClick={() => removePendingFile(att.id)}
            className="p-0.5 rounded hover:bg-[var(--wf-hover)] text-[var(--wf-faint)] hover:text-[var(--wf-err-ink)] transition-colors opacity-0 group-hover:opacity-100"
          >
            <X size={10} />
          </button>
        </div>
      ))}
      {isReadingFiles && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-[var(--wf-line)] bg-[var(--wf-bg)] text-xs text-[var(--wf-mut)]">
          <Loader2 size={12} className="animate-spin" />
          {t('chat.fileAttachmentBar.reading')}
        </div>
      )}
    </div>
  )
}
