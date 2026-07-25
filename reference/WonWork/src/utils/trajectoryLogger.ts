/**
 * WonWork 轨迹日志系统
 * 记录 chat / dag / webbridge / workflow 等各类执行过程
 * Standalone 模式写入 IndexedDB，MESCLI 模式优先调用后端接口
 */

export type TrajectoryType = 'chat' | 'dag' | 'webbridge' | 'workflow' | 'tool'

export type TrajectoryPhaseStatus = 'running' | 'completed' | 'error' | 'skipped'

export interface TrajectoryPhase {
  id: string
  name: string
  status: TrajectoryPhaseStatus
  startedAt: number
  endedAt?: number
  durationMs?: number
  input?: unknown
  output?: unknown
  error?: string
  metadata?: Record<string, unknown>
}

export interface TrajectoryTrace {
  id: string
  type: TrajectoryType
  input: string
  summary?: string
  model?: string
  provider?: string
  phases: TrajectoryPhase[]
  status: 'running' | 'completed' | 'error'
  startedAt: number
  endedAt?: number
  durationMs?: number
  error?: string
  metadata?: Record<string, unknown>
}

// ==================== IndexedDB 工具 ====================

const DB_NAME = 'WonWorkDB'
const DB_VERSION = 1
const STORE_NAME = 'trajectories'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
  })
}

async function saveToIndexedDB(trace: TrajectoryTrace): Promise<void> {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    store.put(trace)
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch (err) {
    console.error('[TrajectoryLogger] IndexedDB 写入失败:', err)
  }
}

async function getAllFromIndexedDB(): Promise<TrajectoryTrace[]> {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const request = store.getAll()
    const result = await new Promise<TrajectoryTrace[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as TrajectoryTrace[])
      request.onerror = () => reject(request.error)
    })
    db.close()
    return result
  } catch (err) {
    console.error('[TrajectoryLogger] IndexedDB 读取失败:', err)
    return []
  }
}

async function clearIndexedDB(): Promise<void> {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    store.clear()
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch (err) {
    console.error('[TrajectoryLogger] IndexedDB 清空失败:', err)
  }
}

// ==================== MESCLI 后端接口 ====================

import { isLocalRuntime, isWebsiteOnline } from '@/utils/runtimeMode'

const IS_STANDALONE = import.meta.env.VITE_STANDALONE_MODE === 'true'
const API_BASE = import.meta.env.VITE_API_BASE_URL || ''

// 2026-07-24：当前 AIGateway 并未实现 /api/trajectory（各通道均无此控制器），404 属预期。
// 首次收到 404 后闩锁为 false，本会话不再尝试后端，避免 Network 面板持续报红。
let backendEndpointAvailable = true

async function saveToBackend(trace: TrajectoryTrace): Promise<boolean> {
  if (!backendEndpointAvailable) return false
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    const token = localStorage.getItem('wonclaw_token')
    if (token) headers['Authorization'] = `Bearer ${token}`

    const response = await fetch(`${API_BASE}/api/trajectory`, {
      method: 'POST',
      headers,
      body: JSON.stringify(trace),
      credentials: 'include',
    })
    if (response.status === 404) {
      backendEndpointAvailable = false
      return false
    }
    return response.ok
  } catch (err) {
    console.warn('[TrajectoryLogger] 后端接口调用失败，降级到 IndexedDB:', err)
    return false
  }
}

// ==================== TrajectoryLogger 类 ====================

let _traceIdCounter = 0
function generateTraceId(): string {
  _traceIdCounter++
  return `trace-${Date.now()}-${_traceIdCounter}-${Math.random().toString(36).slice(2, 5)}`
}

function generatePhaseId(): string {
  return `phase-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`
}

export class TrajectoryLogger {
  private trace: TrajectoryTrace | null = null

  startTrace(input: string, type: TrajectoryType = 'chat', metadata?: Record<string, unknown>): TrajectoryTrace {
    const trace: TrajectoryTrace = {
      id: generateTraceId(),
      type,
      input,
      phases: [],
      status: 'running',
      startedAt: Date.now(),
      metadata,
    }
    this.trace = trace
    return trace
  }

  addPhase(
    name: string,
    options?: {
      input?: unknown
      output?: unknown
      status?: TrajectoryPhaseStatus
      error?: string
      metadata?: Record<string, unknown>
    }
  ): TrajectoryPhase {
    if (!this.trace) {
      throw new Error('TrajectoryLogger: 未调用 startTrace 就尝试 addPhase')
    }
    const phase: TrajectoryPhase = {
      id: generatePhaseId(),
      name,
      status: options?.status || 'running',
      startedAt: Date.now(),
      input: options?.input,
      output: options?.output,
      error: options?.error,
      metadata: options?.metadata,
    }
    this.trace.phases.push(phase)
    return phase
  }

