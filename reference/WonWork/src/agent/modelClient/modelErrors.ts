import {
  isAbortError,
  isContextLengthError,
  isInvalidModelError,
  isNetworkError,
  isRateLimitError,
  isToolUseMismatchError,
} from '@/utils/error'

/**
 * 模型调用层错误码。
 *
 * 用于在 Agentic 循环中按错误类型驱动恢复路径，并生成面向用户的中文提示。
 */
export type ModelErrorCode =
  | 'RATE_LIMIT'
  | 'CONTEXT_LENGTH'
  | 'INVALID_MODEL'
  | 'AUTH'
  | 'FORBIDDEN'
  | 'INSUFFICIENT_QUOTA'
  | 'STREAM_IDLE'
  | 'NETWORK'
  | 'SERVER_ERROR'
  | 'TIMEOUT'
  | 'TOOL_USE_MISMATCH'
  | 'UNKNOWN'

export interface ModelErrorInfo {
  code: ModelErrorCode
  /** 给用户看的中文提示 */
  message: string
  /** 是否适合自动重试 */
  isRetryable: boolean
  /** 原始错误对象 */
  originalError: unknown
  /** HTTP 状态码（如果有） */
  status?: number
}

/** 流空闲超时：长时间未收到任何 chunk */
export class StreamIdleError extends Error {
  readonly code: ModelErrorCode = 'STREAM_IDLE'
  readonly isRetryable = true
  constructor(message = 'AI 服务响应超时，长时间未收到数据') {
    super(message)
    this.name = 'StreamIdleError'
  }
}

/** 从错误对象中提取 HTTP 状态码 */
function extractStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const status = (error as { status?: number }).status
    if (typeof status === 'number') return status
  }
  return undefined
}

/** 判断是否为 Provider 配置错误（API Key 未配置 / Provider 未知等），避免误报为模型不可用 */
function isProviderConfigError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  const lower = msg.toLowerCase()
  return (
    lower.includes('未配置 api key') ||
    lower.includes('unknown provider') ||
    lower.includes('failed to resolve provider configuration') ||
    lower.includes('api key') && lower.includes('未配置') ||
    lower.includes('请在设置中为 provider') ||
    lower.includes('请在设置中填写')
  )
}

/** 判断是否为认证错误（401 / 403 / 凭证相关） */
function isAuthError(error: unknown): boolean {
  const status = extractStatus(error)
  if (status === 401 || status === 403) return true
  const msg = error instanceof Error ? error.message : String(error)
  const lower = msg.toLowerCase()
  return (
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('invalid api key') ||
    lower.includes('invalid x-api-key') ||
    lower.includes('认证失败') ||
    lower.includes('api key 无效') ||
    lower.includes('api key 已过期')
  )
}

/** 判断是否为服务器错误（5xx） */
function isServerError(error: unknown): boolean {
  const status = extractStatus(error)
  if (status && status >= 500 && status < 600) return true
  const msg = error instanceof Error ? error.message : String(error)
  return msg.toLowerCase().includes('internal server error')
}

/** 判断是否为超时错误（408 / GATEWAY_TIMEOUT / fetch timeout） */
function isTimeoutError(error: unknown): boolean {
  const status = extractStatus(error)
  if (status === 408 || status === 504) return true
  if (isAbortError(error)) return false // AbortError 单独处理
  const msg = error instanceof Error ? error.message : String(error)
  const lower = msg.toLowerCase()
  return lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout')
}

const ERROR_CODE_MESSAGES: Record<ModelErrorCode, string> = {
  RATE_LIMIT: '请求过于频繁，请稍后再试',
  CONTEXT_LENGTH: '上下文长度超出模型限制，已尝试自动压缩',
  INVALID_MODEL: '当前模型不可用，请尝试切换其他模型',
  AUTH: '认证失败，请检查 API Key 或重新登录',
  FORBIDDEN: '没有权限执行此操作，请检查账户或套餐',
  INSUFFICIENT_QUOTA: 'API 额度不足，请检查账户余额或更换 API Key',
  STREAM_IDLE: 'AI 服务响应超时，请检查网络或稍后重试',
  NETWORK: '网络连接失败，请检查网络或稍后重试',
  SERVER_ERROR: 'AI 服务暂时不可用，请稍后再试',
  TIMEOUT: '请求超时，请稍后重试',
  TOOL_USE_MISMATCH: '工具调用格式不匹配，请重试',
  UNKNOWN: 'AI 服务请求失败，请稍后重试',
}

