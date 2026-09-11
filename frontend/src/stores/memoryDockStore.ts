import { create } from 'zustand'

/**
 * 记忆抽屉开关（记忆可视化重构 2026-07-30）
 *
 * 记忆不再是独立页面——以右侧抽屉与对话同平面呈现（同 ArtifactDock 的 wf-dock 模式）。
 * 入口：/memory 命令、对话内记忆便签（旧会话回放）、管理页。
 */

export type MemoryDockView = 'stream' | 'tree'

interface MemoryDockState {
  isOpen: boolean
  /** stream=拾光·墨迹流 / tree=时空树 */
  activeView: MemoryDockView
  /** 打开时聚焦某条记忆（便签/卡片点入时携带） */
  focusId: string | null
  open: (opts?: { view?: MemoryDockView; focusId?: string }) => void
  close: () => void
  toggle: () => void
  setView: (view: MemoryDockView) => void
}

export const useMemoryDockStore = create<MemoryDockState>()((set) => ({
  isOpen: false,
  activeView: 'stream',
  focusId: null,
  open: (opts) =>
    set((s) => ({
      isOpen: true,
      activeView: opts?.view ?? s.activeView,
      focusId: opts?.focusId ?? null,
    })),
  close: () => set({ isOpen: false, focusId: null }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen, focusId: null })),
  setView: (view) => set({ activeView: view }),
}))
