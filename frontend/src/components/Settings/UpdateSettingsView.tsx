import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, CheckCircle2, Loader2, Download, AlertCircle } from 'lucide-react'
import { useUpdateStore, isNewer } from '@/stores/updateStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { createDevModeUnlockCounter } from '@/utils/devModeUnlock'

/**
 * 设置页「版本更新」卡片：显示当前版本、手动检查更新、有更新时给入口。
 * 与全局 UpdateAvailableModal 共用 updateStore——手动检查发现有更新时弹窗也会出现，
 * 这里提供的是"随时可看、可忽略后再找回"的常驻入口（对齐 VS Code / Chrome 的设置页惯例）。
 * 版本号文本是开发者选项的规范触发入口（Android 一致）：2s 内连点 5 次解锁。
 */
export function UpdateSettingsView() {
  const { t } = useTranslation()
  const devModeUnlocked = useSettingsStore((s) => s.devModeUnlocked)
  const unlockCounter = useMemo(createDevModeUnlockCounter, [])
  const {
    currentVersion,
    latestVersion,
    dismissedVersion,
    isChecking,
    downloadStarted,
    error,
    checkVersion,
    applyUpdate,
  } = useUpdateStore()

  const hasNewer = latestVersion != null && isNewer(currentVersion, latestVersion)
  const isDismissed = hasNewer && dismissedVersion === latestVersion

  return (
    <div className="bg-[var(--wf-card-bg)] border border-[var(--wf-line)] rounded-xl p-5">
      <div className="flex items-center gap-2 mb-3">
        <RefreshCw size={16} className="text-[var(--wf-mut)]" />
        <h3 className="text-sm font-semibold text-[var(--wf-sub)]">{t('settings.settingsView.updateTitle')}</h3>
      </div>

      <div className="flex items-center flex-wrap gap-3">
        <span className="text-sm text-[var(--wf-sub)]">
          {t('settings.settingsView.currentVersion')}：
          <span
            className="font-medium text-[var(--wf-ink)] select-none cursor-default"
            onClick={devModeUnlocked ? undefined : unlockCounter}
          >
            {currentVersion}
          </span>
        </span>
        <button
          onClick={checkVersion}
          disabled={isChecking}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border border-[var(--wf-line)] text-[var(--wf-sub)] hover:border-primary-300 hover:text-primary-600 transition-colors disabled:opacity-50"
        >
          {isChecking && <Loader2 size={13} className="animate-spin" />}
          {isChecking ? t('settings.settingsView.checking') : t('settings.settingsView.checkUpdate')}
        </button>
        {hasNewer && (
          <button
            onClick={applyUpdate}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-white bg-primary-600 hover:bg-primary-500 transition-colors"
          >
            <Download size={13} />
            {t('settings.settingsView.updateNow')}
          </button>
        )}
      </div>

      <div className="mt-2 text-xs space-y-1">
        {error ? (
          <p className="text-[var(--wf-err-ink)] flex items-center gap-1">
            <AlertCircle size={12} />
            {t('settings.settingsView.checkFailed', { message: error })}
          </p>
        ) : hasNewer ? (
          <p className="text-primary-600">
            {t('settings.settingsView.newVersionAvailable', { latest: latestVersion })}
            {isDismissed && (
              <span className="text-[var(--wf-faint)]"> {t('settings.settingsView.dismissedHint')}</span>
            )}
          </p>
        ) : latestVersion ? (
          <p className="text-[var(--wf-ok-ink)] flex items-center gap-1">
            <CheckCircle2 size={12} />
            {t('settings.settingsView.latestAlready')}
          </p>
        ) : null}
        {downloadStarted && (
          <p className="text-[var(--wf-ok-ink)]">{t('settings.settingsView.downloadStartedHint')}</p>
        )}
      </div>
    </div>
  )
}
