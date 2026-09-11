import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TaskStatus, TaskProgressItem } from '@/types/mescli'

/**
 * 右侧面板状态。
 * 2026-07-31：contextFiles 移出本 store——它是 attachments+messages 的纯派生数据，
 * 现由 ContextFilesPanel 内 useMemo 直接推导，不再经"effect 同步 + persist 落盘"绕路
 * （原实现每次流式 flush 都会重写派生副本并写 localStorage）。
 */
interface ContextPanelState {
  isOpen: boolean
  tasks: TaskProgressItem[]

  togglePanel: () => void
  setOpen: (open: boolean) => void
  setTasks: (tasks: TaskProgressItem[]) => void
  updateTaskStatus: (id: string, status: TaskStatus) => void
  addTask: (task: Omit<TaskProgressItem, 'id'>) => void
  clearTasks: () => void
}

export const useContextPanelStore = create<ContextPanelState>()(
  persist(
    (set) => ({
      isOpen: false,
      tasks: [],

      togglePanel: () => set((s) => ({ isOpen: !s.isOpen })),
      setOpen: (open) => set({ isOpen: open }),

      setTasks: (tasks) => set({ tasks }),
      updateTaskStatus: (id, status) =>
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === id ? { ...t, status } : t)),
        })),
      addTask: (task) =>
        set((s) => ({
          tasks: [...s.tasks, { ...task, id: `task-${s.tasks.length}-${Date.now()}` }],
        })),
      clearTasks: () => set({ tasks: [] }),
    }),
    {
      name: 'wonclaw-context-panel',
      partialize: (state) => ({ isOpen: state.isOpen }),
    }
  )
)
