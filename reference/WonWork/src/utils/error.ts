import { toast } from 'sonner'
import { ApiError } from '@/api/client'

/** 后端结构化错误码到中文友好文案的映射（v6.1 优先按错误码匹配） */
const ERROR_CODE_MAP: Record<string, string> = {
  // 认证与授权
  UNAUTHORIZED: '认证失败，请重新登录',
  AUTH_FAILED: '认证失败，请重新登录',
  INVALID_TOKEN: '登录凭证已过期，请重新登录',
  TOKEN_EXPIRED: '登录凭证已过期，请重新登录',
  FORBIDDEN: '没有权限执行此操作',
  LICENSE_EXPIRED: '许可证已过期，请联系管理员',
  LICENSE_REVOKED: '许可证已被撤销，请联系管理员',
  FEATURE_NOT_ALLOWED: '当前套餐不包含此功能，请联系管理员',
  QUOTA_EXHAUSTED: '当月 Token 额度已用完，请升级套餐继续使用',

  // Provider / 模型
  MODEL_UNAVAILABLE: '当前模型不可用，请尝试切换其他模型',
  MODEL_NOT_FOUND: '当前模型不可用，请尝试切换其他模型',
  INVALID_MODEL: '当前模型不可用，请尝试切换其他模型',
  EMBEDDING_MODEL_UNAVAILABLE: '本地嵌入模型未部署，语义搜索将降级为关键词匹配',
  PROVIDER_UNAVAILABLE: 'AI 服务提供商异常，请检查 API Key 或稍后重试',
  INSUFFICIENT_QUOTA: 'API 额度不足，请检查账户余额或更换 API Key',
  RATE_LIMIT: '请求过于频繁，请稍后再试',

  // 网络/超时
  TIMEOUT: '请求超时，请稍后重试',
  GATEWAY_TIMEOUT: '网关超时，请稍后重试',
  SERVICE_UNAVAILABLE: '服务暂时不可用，请稍后再试',

  // WebBridge
  WEBBRIDGE_NOT_CONNECTED: 'WebBridge 自动化服务未连接，请检查配置',
  WEBBRIDGE_ERROR: 'WebBridge 服务异常，请检查配置后重试',

  // 文件
  FILE_READ_ERROR: '文件读取失败，请检查文件是否存在或格式是否正确',
  FILE_NOT_FOUND: '文件未找到，请检查文件路径',
  NOT_FOUND: '请求的资源不存在',

  // MESCLI 特定
  API_ENDPOINT_NOT_FOUND: '后端接口不存在，请确认 MESCLI 版本是否兼容',
  MES_DB_UNREACHABLE: '无法连接企业内网，请确认已连接公司网络或 VPN 后重试',
  VPN_REQUIRED: '无法连接企业内网，请确认已连接公司网络或 VPN 后重试',

  // 通用后端
  INTERNAL_SERVER_ERROR: '服务器内部错误，请稍后重试或联系管理员',
  BAD_REQUEST: '请求参数有误，请检查输入内容',
}

/** 常见错误类型到中文友好文案的映射（字符串匹配兜底） */
const ERROR_MESSAGE_MAP: Record<string, string> = {
  // API 认证
  '未配置 AI API Key': '未配置 AI API Key，请在设置中添加',
  'Unauthorized': '认证失败，请重新登录',
  'unauthorized': '认证失败，请重新登录',
  'invalid_token': '登录凭证已过期，请重新登录',
  'token_expired': '登录凭证已过期，请重新登录',

  // 网络
  'Failed to fetch': '网络连接失败，请检查网络或稍后重试',
  'NetworkError': '网络连接失败，请检查网络或稍后重试',
  'network error': '网络连接失败，请检查网络或稍后重试',
  'ECONNREFUSED': '无法连接到服务器，请检查后端服务是否启动',
  'ETIMEDOUT': '请求超时，请稍后重试',
  'Timeout': '请求超时，请稍后重试',
  'timeout': '请求超时，请稍后重试',
  'AbortError': '请求已取消',

  // WebBridge
  'WebBridge 未连接': 'WebBridge 自动化服务未连接，请检查配置',

  // Provider / 模型
  'Provider is unavailable': 'AI 服务提供商异常，请检查 API Key 或稍后重试',
  'provider is unavailable': 'AI 服务提供商异常，请检查 API Key 或稍后重试',
  'model is unavailable': '当前模型不可用，请尝试切换其他模型',
  'model not found': '当前模型不可用，请尝试切换其他模型',
  'invalid model': '当前模型不可用，请尝试切换其他模型',
  'model is not available': '当前模型不可用，请尝试切换其他模型',
  'insufficient_quota': 'API 额度不足，请检查账户余额或更换 API Key',
  'rate_limit': '请求过于频繁，请稍后再试',

  // 文件
  '文件读取失败': '文件读取失败，请检查文件是否存在或格式是否正确',
  'File not found': '文件未找到，请检查文件路径',
  'not found': '请求的资源不存在',

  // MESCLI 特定
  '/api/apikeys': '后端接口不存在，请确认 MESCLI 版本是否兼容',
  'apikeys': '后端接口不存在，请确认 MESCLI 版本是否兼容',

  // 通用后端
  'Internal Server Error': '服务器内部错误，请稍后重试或联系管理员',
  'Bad Request': '请求参数有误，请检查输入内容',
  'Service Unavailable': '服务暂时不可用，请稍后再试',
  'Not Found': '请求的资源不存在',
  'Forbidden': '没有权限执行此操作',
}

