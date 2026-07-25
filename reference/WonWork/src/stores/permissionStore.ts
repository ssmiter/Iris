import { create } from 'zustand'
import { permissionApi } from '@/api/client'
import type { UserPermissions } from '@/types/mescli'

interface PermissionState {
  permissions: UserPermissions | null
  isLoading: boolean
  error: string | null
  loadPermissions: () => Promise<void>
  clearPermissions: () => void
}

export const usePermissionStore = create<PermissionState>((set) => ({
  permissions: null,
  isLoading: false,
  error: null,

  loadPermissions: async () => {
    set({ isLoading: true, error: null })
    try {
      const permissions = await permissionApi.getPermissions()
      set({ permissions, isLoading: false })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '加载权限失败',
        isLoading: false,
      })
    }
  },

  clearPermissions: () => set({ permissions: null, error: null }),
}))
