import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, Loader2, AlertCircle, X } from 'lucide-react'
import { useAdminStore } from '@/stores/adminStore'
import { credentialAutofillGuard } from '@/utils/autofillGuard'

/**
 * 管理员提权对话框：输入权限码 → 后端校验（5 次失败锁 15 分钟）→ 签发 4h 提权 token。
 * 权限码本身不持久化，只保存签发的 token。
 */
export function AdminElevationDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const elevate = useAdminStore((s) => s.elevate)
  const [accessCode, setAccessCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    const code = accessCode.trim()
    if (!code || busy) return
    setBusy(true)
    setError('')
    try {
      await elevate(code)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-[var(--wf-card-bg)] rounded-xl shadow-xl w-[380px] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <ShieldCheck size={16} className="text-primary-500" />
            <h3 className="text-sm font-semibold text-[var(--wf-sub)]">
              {t('settings.admin.elevateTitle', { defaultValue: '管理员提权' })}
            </h3>
          </div>
          <button onClick={onClose} className="text-[var(--wf-faint)] hover:text-[var(--wf-sub)] transition-colors">
            <X size={16} />
          </button>
        </div>
        <p className="text-xs text-[var(--wf-faint)] mb-4">
          {t('settings.admin.elevateSubtitle', {
            defaultValue: '输入权限码进入管理员模式，提权有效期 4 小时',
          })}
        </p>

        <input
          type="password"
          {...credentialAutofillGuard}
          value={accessCode}
          onChange={(e) => setAccessCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder={t('settings.admin.accessCodePlaceholder', { defaultValue: '请输入权限码' })}
          autoFocus
          className="w-full px-3 py-2 border border-[var(--wf-line)] rounded-lg text-sm focus:outline-none focus:border-primary-400"
        />

        {error && (
          <p className="mt-2 text-sm text-[var(--wf-err-ink)] flex items-center gap-1">
            <AlertCircle size={14} /> {error}
          </p>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-[var(--wf-sub)] hover:bg-[var(--wf-hover)] transition-colors"
          >
            {t('settings.settingsView.cancel', { defaultValue: '取消' })}
          </button>
          <button
            onClick={handleSubmit}
            disabled={busy || !accessCode.trim()}
            className={
              busy || !accessCode.trim()
                ? 'flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-[var(--wf-mono-bg)] text-[var(--wf-faint)] cursor-not-allowed'
                : 'flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 transition-colors'
            }
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {t('settings.admin.confirm', { defaultValue: '提权' })}
          </button>
        </div>
      </div>
    </div>
  )
}
