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

  // 2026-07-29：非 mandatory 更新改由 UpdateNotificationBanner（右下角非模态）承载，
  // 全屏模态只留给强制更新——避免 30 分钟轮询弹窗打断流式对话与输入。
  if (!isUpdateAvailable || !mandatory) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-[var(--wf-card-bg)] rounded-2xl shadow-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-[var(--wf-line)] flex items-center justify-between">
          <h3 className="text-lg font-semibold text-[var(--wf-ink)]">{t('update.updateModal.title')}</h3>
          {!mandatory && (
            <button
              onClick={dismissUpdate}
              className="p-1 rounded-md hover:bg-[var(--wf-hover)] text-[var(--wf-faint)] transition-colors"
              title={t('update.updateModal.later')}
            >
              <X size={18} />
            </button>
          )}
        </div>

        <div className="px-6 py-4 space-y-4">
          <p className="text-sm text-[var(--wf-sub)]">
            {t('update.updateModal.description', { current: currentVersion, latest: latestVersion })}
          </p>

          {releaseNotes && (
            <div className="bg-[var(--wf-bg)] rounded-lg p-3 max-h-32 overflow-y-auto">
              <p className="text-xs text-[var(--wf-mut)] whitespace-pre-wrap">{releaseNotes}</p>
            </div>
          )}

          {downloadStarted && (
            <div className="flex items-start gap-2 p-3 bg-[var(--wf-ok-bg)] text-[var(--wf-ok-ink)] rounded-lg text-xs">
              <CheckCircle2 size={14} className="flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-medium">{t('update.updateModal.downloadStartedTitle')}</p>
                <p className="text-[var(--wf-ok-ink)]">{t('update.updateModal.downloadStartedDesc')}</p>
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
            <div className="flex items-start gap-2 p-3 bg-[var(--wf-err-bg)] text-[var(--wf-err-ink)] rounded-lg text-xs">
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="px-6 py-4 bg-[var(--wf-bg)] flex items-center justify-end gap-3">
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
                  className="px-4 py-2 text-sm text-[var(--wf-sub)] hover:text-[var(--wf-ink)] hover:bg-[var(--wf-hover)] rounded-lg transition-colors"
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
