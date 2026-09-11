import { create } from 'zustand'

/**
 * 图表框选追问（蓝图 v13 askchip 契约，2026-08-12）：
 * ChartRenderer 框选出一个区间后 set 一条 pending；ChatView 订阅后把它灌进
 * 输入框的 quote chip（复用 v9 选中引用管线），用户接着敲问题即可。
 * 刻意不持久化——选区追问是当下动作，跨会话复活没有意义。
 */
export interface ChartAskPayload {
  /** 进 quote chip 的引用描述（会作为「引用」前缀拼入消息体），例：图 · 6/18–6/20 选区（最低 91.2%） */
  quote: string
  /** 输入框占位/建议问题（蓝图"就带着 X–Y 追问"的完整问句），ChatView 仅用于预填，可空 */
  suggestion?: string
}

interface ChartAskState {
  pending: ChartAskPayload | null
  setAsk: (p: ChartAskPayload) => void
  clear: () => void
}

export const useChartAskStore = create<ChartAskState>()((set) => ({
  pending: null,
  setAsk: (p) => set({ pending: p }),
  clear: () => set({ pending: null }),
}))
