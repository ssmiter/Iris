import { useTranslation } from 'react-i18next'
import { X, Download, CheckCircle2, AlertCircle } from 'lucide-react'
import { useUpdateStore } from '@/stores/updateStore'

/**
 * 非强制更新的非模态通知条（右下角）。
 * 2026-07-29：原 30 分钟轮询发现更新直接弹全屏模态，会打断流式对话与输入；
 * 非 mandatory 更新改为此常驻角落卡片——不抢焦点、不遮 composer，
 * mandatory 更新仍走 UpdateAvailableModal 全屏模态。
 */
export function UpdateNotificationBanner() {
  const { t } = useTranslation()
  const {
    isUpdateAvailable,
    latestVersion,
    currentVersion,
    releaseNotes,
    mandatory,
    downloadStarted,
    error,
    dismissUpdate,
    applyUpdate,
  } = useUpdateStore()

  // mandatory 交给 UpdateAvailableModal；这里只承载非强制更新
  if (!isUpdateAvailable || mandatory) return null

  return (
    <div className="fixed bottom-6 right-6 z-[90] w-80 bg-[var(--wf-card-bg)] border border-[var(--wf-line)] rounded-xl shadow-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--wf-hair)] flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--wf-ink)]">{t('update.updateModal.title')}</h3>
        <button
          onClick={dismissUpdate}
          className="p-1 rounded-md hover:bg-[var(--wf-hover)] text-[var(--wf-faint)] transition-colors"
          title={t('update.updateModal.later')}
        >
          <X size={14} />
        </button>
      </div>

      <div className="px-4 py-3 space-y-2">
        <p className="text-xs text-[var(--wf-sub)]">
          {t('update.updateModal.description', { current: currentVersion, latest: latestVersion })}
        </p>
        {releaseNotes && (
          <p className="text-xs text-[var(--wf-faint)] line-clamp-3 whitespace-pre-wrap">{releaseNotes}</p>
        )}
        {downloadStarted && (
          <p className="flex items-start gap-1.5 text-xs text-[var(--wf-ok-ink)]">
            <CheckCircle2 size={12} className="flex-shrink-0 mt-0.5" />
            {t('update.updateModal.downloadStartedTitle')}
          </p>
        )}
        {error && (
          <p className="flex items-start gap-1.5 text-xs text-[var(--wf-err-ink)]">
            <AlertCircle size={12} className="flex-shrink-0 mt-0.5" />
            {error}
          </p>
        )}
      </div>

      <div className="px-4 py-3 bg-[var(--wf-bg)] flex items-center justify-end gap-2">
        {downloadStarted ? (
          <button
            onClick={dismissUpdate}
            className="px-3 py-1.5 text-xs font-medium text-white bg-primary-600 hover:bg-primary-500 rounded-lg transition-colors"
          >
            {t('update.updateModal.done')}
          </button>
        ) : (
          <>
            <button
              onClick={dismissUpdate}
              className="px-3 py-1.5 text-xs text-[var(--wf-sub)] hover:text-[var(--wf-ink)] hover:bg-[var(--wf-hover)] rounded-lg transition-colors"
            >
              {t('update.updateModal.later')}
            </button>
            <button
              onClick={applyUpdate}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-primary-600 hover:bg-primary-500 rounded-lg transition-colors"
            >
              <Download size={12} />
              {t('update.updateModal.updateNow')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
