/**
 * WonWork 重试工具
 *
 * 用于 SSE/fetch 请求层重试：网络抖动、超时、5xx 时自动重发同一请求。
 * 4xx 客户端错误不重试（429 rate limit 除外）。
 */

export interface RetryOptions {
  /** 最大重试次数，默认 2 */
  maxRetries?: number
  /** 初始退避时间（毫秒），默认 500 */
  baseDelayMs?: number
  /** 最大退避时间（毫秒），默认 5000 */
  maxDelayMs?: number
  /** 退避乘数，默认 2 */
  backoffMultiplier?: number
  /** 自定义是否可重试的判断 */
  shouldRetry?: (error: unknown, attempt: number) => boolean
}

export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly cause: unknown,
    public readonly attempt: number
  ) {
    super(message)
    this.name = 'RetryableError'
  }
}

/**
 * 判断错误是否值得重试。
 * 默认规则：
 * - fetch 网络错误（TypeError）可重试
 * - 5xx 可重试
 * - 429 rate limit 可重试
 * - 4xx 不重试
 * - AbortError 不重试
 */
export function defaultShouldRetry(error: unknown, _attempt: number): boolean {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return false

    // fetch 网络错误（离线、DNS、TCP 失败等）
    if (error instanceof TypeError) return true

    // HTTP 状态判断
    const status = (error as { status?: number }).status
    if (typeof status === 'number') {
      if (status >= 500 && status < 600) return true
      if (status === 429) return true
      if (status >= 400 && status < 500) return false
    }
  }

  // 未知错误默认不重试
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function calculateDelay(attempt: number, options: RetryOptions): number {
  const base = options.baseDelayMs ?? 500
  const multiplier = options.backoffMultiplier ?? 2
  const max = options.maxDelayMs ?? 5000
  const delay = base * Math.pow(multiplier, attempt - 1)
  return Math.min(delay, max)
}

/**
 * 执行一个可重试的异步函数。
 * @param fn 要执行的函数
 * @param options 重试配置
 * @returns fn 的返回值
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 2
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn(attempt)
    } catch (error) {
      const isLastAttempt = attempt > maxRetries
      if (isLastAttempt || !shouldRetry(error, attempt)) {
        throw error
      }
      const delay = calculateDelay(attempt, options)
      await sleep(delay)
    }
  }

  throw new Error('Retry loop exited unexpectedly')
}
