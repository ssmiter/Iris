import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, LogOut } from 'lucide-react'
import { useAdminStore } from '@/stores/adminStore'
import { AdminElevationDialog } from './AdminElevationDialog'

/**
 * 设置页「管理员」卡片（开发者选项解锁后可见）：
 * - 未提权：权限码登录入口（弹 AdminElevationDialog）。
 * - 已提权：状态 + 剩余有效期 + 退出按钮。
 * 提权后「数据库连接」卡片才会渲染（见 SettingsView 挂载条件）。
 */
export function AdminSettingsView() {
  const { t } = useTranslation()
  const { isElevated, expiresAt, revoke } = useAdminStore()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [revoking, setRevoking] = useState(false)

  const remainingMinutes = expiresAt ? Math.max(0, Math.round((expiresAt - Date.now()) / 60000)) : 0

  const handleRevoke = async () => {
    if (revoking) return
    setRevoking(true)
    try {
      await revoke()
    } finally {
      setRevoking(false)
    }
  }

  return (
    <div className="bg-[var(--wf-card-bg)] border border-[var(--wf-line)] rounded-xl p-5">
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck size={16} className="text-[var(--wf-mut)]" />
        <h3 className="text-sm font-semibold text-[var(--wf-sub)]">
          {t('settings.admin.title', { defaultValue: '管理员' })}
        </h3>
        <span className="wf-badge-warn">
          {t('settings.dbConfig.devBadge', { defaultValue: '开发者选项' })}
        </span>
      </div>
      <p className="text-xs text-[var(--wf-faint)] mb-4">
        {t('settings.admin.subtitle', {
          defaultValue: '提权后可管理数据库连接等系统配置，有效期 4 小时',
        })}
      </p>

      {isElevated ? (
        <div className="flex items-center justify-between">
          <span className="text-sm text-[var(--wf-ok-ink)] flex items-center gap-1.5">
            <ShieldCheck size={14} />
            {t('settings.admin.elevatedHint', {
              defaultValue: '已提权，剩余约 {{minutes}} 分钟',
              minutes: remainingMinutes,
            })}
          </span>
          <button
            onClick={handleRevoke}
            disabled={revoking}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-[var(--wf-sub)] hover:bg-[var(--wf-hover)] transition-colors disabled:opacity-50"
          >
            <LogOut size={13} />
            {t('settings.admin.revoke', { defaultValue: '退出提权' })}
          </button>
        </div>
      ) : (
        <button
          onClick={() => setDialogOpen(true)}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 transition-colors"
        >
          {t('settings.admin.elevateEntry', { defaultValue: '输入权限码提权' })}
        </button>
      )}

      {dialogOpen && <AdminElevationDialog onClose={() => setDialogOpen(false)} />}
    </div>
  )
}
