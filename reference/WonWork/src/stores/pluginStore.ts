import { create } from 'zustand'
import { pluginApi } from '@/api/client'
import type { InstalledPlugin } from '@/types/plugin'

interface PluginState {
  plugins: InstalledPlugin[]
  isLoading: boolean
  error: string | null
  loadPlugins: () => Promise<void>
  installPlugin: (file: File) => Promise<InstalledPlugin>
  uninstallPlugin: (id: string) => Promise<void>
  togglePlugin: (id: string, isEnabled: boolean) => Promise<void>
  clearError: () => void
}

export const usePluginStore = create<PluginState>((set, get) => ({
  plugins: [],
  isLoading: false,
  error: null,

  loadPlugins: async () => {
    set({ isLoading: true, error: null })
    try {
      const plugins = await pluginApi.getPlugins()
      set({ plugins, isLoading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '加载插件失败', isLoading: false })
    }
  },

  installPlugin: async (file) => {
    try {
      const installed = await pluginApi.installPlugin(file)
      set((state) => {
        const existingIndex = state.plugins.findIndex((p) => p.id === installed.id)
        if (existingIndex >= 0) {
          const next = [...state.plugins]
          next[existingIndex] = installed
          return { plugins: next, error: null }
        }
        return { plugins: [...state.plugins, installed], error: null }
      })
      return installed
    } catch (err) {
      const message = err instanceof Error ? err.message : '安装插件失败'
      set({ error: message })
      throw err
    }
  },

  uninstallPlugin: async (id) => {
    try {
      await pluginApi.uninstallPlugin(id)
      set((state) => ({ plugins: state.plugins.filter((p) => p.id !== id), error: null }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '卸载插件失败' })
      throw err
    }
  },

  togglePlugin: async (id, isEnabled) => {
    try {
      const updated = await pluginApi.togglePlugin(id, isEnabled)
      set((state) => ({
        plugins: state.plugins.map((p) => (p.id === id ? updated : p)),
        error: null,
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '切换插件状态失败' })
      throw err
    }
  },

  clearError: () => set({ error: null }),
}))
