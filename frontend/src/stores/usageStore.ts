import { create } from 'zustand'
import { usageApi } from '@/api/usageApi'
import type { UsageRecordDto } from '@/types/mescli'

interface UsageState {
  /** 待上报缓存 */
  pendingRecords: UsageRecordDto[]
  isReporting: boolean

  /** 上报一条或多条用量记录 */
  report: (records: UsageRecordDto | UsageRecordDto[]) => Promise<void>
  /** 立即批量上报待上报记录 */
  flush: () => Promise<void>
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10)
}

// 2026-07-31 减法：当日累计计数器（todayTokensIn 等）与 accumulate/reset 删除——
// 写入后全仓零读取（UI 不展示本地累计），store 只保留"上报队列"这一真实职责。
export const useUsageStore = create<UsageState>()((set, get) => ({
  pendingRecords: [],
  isReporting: false,

  report: async (records) => {
    const list = Array.isArray(records) ? records : [records]
    if (list.length === 0) return

    set((s) => ({ pendingRecords: [...s.pendingRecords, ...list] }))

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
