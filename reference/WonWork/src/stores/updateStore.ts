import { create } from 'zustand'
import { updateApi, type VersionInfo } from '@/api/client'

const APP_VERSION = import.meta.env.VITE_APP_VERSION || '1.0.0'

interface UpdateState {
  currentVersion: string
  latestVersion: string | null
  downloadUrl: string | null
  releaseNotes: string | null
  mandatory: boolean
  allowedHosts: string[] | null
  isUpdateAvailable: boolean
  isChecking: boolean
  isUpdating: boolean
  updateProgress: number | null
  downloadStarted: boolean
  error: string | null
  dismissedVersion: string | null
  checkVersion: () => Promise<void>
  dismissUpdate: () => void
  applyUpdate: () => Promise<void>
  reset: () => void
}

function parseVersion(version: string): number[] {
  return version
    .replace(/^v/, '')
    .split('.')
    .map((part) => parseInt(part, 10) || 0)
}

function isNewer(current: string, latest: string): boolean {
  const currentParts = parseVersion(current)
  const latestParts = parseVersion(latest)
  const maxLength = Math.max(currentParts.length, latestParts.length)

  for (let i = 0; i < maxLength; i++) {
    const currentPart = currentParts[i] || 0
    const latestPart = latestParts[i] || 0
    if (latestPart > currentPart) return true
    if (latestPart < currentPart) return false
  }
  return false
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  currentVersion: APP_VERSION,
  latestVersion: null,
  downloadUrl: null,
  releaseNotes: null,
  mandatory: false,
  allowedHosts: null,
  isUpdateAvailable: false,
  isChecking: false,
  isUpdating: false,
  updateProgress: null,
  downloadStarted: false,
  error: null,
  dismissedVersion: null,

  checkVersion: async () => {
    set({ isChecking: true, error: null })
    try {
      const info = await updateApi.checkVersion()
      const hasUpdate = isNewer(get().currentVersion, info.version)
      const isDismissed = get().dismissedVersion === info.version

      set({
        latestVersion: info.version,
        downloadUrl: info.downloadUrl,
        releaseNotes: info.releaseNotes,
        mandatory: info.mandatory,
        allowedHosts: info.allowedHosts ?? null,
        isUpdateAvailable: hasUpdate && !isDismissed,
        isChecking: false,
      })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to check version',
        isChecking: false,
      })
    }
  },

  dismissUpdate: () => {
    const { latestVersion } = get()
    if (latestVersion) {
      set({ dismissedVersion: latestVersion, isUpdateAvailable: false })
    }
  },

  applyUpdate: async () => {
    const { downloadUrl, latestVersion, allowedHosts } = get()
    if (!downloadUrl || !latestVersion) return

    // 白名单校验（fail-closed，与后端 ApplyUpdate 一致）：allowedHosts 为 null 表示
    // 后端未下发（旧版后端/Standalone），跳过校验；下发为空数组则一律拒绝
    if (allowedHosts !== null) {
      let host = ''
      try {
        host = new URL(downloadUrl).hostname
      } catch {
        set({ error: 'Download URL is invalid' })
        return
      }
      const allowed = allowedHosts.some((h) => h.toLowerCase() === host.toLowerCase())
      if (!allowed) {
        set({ error: `Download host '${host}' is not allowed` })
        return
      }
    }

    // 借浏览器下载管理器：真后台、原生进度、断点续传，不受后端 10 分钟超时限制
    // （服务器慢时后端通道注定失败）。下载完成后用户手动运行安装包。
    window.open(downloadUrl, '_blank')
    set({ downloadStarted: true, error: null })
  },

  reset: () =>
    set({
      latestVersion: null,
      downloadUrl: null,
      releaseNotes: null,
      mandatory: false,
      isUpdateAvailable: false,
      isChecking: false,
      isUpdating: false,
      updateProgress: null,
      downloadStarted: false,
      error: null,
      dismissedVersion: null,
    }),
}))
