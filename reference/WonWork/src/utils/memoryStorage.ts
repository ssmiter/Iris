import type { MemoryConfig, MemoryEntry } from '@/types/memory'
import { createMemoryConfig } from '@/types/memory'
import { getWorkspaceState, readWorkspaceFile, writeWorkspaceFile } from './workspaceStorage'

const MEMORY_FILE = 'memory/entries.json'
const MEMORY_CONFIG_FILE = 'memory/config.json'
const FALLBACK_DB_NAME = 'wonclaw-memory-fallback'
const FALLBACK_DB_VERSION = 1
const FALLBACK_STORE = 'memoryData'
const FALLBACK_KEY = 'main'

interface MemoryFileData {
  version: number
  config: MemoryConfig
  entries: MemoryEntry[]
  last_consolidated_at: string | null
}

const CURRENT_VERSION = 1

function openFallbackDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FALLBACK_DB_NAME, FALLBACK_DB_VERSION)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(FALLBACK_STORE)) {
        db.createObjectStore(FALLBACK_STORE)
      }
    }
  })
}

async function fallbackGet<T>(key: string): Promise<T | undefined> {
  const db = await openFallbackDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FALLBACK_STORE, 'readonly')
    const store = tx.objectStore(FALLBACK_STORE)
    const req = store.get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

async function fallbackSet(key: string, value: unknown): Promise<void> {
  const db = await openFallbackDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FALLBACK_STORE, 'readwrite')
    const store = tx.objectStore(FALLBACK_STORE)
    const req = store.put(value, key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

function defaultData(): MemoryFileData {
  return {
    version: CURRENT_VERSION,
    config: createMemoryConfig('standard'),
    entries: [],
    last_consolidated_at: null,
  }
}

async function loadFromWorkspace(): Promise<MemoryFileData | null> {
  const { isConnected, isFallbackMode } = getWorkspaceState()
  if (!isConnected || isFallbackMode) return null

  try {
    const raw = await readWorkspaceFile(MEMORY_FILE)
    if (!raw) return null
    const parsed = JSON.parse(raw) as MemoryFileData
    return {
      ...defaultData(),
      ...parsed,
      entries: parsed.entries || [],
      config: { ...createMemoryConfig('standard'), ...(parsed.config || {}) },
    }
  } catch (err) {
    console.warn('[memoryStorage] load workspace failed:', err)
    return null
  }
}

async function saveToWorkspace(data: MemoryFileData): Promise<void> {
  const { isConnected, isFallbackMode } = getWorkspaceState()
  if (!isConnected || isFallbackMode) {
    throw new Error('[memoryStorage] workspace not connected')
  }
  try {
    await writeWorkspaceFile(MEMORY_FILE, JSON.stringify(data, null, 2))
  } catch (err) {
    console.error('[memoryStorage] save workspace failed:', err)
    throw err
  }
}

async function loadFromFallback(): Promise<MemoryFileData | null> {
  try {
    const saved = await fallbackGet<MemoryFileData>(FALLBACK_KEY)
    if (!saved) return null
    return {
      ...defaultData(),
      ...saved,
      entries: saved.entries || [],
      config: { ...createMemoryConfig('standard'), ...(saved.config || {}) },
    }
  } catch (err) {
    console.warn('[memoryStorage] load fallback failed:', err)
    return null
  }
}

async function saveToFallback(data: MemoryFileData): Promise<void> {
  try {
    await fallbackSet(FALLBACK_KEY, data)
  } catch (err) {
    console.error('[memoryStorage] save fallback failed:', err)
    throw err
  }
}

export async function loadMemoryData(): Promise<{
  entries: MemoryEntry[]
  config: MemoryConfig
  last_consolidated_at: string | null
  source: 'workspace' | 'fallback' | 'default'
}> {
  const workspace = await loadFromWorkspace()
  if (workspace) {
    return {
      entries: workspace.entries,
      config: workspace.config,
      last_consolidated_at: workspace.last_consolidated_at,
      source: 'workspace',
    }
  }

  const fallback = await loadFromFallback()
  if (fallback) {
    return {
      entries: fallback.entries,
      config: fallback.config,
      last_consolidated_at: fallback.last_consolidated_at,
      source: 'fallback',
    }
  }

  return {
    entries: [],
    config: createMemoryConfig('standard'),
    last_consolidated_at: null,
    source: 'default',
  }
}

export async function saveMemoryData(
  entries: MemoryEntry[],
  config: MemoryConfig,
  last_consolidated_at: string | null
): Promise<'saved' | 'fallback' | 'failed'> {
  const data: MemoryFileData = {
    version: CURRENT_VERSION,
    config,
    entries,
    last_consolidated_at,
  }

  const { isConnected, isFallbackMode } = getWorkspaceState()
  if (isConnected && !isFallbackMode) {
    try {
      await saveToWorkspace(data)
      return 'saved'
    } catch {
      // 工作区写入失败，尝试 fallback
    }
  }

  try {
    await saveToFallback(data)
    return 'fallback'
  } catch (err) {
    console.error('[memoryStorage] all save strategies failed:', err)
    return 'failed'
  }
}

export function clearLegacyMemoryStorage(): void {
  try {
    localStorage.removeItem('wonclaw-memory')
  } catch {
    // ignore
  }
}

export function isMemoryStorageAvailable(): boolean {
  const { isConnected, isFallbackMode } = getWorkspaceState()
  return isConnected || isFallbackMode || typeof indexedDB !== 'undefined'
}
