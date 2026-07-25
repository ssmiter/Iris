import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  WorkflowStepResponse,
  WorkflowSearchResponse,
} from '@/types/mescli'
import { workflowApi } from '@/api/client'

interface WorkflowState {
  // 当前工作流
  sessionId: string | null
  workflowName: string | null
  currentStep: WorkflowStepResponse | null
  collectedData: Record<string, unknown>
  isLoading: boolean
  error: string | null
  history: WorkflowStepResponse[]

  // 搜索
  searchResults: unknown[]
  isSearching: boolean

  // Actions
  startWorkflow: (workflowCode: string) => Promise<boolean>
  submitStep: (stepData: Record<string, unknown>) => Promise<boolean>
  cancelWorkflow: () => Promise<void>
  search: (toolName: string, keyword: string) => Promise<WorkflowSearchResponse | null>
  reset: () => void
  clearError: () => void
}

export const useWorkflowStore = create<WorkflowState>()(
  persist(
    (set, get) => ({
      sessionId: null,
      workflowName: null,
      currentStep: null,
      collectedData: {},
      isLoading: false,
      error: null,
      history: [],
      searchResults: [],
      isSearching: false,

  startWorkflow: async (workflowCode) => {
    set({ isLoading: true, error: null })
    try {
      const response = await workflowApi.start({ workflowCode })
      if (response.sessionId) {
        set({
          sessionId: response.sessionId,
          workflowName: response.workflowName || workflowCode,
          currentStep: response.step,
          collectedData: response.step?.context?.collectedData || {},
          history: response.step ? [response.step] : [],
          isLoading: false,
        })
        return true
      } else {
        set({ error: '启动工作流失败', isLoading: false })
        return false
      }
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '启动工作流失败',
        isLoading: false,
      })
      return false
    }
  },

  submitStep: async (stepData) => {
    const { sessionId, currentStep, collectedData, history } = get()
    if (!sessionId) {
      set({ error: '工作流会话不存在' })
      return false
    }

    set({ isLoading: true, error: null })
    try {
      // 合并已收集数据和新数据
      const mergedData = { ...collectedData, ...stepData }

      const response = await workflowApi.submit(sessionId, mergedData)

      if (response.success) {
        const isCompleted = response.context?.isCompleted ?? false
        set({
          currentStep: isCompleted ? null : response,
          collectedData: response.context?.collectedData || mergedData,
          history: [...history, response],
          isLoading: false,
        })
        return true
      } else {
        set({
          error: response.error || '提交失败',
          isLoading: false,
        })
        return false
      }
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '提交失败',
        isLoading: false,
      })
      return false
    }
  },

  cancelWorkflow: async () => {
    const { sessionId } = get()
    if (!sessionId) return
    try {
      await workflowApi.cancel(sessionId)
    } catch {
      // ignore
    }
    set({
      sessionId: null,
      workflowName: null,
      currentStep: null,
      collectedData: {},
      history: [],
    })
  },

  search: async (toolName, keyword) => {
    set({ isSearching: true })
    try {
      const response = await workflowApi.search({ toolName, keyword, limit: 20 })
      set({ searchResults: response.items || [], isSearching: false })
      return response
    } catch (err) {
      set({ isSearching: false })
      console.error('Workflow search failed', err)
      return null
    }
  },

  reset: () => {
    set({
      sessionId: null,
      workflowName: null,
      currentStep: null,
      collectedData: {},
      error: null,
      history: [],
      searchResults: [],
    })
  },

  clearError: () => set({ error: null }),
    }),
    {
      name: 'wonclaw-workflow',
      partialize: (state) => ({
        sessionId: state.sessionId,
        workflowName: state.workflowName,
        currentStep: state.currentStep,
        collectedData: state.collectedData,
        history: state.history,
      }),
    }
  )
)
