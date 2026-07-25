import { create } from 'zustand'
import { usageApi } from '@/api/usageApi'
import type { UsageRecordDto } from '@/types/mescli'

interface UsageState {
  /** 累计当日 Token（输入） */
  todayTokensIn: number
  /** 累计当日 Token（输出） */
  todayTokensOut: number
  /** 累计当日工作流运行次数 */
  todayWorkflowRuns: number
  /** 累计当日 WebBridge 操作次数 */
  todayWebbridgeActions: number
  /** 累计当日 API 调用次数 */
  todayApiCalls: number
  /** 待上报缓存 */
  pendingRecords: UsageRecordDto[]
  isReporting: boolean

  /** 上报一条或多条用量记录 */
  report: (records: UsageRecordDto | UsageRecordDto[]) => Promise<void>
  /** 立即批量上报待上报记录 */
  flush: () => Promise<void>
  /** 增加本地累计（用于实时 UI 刷新） */
  accumulate: (patch: Partial<Omit<UsageState, 'pendingRecords' | 'isReporting'>>) => void
  /** 清空累计 */
  reset: () => void
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10)
}

export const useUsageStore = create<UsageState>()((set, get) => ({
  todayTokensIn: 0,
  todayTokensOut: 0,
  todayWorkflowRuns: 0,
  todayWebbridgeActions: 0,
  todayApiCalls: 0,
  pendingRecords: [],
  isReporting: false,

  report: async (records) => {
    const list = Array.isArray(records) ? records : [records]
    if (list.length === 0) return

    // 合并同日期记录到本地累计
    set((s) => ({
      todayTokensIn: s.todayTokensIn + list.reduce((sum, r) => sum + (r.tokensIn || 0), 0),
      todayTokensOut: s.todayTokensOut + list.reduce((sum, r) => sum + (r.tokensOut || 0), 0),
      todayWorkflowRuns: s.todayWorkflowRuns + list.reduce((sum, r) => sum + (r.workflowRuns || 0), 0),
      todayWebbridgeActions: s.todayWebbridgeActions + list.reduce((sum, r) => sum + (r.webbridgeActions || 0), 0),
      todayApiCalls: s.todayApiCalls + list.reduce((sum, r) => sum + (r.apiCalls || 0), 0),
      pendingRecords: [...s.pendingRecords, ...list],
    }))

    // 尝试立即上报；失败时由 pendingRecords 缓存，下次 flush 重试
    await get().flush()
  },

  flush: async () => {
    const { pendingRecords, isReporting } = get()
    if (isReporting || pendingRecords.length === 0) return

    set({ isReporting: true })
    try {
      await usageApi.report(pendingRecords)
      set({ pendingRecords: [], isReporting: false })
    } catch (err) {
      // 上报失败保留 pendingRecords，下次重试
      set({ isReporting: false })
      console.warn('Usage report failed:', err)
    }
  },

  accumulate: (patch) => {
    set((s) => ({
      todayTokensIn: s.todayTokensIn + (patch.todayTokensIn || 0),
      todayTokensOut: s.todayTokensOut + (patch.todayTokensOut || 0),
      todayWorkflowRuns: s.todayWorkflowRuns + (patch.todayWorkflowRuns || 0),
      todayWebbridgeActions: s.todayWebbridgeActions + (patch.todayWebbridgeActions || 0),
      todayApiCalls: s.todayApiCalls + (patch.todayApiCalls || 0),
    }))
  },

  reset: () => {
    set({
      todayTokensIn: 0,
      todayTokensOut: 0,
      todayWorkflowRuns: 0,
      todayWebbridgeActions: 0,
      todayApiCalls: 0,
      pendingRecords: [],
    })
  },
}))

/**
 * 辅助函数：构建单条当日用量记录
 */
export function buildTodayUsageRecord(patch: Partial<UsageRecordDto> = {}): UsageRecordDto {
  return {
    date: todayDateString(),
    tokensIn: 0,
    tokensOut: 0,
    workflowRuns: 0,
    webbridgeActions: 0,
    apiCalls: 0,
    ...patch,
  }
}
