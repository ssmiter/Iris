import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HardDrive, Loader2 } from 'lucide-react'
import { useWorkspaceFileStore } from '@/stores/workspaceFileStore'
import { getWorkspaceAdapter } from '@/services/workspaceAdapters'
import { isFileSystemAccessSupported } from '@/utils/workspaceStorage'

/**
 * 设置页「工作区」组（2026-08-12 从对话右侧面板迁来）。
 *
 * 连接本地文件夹是应用级能力（对话与预览坞共用），放设置里统一管理。
 * 状态/动作语义与 workspaceFileStore 对齐：
 * - 后端托管模式（MESCLI/Online，backend 适配器）工作区自动保持连接，无需手动连接；
 * - 目录选择器只在 Standalone/Local（indexedDb 适配器）且浏览器支持文件系统访问时可用，
 *   其余情况按钮禁用并给出直白说明，不做假状态。
 */
export function WorkspaceSettingsView() {
  const { t } = useTranslation()
  const isConnected = useWorkspaceFileStore((s) => s.isConnected)
  const isFallbackMode = useWorkspaceFileStore((s) => s.isFallbackMode)
  const workspacePath = useWorkspaceFileStore((s) => s.workspacePath)
  const isLoading = useWorkspaceFileStore((s) => s.isLoading)
  const error = useWorkspaceFileStore((s) => s.error)
  const init = useWorkspaceFileStore((s) => s.init)
  const connectWorkspace = useWorkspaceFileStore((s) => s.connectWorkspace)
  const disconnectWorkspace = useWorkspaceFileStore((s) => s.disconnectWorkspace)

  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void init()
  }, [init])

  // 目录选择器只在后端托管之外（indexedDb 适配器）且浏览器支持时才可用
  const isBackend = getWorkspaceAdapter().kind === 'backend'
  const canPickFolder = !isBackend && isFileSystemAccessSupported()

  const statusText = isConnected
    ? t('chat.workspaceFilesPanel.connected', { path: workspacePath || 'workspace' })
    : isFallbackMode
      ? t('chat.workspaceFilesPanel.fallback')
      : t('chat.workspaceFilesPanel.disconnected')

  const hint = isBackend
    ? t('settings.overlay.workspaceBackendManaged')
    : !isFileSystemAccessSupported()
      ? t('settings.overlay.workspaceNoFsAccess')
      : t('settings.overlay.workspaceHint')

  const handleConnect = async () => {
    setBusy(true)
    try {
      await connectWorkspace()
    } finally {
      setBusy(false)
    }
  }

  const handleDisconnect = async () => {
    setBusy(true)
    try {
      await disconnectWorkspace()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="wf-set-row">
        <span className="wf-set-row-ic">
          {isLoading ? <Loader2 size={16} className="animate-spin" /> : <HardDrive size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="wf-set-row-nm">{t('chat.workspaceFilesPanel.title')}</div>
          <div className="wf-set-row-sub truncate" title={statusText}>
            {statusText}
          </div>
        </div>
        <span className="wf-set-row-r">
          {isConnected ? (
            <button
              onClick={handleDisconnect}
              disabled={!canPickFolder || busy}
              className="px-3 py-1.5 rounded-lg text-sm text-[var(--wf-sub)] hover:bg-[var(--wf-hover)] transition-colors disabled:opacity-50"
            >
              {t('chat.workspaceFilesPanel.disconnect')}
            </button>
          ) : (
            <button
              onClick={handleConnect}
              disabled={!canPickFolder || busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 transition-colors disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : t('chat.workspaceFilesPanel.connect')}
            </button>
          )}
        </span>
      </div>

      <div className="wf-set-expand-pad">
        <p className="text-[12px] leading-relaxed" style={{ color: 'var(--wf-mut)', margin: 0 }}>
          {hint}
        </p>
        {error && (
          <p className="text-[12px] mt-1.5 text-[var(--wf-err-ink)]" style={{ margin: 0 }}>
            {error}
          </p>
        )}
      </div>
    </>
  )
}
