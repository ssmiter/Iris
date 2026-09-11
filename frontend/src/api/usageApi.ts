/**
 * 用量上报（Iris 本地版收敛，2026-09）。
 * WonWork 的 online/mescli/standalone 三态分派已删除：Iris 恒为本地运行时，
 * 后端无 /api/usage/report 端点，用量记录只暂存到本地 localStorage。
 */
import type { UsageRecordDto } from '@/types/mescli'

const USAGE_STORAGE_KEY = 'wonwork_usage_records'
const MAX_STORED_RECORDS = 1000

function readStoredRecords(): UsageRecordDto[] {
  const raw = localStorage.getItem(USAGE_STORAGE_KEY)
  if (!raw) return []
  try {
    return JSON.parse(raw) as UsageRecordDto[]
  } catch {
    return []
  }
}

function saveStoredRecords(records: UsageRecordDto[]): void {
  localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(records.slice(-MAX_STORED_RECORDS)))
}

export const usageApi = {
  report: async (records: UsageRecordDto[]): Promise<{ success: boolean }> => {
    if (records.length === 0) return { success: true }
    await new Promise((resolve) => setTimeout(resolve, 100))
    const stored = readStoredRecords()
    saveStoredRecords([...stored, ...records])
    return { success: true }
  },
}

export { readStoredRecords, saveStoredRecords }
