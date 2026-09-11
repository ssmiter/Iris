import { useFileStore } from '@/stores/fileStore'
import { formatFileSize } from '@/utils/fileReader'
import { X, FileImage, FileText, File } from 'lucide-react'
import { useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

export function FilePermissionModal() {
  const {
    isPermissionModalOpen,
    pendingPermissionFiles,
    grantPendingFiles,
    denyPendingFiles,
    closePermissionModal,
  } = useFileStore()
  const { t } = useTranslation()

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePermissionModal()
    },
    [closePermissionModal]
  )

  useEffect(() => {
    if (isPermissionModalOpen) {
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isPermissionModalOpen, handleKeyDown])

  if (!isPermissionModalOpen || pendingPermissionFiles.length === 0) return null

  return (
    <div className="wf-file-perm-modal fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={closePermissionModal} />

      <div className="relative bg-[var(--wf-card-bg)] rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        <div className="px-6 py-4 border-b border-[var(--wf-line)] flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--wf-ink)]">{t('chat.filePermissionModal.title')}</h2>
          <button
            onClick={closePermissionModal}
            className="p-1.5 rounded-lg hover:bg-[var(--wf-hover)] text-[var(--wf-faint)]"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-4">
          <p className="text-sm text-[var(--wf-sub)] mb-3">
            {t('chat.filePermissionModal.description')}
          </p>
          <div className="space-y-2 max-h-48 overflow-y-auto scrollbar-thin">
            {pendingPermissionFiles.map((file, i) => (
              <div
                key={i}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--wf-bg)] border border-[var(--wf-hair)]"
              >
                {file.type.startsWith('image/') ? (
                  <FileImage size={16} className="text-primary-500" />
                ) : file.type.startsWith('text/') ? (
                  <FileText size={16} className="text-[var(--wf-ok-ink)]" />
                ) : (
                  <File size={16} className="text-[var(--wf-warn-ink)]" />
                )}
                <span className="text-sm text-[var(--wf-sub)] flex-1 truncate">{file.name}</span>
                <span className="text-xs text-[var(--wf-faint)]">{formatFileSize(file.size)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-[var(--wf-line)] flex flex-wrap gap-2 justify-end">
          <button
            onClick={denyPendingFiles}
            className="px-4 py-2 rounded-lg border border-[var(--wf-line)] text-sm text-[var(--wf-sub)] hover:bg-[var(--wf-hover)] transition-colors"
          >
            {t('chat.filePermissionModal.deny')}
          </button>
          <button
            onClick={() => grantPendingFiles(false)}
            className="px-4 py-2 rounded-lg bg-primary-500 text-white text-sm hover:bg-primary-600 transition-colors"
          >
            {t('chat.filePermissionModal.allowOnce')}
          </button>
          <button
            onClick={() => grantPendingFiles(true)}
            className="px-4 py-2 rounded-lg bg-primary-500 text-white text-sm hover:bg-primary-600 transition-colors"
          >
            {t('chat.filePermissionModal.allowAll')}
          </button>
        </div>
      </div>
    </div>
  )
}
