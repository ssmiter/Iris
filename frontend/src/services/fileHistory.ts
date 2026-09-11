/**
 * 文件历史检查点（v9.1）：对话分支的"世界状态"支撑
 *
 * claude-code src/utils/fileHistory.ts 同款思想，按 WonWork 前端收敛：
 * - 写前备份（trackFileEdit）：任何经 VFS（fileSystem.writeFile/deleteFile）的改动，
 *   先把旧内容备份到 IndexedDB（首次跟踪记 v1，文件原先不存在则内容为 null）
 * - 每条用户消息提交时打快照（makeFileSnapshot）：记录全部已跟踪文件的当前版本
 * - 编辑重发/切换分支时恢复快照（applyFileSnapshot）：把文件写回锚点时刻的状态，
 *   快照之后新建的文件删除——世界与对话一起回到分支点
 *
 * 诚实边界（与 claude-code "bash 改动不跟踪"同级）：
 * - python 沙箱 / SQL 的副作用发生在后端，前端检查点管不到，由审批流兜底
 * - 超过 1MB 的文件不备份（跳过并标记）
 * - 快照按消息 id 键控，会话重载后由 loadMessages 的分支水合 remap 到新 id
 */
import type { FileEntry } from './workspaceAdapters'

const DB_NAME = 'wonclaw-file-history'
const DB_VERSION = 1
const MAX_SNAPSHOTS_PER_CONV = 100
const MAX_BACKUP_BYTES = 1024 * 1024

interface BackupRec {
  key: string // `${convId}:${hash}@v${version}`
  convId: number
  path: string
  version: number
  /** null = 快照时刻文件不存在（恢复时删除） */
  content: string | null
  encoding: 'utf-8' | 'base64'
  at: number
}

interface SnapshotRec {
  key: string // `${convId}:${messageId}`
  convId: number
  messageId: string
  seq: number
  /** path → 备份版本号 */
  files: Record<string, number>
  at: number
}

// ── IndexedDB 最小封装 ──
let dbPromise: Promise<IDBDatabase> | null = null
function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const d = req.result
        if (!d.objectStoreNames.contains('backups')) d.createObjectStore('backups', { keyPath: 'key' })
        if (!d.objectStoreNames.contains('snapshots')) d.createObjectStore('snapshots', { keyPath: 'key' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

async function idbPut(store: string, value: unknown): Promise<void> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, 'readwrite')
    tx.objectStore(store).put(value)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const req = d.transaction(store, 'readonly').objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

async function idbDelete(store: string, key: string): Promise<void> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, 'readwrite')
    tx.objectStore(store).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function idbAll<T>(store: string): Promise<T[]> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const req = d.transaction(store, 'readonly').objectStore(store).getAll()
    req.onsuccess = () => resolve(req.result as T[])
    req.onerror = () => reject(req.error)
  })
}

