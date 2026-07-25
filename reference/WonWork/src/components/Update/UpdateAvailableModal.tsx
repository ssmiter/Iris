import { useTranslation } from 'react-i18next'
import { cn } from '@/utils'
import { useUpdateStore } from '@/stores/updateStore'
import { X, Download, AlertCircle, CheckCircle2 } from 'lucide-react'

export function UpdateAvailableModal() {
  const { t } = useTranslation()
  const {
    isUpdateAvailable,
    latestVersion,
    currentVersion,
    releaseNotes,
    mandatory,
    downloadStarted,
    downloadUrl,
    error,
    dismissUpdate,
    applyUpdate,
  } = useUpdateStore()

  if (!isUpdateAvailable) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-surface-200 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-surface-800">{t('update.updateModal.title')}</h3>
          {!mandatory && (
            <button
              onClick={dismissUpdate}
              className="p-1 rounded-md hover:bg-surface-100 text-surface-400 transition-colors"
              title={t('update.updateModal.later')}
            >
              <X size={18} />
            </button>
          )}
        </div>

        <div className="px-6 py-4 space-y-4">
          <p className="text-sm text-surface-600">
            {t('update.updateModal.description', { current: currentVersion, latest: latestVersion })}
          </p>

          {releaseNotes && (
            <div className="bg-surface-50 rounded-lg p-3 max-h-32 overflow-y-auto">
              <p className="text-xs text-surface-500 whitespace-pre-wrap">{releaseNotes}</p>
            </div>
          )}

          {downloadStarted && (
            <div className="flex items-start gap-2 p-3 bg-green-50 text-green-700 rounded-lg text-xs">
              <CheckCircle2 size={14} className="flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-medium">{t('update.updateModal.downloadStartedTitle')}</p>
                <p className="text-green-600">{t('update.updateModal.downloadStartedDesc')}</p>
                {downloadUrl && (
                  <a
                    href={downloadUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block text-primary-600 hover:text-primary-500 underline"
                  >
                    {t('update.updateModal.downloadFallback')}
                  </a>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 text-red-600 rounded-lg text-xs">
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="px-6 py-4 bg-surface-50 flex items-center justify-end gap-3">
          {downloadStarted ? (
            <button
              onClick={dismissUpdate}
              className="px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-500 rounded-lg transition-colors"
            >
              {t('update.updateModal.done')}
            </button>
          ) : (
            <>
              {!mandatory && (
                <button
                  onClick={dismissUpdate}
                  className="px-4 py-2 text-sm text-surface-600 hover:text-surface-800 hover:bg-surface-200 rounded-lg transition-colors"
                >
                  {t('update.updateModal.later')}
                </button>
              )}
              <button
                onClick={applyUpdate}
                className={cn(
                  'flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors',
                  'bg-primary-600 hover:bg-primary-500'
                )}
              >
                <Download size={16} />
                {t('update.updateModal.updateNow')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
