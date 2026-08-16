import { create } from 'zustand'

interface ShellOverlayState {
  settingsOpen: boolean
  searchOpen: boolean
  setSettingsOpen: (open: boolean) => void
  setSearchOpen: (open: boolean) => void
}

/** 外壳覆盖层（设置 / 搜索）的开合事实；Esc 语义走 escLayerStack。 */
export const useShellOverlayStore = create<ShellOverlayState>((set) => ({
  settingsOpen: false,
  searchOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
}))
