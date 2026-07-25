import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { workspaceApi } from '@/api/client'
import { getRuntimeMode } from '@/utils/runtimeMode'

/**
 * 项目模式状态（打磨任务2 S4）。
 *
 * 设计决策（终态文档第六节）：
 * - D1：后端是机器级单活跃项目根；前端在会话激活时幂等断言。
 * - D2：会话-项目绑定持久化在前端 localStorage，后端零 DTO 改动。
 * - 仅 mescli-local 可用（Online 隐藏、Standalone 是 S5）。
 */
interface ProjectState {
  /** 当前后端活跃项目根（GET /api/workspace/project 同步） */
  activeProject: { path: string; name: string | null } | null
  /** 会话 → 项目根绑定（key 为 conversationId 的字符串） */
  bindings: Record<string, string>
  loading: boolean
  error: string | null

  /** 项目模式是否可用（仅 MESCLI Local） */
  isProjectModeAvailable: () => boolean
  /** 从后端同步活跃项目根（开关关闭/未选择时置 null） */
  refreshActiveProject: () => Promise<void>
  /** 绑定项目到会话：幂等断言后端 + 记录绑定 */
  bindProject: (conversationId: number | null, path: string) => Promise<void>
  /** 解除会话绑定（不清除后端 active——别的会话可能正用着） */
  unbindProject: (conversationId: number | null) => void
  /** 读取会话绑定 */
  getBinding: (conversationId: number | null) => string | null
  /** 会话激活时断言：绑定存在且与后端 active 不同 → 幂等 PUT */
  assertProjectForConversation: (conversationId: number | null) => Promise<void>
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      activeProject: null,
      bindings: {},
      loading: false,
      error: null,

      isProjectModeAvailable: () => getRuntimeMode() === 'mescli-local',

      refreshActiveProject: async () => {
        if (!get().isProjectModeAvailable()) {
          set({ activeProject: null })
          return
        }
        try {
          const res = await workspaceApi.getProject()
          set({ activeProject: res.path ? { path: res.path, name: res.name } : null, error: null })
        } catch {
          // 开关关闭（403）或网络问题：静默降级为无项目
          set({ activeProject: null })
        }
      },

      bindProject: async (conversationId, path) => {
        set({ loading: true, error: null })
        try {
          const res = await workspaceApi.setProject(path)
          set((state) => ({
            activeProject: { path: res.path, name: res.name },
            bindings:
              conversationId != null
                ? { ...state.bindings, [String(conversationId)]: res.path }
                : state.bindings,
            loading: false,
          }))
        } catch (err) {
          const msg = err instanceof Error ? err.message : '设置项目失败'
          set({ error: msg, loading: false })
          throw err
        }
      },

      unbindProject: (conversationId) => {
        if (conversationId == null) return
        set((state) => {
          const next = { ...state.bindings }
          delete next[String(conversationId)]
          return { bindings: next }
        })
      },

      getBinding: (conversationId) => {
        if (conversationId == null) return null
        return get().bindings[String(conversationId)] ?? null
      },

      assertProjectForConversation: async (conversationId) => {
        const binding = get().getBinding(conversationId)
        if (!binding || !get().isProjectModeAvailable()) return
        const active = get().activeProject
        if (active?.path?.toLowerCase() === binding.toLowerCase()) return
        try {
          const res = await workspaceApi.setProject(binding)
          set({ activeProject: { path: res.path, name: res.name } })
        } catch (err) {
          // 断言失败（如目录已删除）不阻断会话，仅记录
          console.warn('[projectStore] 项目断言失败:', err)
        }
      },
    }),
    {
      name: 'wonclaw-project-bindings',
      partialize: (state) => ({ bindings: state.bindings }),
    }
  )
)