/** 状态码到中文友好文案的映射 */
const STATUS_CODE_MAP: Record<number, string> = {
  400: '请求参数有误，请检查输入内容',
  401: '认证失败，请重新登录',
  404: '请求的资源不存在',
  408: '请求超时，请稍后重试',
  429: '请求过于频繁，请稍后再试',
  500: '服务器内部错误，请稍后重试或联系管理员',
  502: '网关错误，请检查后端服务是否正常运行',
  503: '服务暂时不可用，请稍后再试',
  504: '网关超时，请稍后再试',
  529: 'AI 服务繁忙，请稍后再试',
}

/**
 * 从错误对象中提取用户友好的中文错误消息。
 *
 * @param error 任意错误对象
 * @param fallback 当无法识别错误时的默认文案
 * @returns 中文友好的错误消息
 */
export function getErrorMessage(error: unknown, fallback = '操作失败，请稍后重试'): string {
  if (!error) return fallback

  // 1. 提取 error code（优先）
  let errorCode: string | undefined
  if (error instanceof ApiError && error.data && typeof error.data === 'object') {
    const data = error.data as Record<string, unknown>
    errorCode =
      (typeof data.code === 'string' ? data.code : undefined) ||
      (typeof data.errorCode === 'string' ? data.errorCode : undefined)
  }
  if (!errorCode && typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>
    errorCode =
      (typeof obj.code === 'string' ? obj.code : undefined) ||
      (typeof obj.errorCode === 'string' ? obj.errorCode : undefined)
  }
  if (errorCode) {
    const upperCode = errorCode.toUpperCase()
    if (ERROR_CODE_MAP[upperCode]) {
      return ERROR_CODE_MAP[upperCode]
    }
    // 兼容 snake_case / camelCase：统一转大写并尝试
    const normalizedCode = upperCode.replace(/[_\s]/g, '')
    for (const [key, value] of Object.entries(ERROR_CODE_MAP)) {
      if (key.toUpperCase().replace(/[_\s]/g, '') === normalizedCode) {
        return value
      }
    }
  }

  // 2. 如果是 ApiError，优先使用其 message 和 status
  if (error instanceof ApiError) {
    const statusMsg = error.status ? STATUS_CODE_MAP[error.status] : undefined
    if (statusMsg) return statusMsg

    const mapped = mapErrorMessage(error.message)
    if (mapped) return mapped

    return error.message || fallback
  }

  // 3. 普通 Error
  if (error instanceof Error) {
    const mapped = mapErrorMessage(error.message)
    if (mapped) return mapped
    return error.message || fallback
  }

  // 4. 字符串
  if (typeof error === 'string') {
    const mapped = mapErrorMessage(error)
    if (mapped) return mapped
    return error || fallback
  }

  // 5. 对象（可能是后端返回的 JSON 错误体）
  if (typeof error === 'object') {
    const obj = error as Record<string, unknown>

    // 尝试提取常见字段
    const msg =
      (typeof obj.error === 'string' ? obj.error : undefined) ||
      (typeof obj.message === 'string' ? obj.message : undefined) ||
      (typeof obj.detail === 'string' ? obj.detail : undefined)

    if (msg) {
      const mapped = mapErrorMessage(msg)
      if (mapped) return mapped
      return msg
    }

    // 尝试提取 status / statusCode
    const status =
      (typeof obj.status === 'number' ? obj.status : undefined) ||
      (typeof obj.statusCode === 'number' ? obj.statusCode : undefined)
    if (status && STATUS_CODE_MAP[status]) {
      return STATUS_CODE_MAP[status]
    }
  }

  return fallback
}

