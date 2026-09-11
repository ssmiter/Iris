import { create } from 'zustand'

/**
 * 设置覆盖层开关（刻意贫瘠）。
 *
 * 与 corridorStore 不同：走廊是能力房专属形态，设置层是独立的全屏覆盖层。
 * 只保留 isOpen/open/close，不 persist，不介入路由，不编排动画。
 */
interface SettingsOverlayState {
  isOpen: boolean
  open: () => void
  close: () => void
}

export const useSettingsOverlayStore = create<SettingsOverlayState>()((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}))
