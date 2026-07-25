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
                ? 'border-green-200 bg-green-50'
                : att.type === 'document'
                  ? 'border-amber-200 bg-amber-50'
                  : 'border-surface-200 bg-surface-100'
          )}
        >
          {att.type === 'image' ? (
            <FileImage size={12} className="text-primary-500" />
          ) : att.type === 'text' ? (
            <FileText size={12} className="text-green-500" />
          ) : (
            <File size={12} className="text-surface-500" />
          )}
          {att.isWorkspaceUpload && (
            <span className="px-1 rounded bg-primary-100 text-primary-700 text-[10px]">W</span>
          )}
          <span className="max-w-[120px] truncate text-surface-700">{att.name}</span>
          <span className="text-surface-400">{formatFileSize(att.size)}</span>
          <button
            onClick={() => removePendingFile(att.id)}
            className="p-0.5 rounded hover:bg-surface-200 text-surface-400 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
          >
            <X size={10} />
          </button>
        </div>
      ))}
      {isReadingFiles && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-surface-200 bg-surface-50 text-xs text-surface-500">
          <Loader2 size={12} className="animate-spin" />
          {t('chat.fileAttachmentBar.reading')}
        </div>
      )}
    </div>
  )
}
