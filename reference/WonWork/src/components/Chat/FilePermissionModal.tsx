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

      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        <div className="px-6 py-4 border-b border-surface-200 flex items-center justify-between">
          <h2 className="text-base font-semibold text-surface-800">{t('chat.filePermissionModal.title')}</h2>
          <button
            onClick={closePermissionModal}
            className="p-1.5 rounded-lg hover:bg-surface-100 text-surface-400"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-4">
          <p className="text-sm text-surface-600 mb-3">
            {t('chat.filePermissionModal.description')}
          </p>
          <div className="space-y-2 max-h-48 overflow-y-auto scrollbar-thin">
            {pendingPermissionFiles.map((file, i) => (
              <div
                key={i}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-50 border border-surface-100"
              >
                {file.type.startsWith('image/') ? (
                  <FileImage size={16} className="text-primary-500" />
                ) : file.type.startsWith('text/') ? (
                  <FileText size={16} className="text-green-500" />
                ) : (
                  <File size={16} className="text-amber-500" />
                )}
                <span className="text-sm text-surface-700 flex-1 truncate">{file.name}</span>
                <span className="text-xs text-surface-400">{formatFileSize(file.size)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-surface-200 flex flex-wrap gap-2 justify-end">
          <button
            onClick={denyPendingFiles}
            className="px-4 py-2 rounded-lg border border-surface-200 text-sm text-surface-600 hover:bg-surface-50 transition-colors"
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
