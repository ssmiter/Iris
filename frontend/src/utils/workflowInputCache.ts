/**
 * 工作流输入参数最近值缓存
 * 按 workflowId + fieldName 维度缓存用户最近一次运行工作流时使用的输入值
 */

const STORAGE_KEY = 'wonwork.workflowInputRecentValues'

interface CacheData {
  version: 1
  values: Record<string, unknown>
}

function readCache(): CacheData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { version: 1, values: {} }
    const parsed = JSON.parse(raw) as CacheData
    if (parsed && typeof parsed === 'object' && parsed.version === 1 && typeof parsed.values === 'object') {
      return parsed
    }
  } catch {
    // ignore
  }
  return { version: 1, values: {} }
}

function writeCache(data: CacheData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    // ignore: quota exceeded or storage disabled
  }
}

function buildKey(workflowId: string, fieldName: string): string {
  return `${workflowId}::${fieldName}`
}

export function getRecentValue(workflowId: string, fieldName: string): unknown | undefined {
  const cache = readCache()
  return cache.values[buildKey(workflowId, fieldName)]
}

export function setRecentValue(workflowId: string, fieldName: string, value: unknown): void {
  const cache = readCache()
  cache.values[buildKey(workflowId, fieldName)] = value
  writeCache(cache)
}

export function clearRecentValues(workflowId: string): void {
  const cache = readCache()
  const prefix = `${workflowId}::`
  for (const key of Object.keys(cache.values)) {
    if (key.startsWith(prefix)) {
      delete cache.values[key]
    }
  }
  writeCache(cache)
}

export function getAllRecentValues(workflowId: string): Record<string, unknown> {
  const cache = readCache()
  const prefix = `${workflowId}::`
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(cache.values)) {
    if (key.startsWith(prefix)) {
      const fieldName = key.slice(prefix.length)
      result[fieldName] = value
    }
  }
  return result
}