/**
 * 对模型调用相关错误进行分类。
 *
 * 优先按状态码判断，其次按错误消息文本匹配。
 */
export function classifyModelError(error: unknown): ModelErrorInfo {
  if (error instanceof StreamIdleError) {
    return {
      code: 'STREAM_IDLE',
      message: ERROR_CODE_MESSAGES.STREAM_IDLE,
      isRetryable: true,
      originalError: error,
    }
  }

  if (isAbortError(error)) {
    return {
      code: 'UNKNOWN',
      message: '请求已取消',
      isRetryable: false,
      originalError: error,
    }
  }

  if (isRateLimitError(error)) {
    return {
      code: 'RATE_LIMIT',
      message: ERROR_CODE_MESSAGES.RATE_LIMIT,
      isRetryable: true,
      originalError: error,
      status: extractStatus(error),
    }
  }

  if (isContextLengthError(error)) {
    return {
      code: 'CONTEXT_LENGTH',
      message: ERROR_CODE_MESSAGES.CONTEXT_LENGTH,
      isRetryable: false,
      originalError: error,
      status: extractStatus(error),
    }
  }

  // 配置类错误优先于模型不可用判断，避免 API Key / Provider 未配置被误报为"模型不可用"
  if (isProviderConfigError(error)) {
    const msg = error instanceof Error ? error.message : String(error)
    return {
      code: 'AUTH',
      message: msg || 'AI 服务配置异常，请检查 API Key 或 Provider 设置',
      isRetryable: false,
      originalError: error,
      status: extractStatus(error),
    }
  }

  if (isInvalidModelError(error)) {
    const msg = error instanceof Error ? error.message : String(error)
    return {
      code: 'INVALID_MODEL',
      message: msg || ERROR_CODE_MESSAGES.INVALID_MODEL,
      isRetryable: false,
      originalError: error,
      status: extractStatus(error),
    }
  }

  if (isAuthError(error)) {
    const status = extractStatus(error)
    return {
      code: status === 403 ? 'FORBIDDEN' : 'AUTH',
      message: ERROR_CODE_MESSAGES[status === 403 ? 'FORBIDDEN' : 'AUTH'],
      isRetryable: false,
      originalError: error,
      status,
    }
  }

  if (isInsufficientQuotaError(error)) {
    return {
      code: 'INSUFFICIENT_QUOTA',
      message: ERROR_CODE_MESSAGES.INSUFFICIENT_QUOTA,
      isRetryable: false,
      originalError: error,
      status: extractStatus(error),
    }
  }

  if (isToolUseMismatchError(error)) {
    return {
      code: 'TOOL_USE_MISMATCH',
      message: ERROR_CODE_MESSAGES.TOOL_USE_MISMATCH,
      isRetryable: true,
      originalError: error,
      status: extractStatus(error),
    }
  }

  if (isTimeoutError(error)) {
    return {
      code: 'TIMEOUT',
      message: ERROR_CODE_MESSAGES.TIMEOUT,
      isRetryable: true,
      originalError: error,
      status: extractStatus(error),
    }
  }

  if (isServerError(error)) {
    return {
      code: 'SERVER_ERROR',
      message: ERROR_CODE_MESSAGES.SERVER_ERROR,
      isRetryable: true,
      originalError: error,
      status: extractStatus(error),
    }
  }

  if (isNetworkError(error)) {
    return {
      code: 'NETWORK',
      message: ERROR_CODE_MESSAGES.NETWORK,
      isRetryable: true,
      originalError: error,
    }
  }

  // 兜底：保留原始错误消息
  const originalMessage = error instanceof Error ? error.message : String(error)
  return {
    code: 'UNKNOWN',
    message: originalMessage || ERROR_CODE_MESSAGES.UNKNOWN,
    isRetryable: false,
    originalError: error,
    status: extractStatus(error),
  }
}

function isInsufficientQuotaError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  const lower = msg.toLowerCase()
  return lower.includes('insufficient_quota') || lower.includes('quota exceeded') || lower.includes('额度不足')
}

/**
 * 获取用户友好的中文错误消息。
 */
export function getModelErrorMessage(error: unknown): string {
  return classifyModelError(error).message
}
