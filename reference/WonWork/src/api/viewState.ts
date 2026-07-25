/**
 * 对话视图状态持久化（v9.4）：分支快照 / 压缩边界。
 *
 * 独立叶子模块——故意不 import standaloneApi：standaloneApi 依赖链很重
 * （usageStore → usageApi → client → standaloneApi 环，以及 agent/tools 链），
 * chatStore 直接顶层 import 它会改变模块求值顺序、触发 TDZ 白屏。
 * 这里自带最小 IndexedDB 访问，只依赖叶子 util storageScope。
 *
 * 与 standaloneApi 共享同一个 IndexedDB（库名相同、版本一致），
 * object store `conversationViews`（keyPath: 'key'），
 * key 形如 `branches-<convId>` / `compacts-<convId>`。
 */
import { getIndexedDBName } from '@/utils/storageScope'

/** 必须与 standaloneApi.ts 的 DB_VERSION 保持一致（取两者最大值） */
const DB_VERSION = 9
const STORE = 'conversationViews'

interface ViewEntry {
  key: string
  data: unknown
  updatedAt: string
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(getIndexedDBName(), DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      // 本模块只保证自己的 store 存在；其余 store 由 standaloneApi 的升级逻辑创建
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' })
      }
    }
  })
}

export async function viewStateGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await openDB()
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const request = tx.objectStore(STORE).get(key)
      request.onsuccess = () => resolve((request.result as ViewEntry | undefined)?.data as T | undefined)
      request.onerror = () => reject(request.error)
    })
  } catch (err) {
    console.warn('[viewState] read failed:', key, err)
    return undefined
  }
}

/** 写防抖：同一 key 600ms 内多次写只落最后一次（分支切换/快照更新频繁，避免 IO 抖动） */
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>()
export function viewStateSet(key: string, data: unknown): void {
  const existing = writeTimers.get(key)
  if (existing) clearTimeout(existing)
  writeTimers.set(
    key,
    setTimeout(() => {
      writeTimers.delete(key)
      void (async () => {
        try {
          const db = await openDB()
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite')
            const request = tx.objectStore(STORE).put({
              key,
              data,
              updatedAt: new Date().toISOString(),
            } satisfies ViewEntry)
            request.onsuccess = () => resolve()
            request.onerror = () => reject(request.error)
          })
        } catch (err) {
          console.warn('[viewState] persist failed:', key, err)
        }
      })()
    }, 600)
  )
}

export async function viewStateDelete(key: string): Promise<void> {
  const t = writeTimers.get(key)
  if (t) {
    clearTimeout(t)
    writeTimers.delete(key)
  }
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      const request = tx.objectStore(STORE).delete(key)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  } catch (err) {
    console.warn('[viewState] delete failed:', key, err)
  }
}
