import { create } from 'zustand'

/**
 * 子 Agent 视图开关与胶囊生命周期（2026-08-01 异步子 Agent 视觉）。
 *
 * - openRunId：当前打开的子对话页（一次只看一个，复用对话页骨架）
 * - dismissedIds：终态胶囊被 × 关闭的集合（运行中胶囊不可关——它是唯一入口，
 *   关了就只能等完成通知气泡才知道去向）
 * 会话内状态，不持久化（与 runStore 同生命周期）。
 */
interface SubAgentViewState {
  openRunId: string | null
  dismissedIds: Set<string>
  open: (runId: string) => void
  close: () => void
  dismiss: (runId: string) => void
}

export const useSubAgentViewStore = create<SubAgentViewState>()((set) => ({
  openRunId: null,
  dismissedIds: new Set<string>(),
  open: (runId) => set({ openRunId: runId }),
  close: () => set({ openRunId: null }),
  dismiss: (runId) =>
    set((s) => {
      const next = new Set(s.dismissedIds)
      next.add(runId)
      // 关掉正在看的那个，视图一并收
      return { dismissedIds: next, openRunId: s.openRunId === runId ? null : s.openRunId }
    }),
}))
