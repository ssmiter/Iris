import { isMescli, isOnline } from '@/config/product'
import { isLocalRuntime, isWebsiteOnline } from '@/utils/runtimeMode'
import { fetchApi } from './client'
import type { UsageRecordDto, ReportUsageRequest } from '@/types/mescli'

const USAGE_STORAGE_KEY = 'wonwork_usage_records'
const MAX_STORED_RECORDS = 1000

function getStorageKey(): string {
  return isWebsiteOnline() ? 'wonwork_website_usage_records' : USAGE_STORAGE_KEY
}

function readStoredRecords(): UsageRecordDto[] {
  const raw = localStorage.getItem(getStorageKey())
  if (!raw) return []
  try {
    return JSON.parse(raw) as UsageRecordDto[]
  } catch {
    return []
  }
}

function saveStoredRecords(records: UsageRecordDto[]): void {
  localStorage.setItem(getStorageKey(), JSON.stringify(records.slice(-MAX_STORED_RECORDS)))
}

// ==================== MESCLI / Online 实现 ====================

const backendUsageApi = {
  /** POST /api/usage/report */
  report: async (records: UsageRecordDto[]): Promise<{ success: boolean }> => {
    if (records.length === 0) return { success: true }
    // 2026-07-24：当前 AIGateway 并未实现 /api/usage/report（各通道均无此控制器），
    // 404 属预期而非故障。silent 避免后台统计请求弹错误 Toast 骚扰用户；
    // 失败时降级本地暂存，数据不丢。后端若以后实现该端点，此处无需改动即可恢复上报。
    try {
      return await fetchApi<{ success: boolean }>('/api/usage/report', {
        method: 'POST',
        body: JSON.stringify({ records } satisfies ReportUsageRequest),
        silent: true,
      })
    } catch {
      return localUsageApi.report(records)
    }
  },
}

// ==================== 本地暂存实现（Standalone / MESCLI-Local） ====================

const localUsageApi = {
  report: async (records: UsageRecordDto[]): Promise<{ success: boolean }> => {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const stored = readStoredRecords()
    saveStoredRecords([...stored, ...records])
    return { success: true }
  },
}

export const usageApi = {
  report: async (records: UsageRecordDto[]): Promise<{ success: boolean }> => {
    // 运行时判断：本地模式或 website-online 不调用后端 usage 上报接口，避免 404 Toast。
    if (isLocalRuntime() || isWebsiteOnline()) {
      return localUsageApi.report(records)
    }
    return backendUsageApi.report(records)
  },
}

export { readStoredRecords, saveStoredRecords }
