/**
 * 可重试的流式请求执行器。
 *
 * 职责：
 * - 在首次 chunk 到达前，对可重试错误（网络抖动、5xx、429 等）进行指数退避重试
 * - 流式失败后（未发出任何 chunk 时）可选切到非流式兜底
 * - 暴露统一的 abort 接口，中断当前正在进行的请求或重试等待
 *
 * 设计约束：
 * - 一旦已经发出过 chunk，就不再重试整个流，避免内容重复
 * - 非流式兜底只执行一次，失败时直接抛错给上层
 */

import { type RetryOptions, defaultShouldRetry } from '@/utils/retry'
import type { ModelClientStreamCallbacks } from './modelClient'
import { StreamIdleError } from './modelErrors'

export interface StreamAttempt {
  /** 中断本次尝试 */
  abort: () => void
  /** 本次尝试完成的 Promise */
  finished: Promise<void>
}

export interface RetryableStreamOptions {
  /** 发起一次流式请求 */
  start: (callbacks: ModelClientStreamCallbacks) => StreamAttempt
  /** 可选：流式全部失败后切到非流式兜底 */
  fallback?: (callbacks: ModelClientStreamCallbacks) => StreamAttempt
  /** 重试配置 */
  retryOptions?: RetryOptions
  /** 用户回调 */
  callbacks: ModelClientStreamCallbacks
  /**
   * 流空闲超时（毫秒）。
   * 在收到第一个 chunk 前或两次 chunk 之间超过此时间，将自动中断当前尝试并触发重试。
   * 默认 90000ms（90s）。
   */
  idleTimeoutMs?: number
}

interface AbortableSleeper {
  sleep: (ms: number) => Promise<void>
  abort: () => void
}

function createAbortableSleeper(): AbortableSleeper {
  let rejectSleep: (() => void) | undefined
  return {
    sleep(ms: number): Promise<void> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        rejectSleep = () => {
          clearTimeout(timer)
          rejectSleep = undefined
          reject(new Error('Aborted'))
        }
      })
    },
    abort(): void {
      rejectSleep?.()
    },
  }
}

export function createRetryableStream(options: RetryableStreamOptions): StreamAttempt {
  const { start, fallback, retryOptions, callbacks, idleTimeoutMs } = options
  const maxRetries = retryOptions?.maxRetries ?? 2
  const customShouldRetry = retryOptions?.shouldRetry
  const effectiveIdleTimeoutMs = idleTimeoutMs ?? 90_000

  let emittedAnyChunk = false
  let aborted = false
  let idleTimedOut = false
  let currentAttemptAbort: (() => void) | undefined
  let currentSleeper: AbortableSleeper | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  const wrappedCallbacks: ModelClientStreamCallbacks = {
    onChunk: (chunk) => {
      emittedAnyChunk = true
      resetIdleTimer()
      callbacks.onChunk(chunk)
    },
    onError: (error) => {
      clearIdleTimer()
      callbacks.onError(error)
    },
    onDone: () => {
      clearIdleTimer()
      callbacks.onDone()
    },
  }

  function resetIdleTimer(): void {
    if (aborted) return
    clearIdleTimer()
    idleTimer = setTimeout(() => {
      // 流长时间无响应，主动中断当前尝试；外层会按重试策略处理
      idleTimedOut = true
      currentAttemptAbort?.()
    }, effectiveIdleTimeoutMs)
  }

  function clearIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
  }

  function shouldRetry(error: unknown, attempt: number): boolean {
    if (aborted || emittedAnyChunk) return false
    if (customShouldRetry) return customShouldRetry(error, attempt)
    return defaultShouldRetry(error, attempt)
  }

  async function run(): Promise<void> {
    let lastError: unknown

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      if (aborted) return

      try {
        const streamAttempt = start(wrappedCallbacks)
        currentAttemptAbort = streamAttempt.abort
        resetIdleTimer()
        await streamAttempt.finished
        // 正常结束
        return
      } catch (error) {
        if (idleTimedOut) {
          idleTimedOut = false
          lastError = new StreamIdleError()
        } else {
          lastError = error
        }
        currentAttemptAbort = undefined
        clearIdleTimer()

        if (aborted) return
        const isLastAttempt = attempt > maxRetries
        const canRetry =
          lastError instanceof StreamIdleError || shouldRetry(lastError, attempt)
        if (isLastAttempt || !canRetry) {
          break
        }

        // 指数退避等待
        const base = retryOptions?.baseDelayMs ?? 500
        const multiplier = retryOptions?.backoffMultiplier ?? 2
        const max = retryOptions?.maxDelayMs ?? 5000
        const delay = Math.min(base * Math.pow(multiplier, attempt - 1), max)

        currentSleeper = createAbortableSleeper()
        try {
          await currentSleeper.sleep(delay)
        } catch {
          // 等待期间被 abort
          return
        } finally {
          currentSleeper = undefined
        }
      }
    }

    if (aborted) return

    // 流式全部失败，尝试非流式兜底（仅在未发出任何 chunk 时，避免内容重复）
    if (!emittedAnyChunk && fallback) {
      try {
        const fallbackAttempt = fallback(wrappedCallbacks)
        currentAttemptAbort = fallbackAttempt.abort
        clearIdleTimer()
        await fallbackAttempt.finished
        return
      } catch (error) {
        currentAttemptAbort = undefined
        callbacks.onError(error instanceof Error ? error : new Error(String(error)))
        return
      }
    }

    if (lastError !== undefined) {
      callbacks.onError(lastError instanceof Error ? lastError : new Error(String(lastError)))
    }
  }

  const finished = run().then(() => {
    // 确保即使 run 正常返回，也清理状态
    currentAttemptAbort = undefined
    clearIdleTimer()
  })

  return {
    abort(): void {
      if (aborted) return
      aborted = true
      clearIdleTimer()
      currentAttemptAbort?.()
      currentSleeper?.abort()
    },
    finished,
  }
}