/**
 * 判断是否为请求取消（Abort）错误。
 * 这类错误通常不需要 Toast 提示，因为用户主动取消了操作。
 */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || error.message?.includes('AbortError')
}

/**
 * 判断是否为网络错误。
 */
export function isNetworkError(error: unknown): boolean {
  if (!error) return false
  const msg = error instanceof Error ? error.message : String(error)
  const networkPatterns = [
    'Failed to fetch',
    'NetworkError',
    'network error',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'Timeout',
    'timeout',
    '断开连接',
    'Connection',
  ]
  return networkPatterns.some((p) => msg.toLowerCase().includes(p.toLowerCase()))
}

/**
 * 判断是否为速率限制错误（429 / 529 / rate limit / quota）。
 */
export function isRateLimitError(error: unknown): boolean {
  if (!error) return false
  const msg = error instanceof Error ? error.message : String(error)
  const lowerMsg = msg.toLowerCase()
  const patterns = ['429', '529', 'rate limit', 'too many requests', 'quota exceeded', 'insufficient_quota']
  return patterns.some((p) => lowerMsg.includes(p.toLowerCase()))
}

/**
 * 判断是否为模型不可用 / 无效模型错误。
 */
export function isInvalidModelError(error: unknown): boolean {
  if (!error) return false
  const msg = error instanceof Error ? error.message : String(error)
  const lowerMsg = msg.toLowerCase()
  const patterns = [
    'invalid model',
    'model not found',
    'model unavailable',
    'model is not available',
    'invalid_model',
    'model_not_found',
    'model_unavailable',
  ]
  return patterns.some((p) => lowerMsg.includes(p.toLowerCase()))
}

/**
 * 判断是否为上下文长度超限（prompt_too_long / context_length_exceeded）。
 */
export function isContextLengthError(error: unknown): boolean {
  if (!error) return false
  const msg = error instanceof Error ? error.message : String(error)
  const lowerMsg = msg.toLowerCase()
  // 2026-07-24 审计修复：补上 Anthropic/Kimi Code 的原话 "prompt is too long"——
  // 此前只有下划线版 'prompt_too_long'，Anthropic 系 400 完全匹配不上，
  // 导致自动压缩重试与窗口下行校准对 kimi-code/claude 从不触发（"长对话必死"的根因）。
  // 修改时请同步 agenticLoop.ts 的 PROMPT_TOO_LONG_PATTERNS（两处同一语义）。
  const patterns = [
    'prompt_too_long',
    'prompt is too long',
    'context_length_exceeded',
    'maximum context length',
    'context window',
    'too many tokens',
    'token limit',
    'tokens exceeds',
    'request_too_large',
    'request too large',
    'reduce the length',
  ]
  return patterns.some((p) => lowerMsg.includes(p.toLowerCase()))
}

/**
 * 判断是否为 tool_use / tool_calls 协议不匹配错误。
 */
export function isToolUseMismatchError(error: unknown): boolean {
  if (!error) return false
  const msg = error instanceof Error ? error.message : String(error)
  const lowerMsg = msg.toLowerCase()
  const patterns = ['tool_use', 'tool_calls', 'tool call', 'invalid tool', 'tool input']
  return patterns.some((p) => lowerMsg.includes(p.toLowerCase()))
}

/**
 * 内部：根据错误消息文本匹配映射表。
 */
function mapErrorMessage(message: string): string | undefined {
  if (!message) return undefined

  const lowerMsg = message.toLowerCase()

  // 精确匹配
  if (ERROR_MESSAGE_MAP[message]) {
    return ERROR_MESSAGE_MAP[message]
  }

  // 包含匹配（按优先级顺序）
  for (const [key, value] of Object.entries(ERROR_MESSAGE_MAP)) {
    if (lowerMsg.includes(key.toLowerCase())) {
      return value
    }
  }

  // 状态码模式匹配（如 "HTTP 401"、"HTTP 404"）
  const httpStatusMatch = message.match(/HTTP\s+(\d{3})/i)
  if (httpStatusMatch) {
    const status = parseInt(httpStatusMatch[1], 10)
    if (STATUS_CODE_MAP[status]) {
      return STATUS_CODE_MAP[status]
    }
  }

  return undefined
}

/** 快捷方法：显示错误 Toast */
export function showErrorToast(error: unknown, fallback?: string) {
  if (isAbortError(error)) return
  const message = getErrorMessage(error, fallback)
  toast.error(message)
}

/** 快捷方法：显示成功 Toast */
export function showSuccessToast(message: string) {
  toast.success(message)
}

/** 快捷方法：显示信息 Toast */
export function showInfoToast(message: string) {
  toast.info(message)
}