/** FNV-1a：备份键的路径散列（与 claude-code 的 sha256(path).slice(0,16) 同用途） */
function hashPath(p: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < p.length; i++) {
    h ^= p.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

// ── 会话上下文与跟踪表 ──
let currentConvId: number | null = null
/** path → { latest: 最新备份版本（0=跳过备份）, firstNull: 首次跟踪时文件不存在 } */
const tracked = new Map<string, { latest: number; firstNull: boolean }>()

/** 由 chatStore 在会话加载/发送时设置；会话切换时清空跟踪表 */
export function setFileHistorySession(convId: number | null): void {
  if (convId !== currentConvId) tracked.clear()
  currentConvId = convId
}

async function readCurrent(path: string): Promise<{ content: string | null; encoding: 'utf-8' | 'base64' }> {
  try {
    // 动态 import 避免与 fileSystem 的循环依赖
    const { readFile } = await import('./fileSystem')
    const entry: FileEntry | undefined = await readFile(path)
    if (!entry) return { content: null, encoding: 'utf-8' }
    return { content: entry.content ?? null, encoding: 'utf-8' }
  } catch {
    return { content: null, encoding: 'utf-8' }
  }
}

/** 写/删前调用（fileSystem 统一入口已挂钩）：首次跟踪时备份旧内容为 v1 */
export async function trackFileEdit(path: string): Promise<void> {
  if (currentConvId == null || tracked.has(path)) return
  const cur = await readCurrent(path)
  if (cur.content !== null && cur.content.length > MAX_BACKUP_BYTES) {
    tracked.set(path, { latest: 0, firstNull: false })
    return
  }
  try {
    await idbPut('backups', {
      key: `${currentConvId}:${hashPath(path)}@v1`,
      convId: currentConvId,
      path,
      version: 1,
      content: cur.content,
      encoding: cur.encoding,
      at: Date.now(),
    } satisfies BackupRec)
    tracked.set(path, { latest: 1, firstNull: cur.content === null })
  } catch {
    // IDB 不可用时静默跳过（检查点是增强而非阻塞）
  }
}

/** 用户消息提交时打快照：所有已跟踪文件若内容有变化则写新备份版本 */
export async function makeFileSnapshot(messageId: string): Promise<void> {
  if (currentConvId == null || tracked.size === 0) return
  const files: Record<string, number> = {}
  for (const [path, meta] of tracked) {
    if (meta.latest === 0) continue
    const cur = await readCurrent(path)
    const prev = await idbGet<BackupRec>('backups', `${currentConvId}:${hashPath(path)}@v${meta.latest}`)
    if ((prev?.content ?? null) !== cur.content) {
      const v = meta.latest + 1
      try {
        await idbPut('backups', {
          key: `${currentConvId}:${hashPath(path)}@v${v}`,
          convId: currentConvId,
          path,
          version: v,
          content: cur.content,
          encoding: cur.encoding,
          at: Date.now(),
        } satisfies BackupRec)
        meta.latest = v
      } catch {
        continue
      }
    }
    files[path] = meta.latest
  }
  try {
    await idbPut('snapshots', {
      key: `${currentConvId}:${messageId}`,
      convId: currentConvId,
      messageId,
      seq: Date.now(),
      files,
      at: Date.now(),
    } satisfies SnapshotRec)
    await pruneSnapshots(currentConvId)
  } catch {
    // 静默
  }
}

/**
 * 恢复快照：快照内文件写回记录版本（内容 null → 删除）；
 * 快照之后才首次跟踪且原本不存在的文件 → 删除（真正回到锚点时刻）。
 * @returns 恢复/删除的文件数
 */
export async function applyFileSnapshot(messageId: string): Promise<number> {
  if (currentConvId == null) return 0
  const snap = await idbGet<SnapshotRec>('snapshots', `${currentConvId}:${messageId}`)
  if (!snap) return 0
  const { writeFile, deleteFile } = await import('./fileSystem')
  let restored = 0
  for (const [path, version] of Object.entries(snap.files)) {
    const rec = await idbGet<BackupRec>('backups', `${currentConvId}:${hashPath(path)}@v${version}`)
    if (!rec) continue
    try {
      if (rec.content === null) await deleteFile(path)
      else await writeFile(path, rec.content, { encoding: rec.encoding })
      restored++
    } catch {
      // 单个文件失败不阻塞其余
    }
  }
  for (const [path, meta] of tracked) {
    if (path in snap.files || !meta.firstNull || meta.latest === 0) continue
    try {
      await deleteFile(path)
      restored++
    } catch {
      // 静默
    }
  }
  return restored
}

/** 会话重载后消息 id 重生成：把快照迁移到新锚点 id（保持文件回滚可用） */
export async function remapSnapshot(oldMessageId: string, newMessageId: string): Promise<void> {
  if (currentConvId == null || oldMessageId === newMessageId) return
  const snap = await idbGet<SnapshotRec>('snapshots', `${currentConvId}:${oldMessageId}`)
  if (!snap) return
  try {
    await idbPut('snapshots', { ...snap, key: `${currentConvId}:${newMessageId}`, messageId: newMessageId })
  } catch {
    // 静默
  }
}

async function pruneSnapshots(convId: number): Promise<void> {
  try {
    const all = (await idbAll<SnapshotRec>('snapshots'))
      .filter((s) => s.convId === convId)
      .sort((a, b) => a.seq - b.seq)
    if (all.length <= MAX_SNAPSHOTS_PER_CONV) return
    const stale = all.slice(0, all.length - MAX_SNAPSHOTS_PER_CONV)
    await Promise.all(stale.map((s) => idbDelete('snapshots', s.key)))
  } catch {
    // 静默
  }
}
