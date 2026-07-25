import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { licenseApi, readFingerprint } from '@/api/licenseApi'
import type { LicenseInfo, MachineFingerprint } from '@/types/mescli'

interface LicenseState {
  license: LicenseInfo | null
  fingerprint: MachineFingerprint | null
  isLoading: boolean
  isActivating: boolean
  error: string | null

  initialize: () => Promise<void>
  activate: (licenseKey: string) => Promise<boolean>
  deactivate: () => Promise<void>
  refresh: () => Promise<void>
  clearError: () => void
}

export const useLicenseStore = create<LicenseState>()(
  persist(
    (set, get) => ({
      license: null,
      fingerprint: null,
      isLoading: false,
      isActivating: false,
      error: null,

      initialize: async () => {
        set({ isLoading: true, error: null })
        try {
          const fingerprint = readFingerprint()
          const license = await licenseApi.getLicense()
          set({ license, fingerprint, isLoading: false })
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : '初始化 License 失败',
            isLoading: false,
          })
        }
      },

      activate: async (licenseKey: string) => {
        set({ isActivating: true, error: null })
        try {
          const fingerprint = get().fingerprint || readFingerprint()
          const response = await licenseApi.activate({
            licenseKey: licenseKey.trim(),
            fingerprint,
          })

          if (response.success && response.license) {
            set({ license: response.license, fingerprint, isActivating: false, error: null })
            return true
          } else {
            set({
              error: response.error || '激活失败',
              isActivating: false,
            })
            return false
          }
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : '激活过程发生异常',
            isActivating: false,
          })
          return false
        }
      },

      deactivate: async () => {
        set({ isLoading: true, error: null })
        try {
          await licenseApi.deactivate()
          set({ license: null, isLoading: false })
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : '注销 License 失败',
            isLoading: false,
          })
        }
      },

      refresh: async () => {
        await get().initialize()
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'wonwork-license',
      partialize: (state) => ({
        license: state.license,
        fingerprint: state.fingerprint,
      }),
    }
  )
)
