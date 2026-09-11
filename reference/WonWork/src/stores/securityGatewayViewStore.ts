import { create } from 'zustand'

/**
 * 数据安全网关仪表盘覆盖层开关（第三层，独立于设置层）。
 *
 * 与 settingsOverlayStore 同构：只保留 isOpen/open/close，不 persist，不介入路由，不编排动画。
 * 网关层 z-index 高于设置层（index.css .wf-gw-overlay z:45 > .wf-set-overlay z:40），
 * Esc 层栈由 MainLayout 编排：网关在设置之上，Esc 先关网关再关设置。
 */
interface SecurityGatewayViewState {
  isOpen: boolean
  open: () => void
  close: () => void
}

export const useSecurityGatewayViewStore = create<SecurityGatewayViewState>()((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}))
