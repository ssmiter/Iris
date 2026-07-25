import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TaskStatus, TaskProgressItem } from '@/types/mescli'

interface ContextFile {
  id: string
  name: string
  type: string
  size: number
  downloadUrl?: string
}

interface ContextPanelState {
  isOpen: boolean
  tasks: TaskProgressItem[]
  contextFiles: ContextFile[]

  togglePanel: () => void
  setOpen: (open: boolean) => void
  setTasks: (tasks: TaskProgressItem[]) => void
  updateTaskStatus: (id: string, status: TaskStatus) => void
  addTask: (task: Omit<TaskProgressItem, 'id'>) => void
  clearTasks: () => void
  setContextFiles: (files: ContextFile[]) => void
  removeContextFile: (id: string) => void
}

export const useContextPanelStore = create<ContextPanelState>()(
  persist(
    (set) => ({
      isOpen: false,
      tasks: [],
      contextFiles: [],

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

      setContextFiles: (files) => set({ contextFiles: files }),
      removeContextFile: (id) =>
        set((s) => ({
          contextFiles: s.contextFiles.filter((f) => f.id !== id),
        })),
    }),
    {
      name: 'wonclaw-context-panel',
      partialize: (state) => ({ isOpen: state.isOpen, contextFiles: state.contextFiles }),
    }
  )
)