  completePhase(phaseId: string, output?: unknown, error?: string): void {
    if (!this.trace) return
    const phase = this.trace.phases.find((p) => p.id === phaseId)
    if (!phase) return
    phase.endedAt = Date.now()
    phase.durationMs = phase.endedAt - phase.startedAt
    phase.status = error ? 'error' : 'completed'
    if (output !== undefined) phase.output = output
    if (error) phase.error = error
  }

  complete(summary?: string, metadata?: Record<string, unknown>): TrajectoryTrace {
    if (!this.trace) {
      throw new Error('TrajectoryLogger: 未调用 startTrace 就尝试 complete')
    }
    this.trace.endedAt = Date.now()
    this.trace.durationMs = this.trace.endedAt - this.trace.startedAt
    this.trace.status = 'completed'
    if (summary) this.trace.summary = summary
    if (metadata) this.trace.metadata = { ...this.trace.metadata, ...metadata }

    // 自动补全未关闭的 phase
    for (const phase of this.trace.phases) {
      if (phase.status === 'running') {
        phase.endedAt = this.trace.endedAt
        phase.durationMs = phase.endedAt - phase.startedAt
        phase.status = 'completed'
      }
    }

    const result = this.trace
    this.persist(result)
    this.trace = null
    return result
  }

  fail(error: string | Error, summary?: string): TrajectoryTrace {
    if (!this.trace) {
      throw new Error('TrajectoryLogger: 未调用 startTrace 就尝试 fail')
    }
    this.trace.endedAt = Date.now()
    this.trace.durationMs = this.trace.endedAt - this.trace.startedAt
    this.trace.status = 'error'
    this.trace.error = error instanceof Error ? error.message : error
    if (summary) this.trace.summary = summary

    // 自动补全未关闭的 phase
    for (const phase of this.trace.phases) {
      if (phase.status === 'running') {
        phase.endedAt = this.trace.endedAt
        phase.durationMs = phase.endedAt - phase.startedAt
        phase.status = 'error'
        phase.error = this.trace.error
      }
    }

    const result = this.trace
    this.persist(result)
    this.trace = null
    return result
  }

  getCurrentTrace(): TrajectoryTrace | null {
    return this.trace
  }

  private async persist(trace: TrajectoryTrace): Promise<void> {
    // 2026-07-24：轨迹记录整体关停（产品决定暂不需要）。后端 /api/trajectory 本就未实现，
    // IndexedDB 写入也只是无效占用。startTrace/addPhase 保持内存行为不变（调用方无需改），
    // 仅落盘这一步短路。需要恢复时把下面这行删掉即可。
    if (trace) return
    // 运行时判断：本地模式（Standalone / MESCLI-Local）或 website-online 只写入 IndexedDB，
    // 避免向可能未实现该接口的 MESCLI Local / 外部 AIGateway 后端发送 404 请求。
    if (IS_STANDALONE || isLocalRuntime() || isWebsiteOnline()) {
      await saveToIndexedDB(trace)
    } else {
      const success = await saveToBackend(trace)
      if (!success) {
        await saveToIndexedDB(trace)
      }
    }
  }
}

// ==================== 便捷工厂函数 ====================

export function createTrajectoryLogger(): TrajectoryLogger {
  return new TrajectoryLogger()
}

// ==================== 全局访问对象 ====================

interface TrajectoryGlobalAPI {
  getAll(): Promise<TrajectoryTrace[]>
  getRecent(limit: number): Promise<TrajectoryTrace[]>
  clear(): Promise<void>
}

function initGlobalAPI(): TrajectoryGlobalAPI {
  return {
    async getAll(): Promise<TrajectoryTrace[]> {
      return getAllFromIndexedDB()
    },
    async getRecent(limit: number): Promise<TrajectoryTrace[]> {
      const all = await getAllFromIndexedDB()
      return all
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, limit)
    },
    async clear(): Promise<void> {
      await clearIndexedDB()
    },
  }
}

// 导出类型供外部使用（通过 interface 隐式导出）
export type { TrajectoryGlobalAPI }

// 挂载到 window（在浏览器环境中）
if (typeof window !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).__WonWork_trajectories__ = initGlobalAPI()
}
