import {
  LoginRequest,
  LoginResponse,
  UserInfo,
  ChatRequest,
  StreamChunk,
  Conversation,
  CreateConversationRequest,
  UpdateTitleRequest,
  Message,
  FavoriteItem,
  AddFavoriteRequest,
  UpdateFavoriteRequest,
  StartWorkflowRequest,
  StartWorkflowResponse,
  WorkflowStepResponse,
  WorkflowSearchRequest,
  WorkflowSearchResponse,
  ProviderConfig,
  UserConfigDto,
  ToolCatalogItem,
  ToolInvokeResult,
  CapabilitiesResponse,
  ToolInvokeRequest,
  VoiceRecognizeResponse,
  FileAttachmentDto,
  CapabilityTreeResponse,
  CapabilitySchemaResponse,
  type UserPermissions,
  type WorkspaceListResponse,
  type WorkspaceReadResponse,
  type WorkspaceNode,
  type WorkspaceWriteRequest,
  type WorkspaceUploadResult,
} from '@/types/mescli'

import {
  standaloneAuthApi,
  standaloneChatApi,
  standaloneHistoryApi,
  standaloneFavoriteApi,
  standaloneWorkflowApi,
  standaloneConfigApi,
  standaloneUserConfigApi,
  standaloneVoiceApi,
  standaloneAttachmentApi,
  standaloneCronApi,
  standaloneDagWorkflowApi,
  standalonePluginApi,
  standaloneToolApi,
  PROVIDERS,
} from './standaloneApi'
import { mescliCronApi } from './mescli/cronApi'
import { mescliDagWorkflowApi } from './dagWorkflowApi'
import { useCommercialNoticeStore } from '@/stores/commercialNoticeStore'
import type { InstalledPlugin } from '@/types/plugin'
import { useUsageStore, buildTodayUsageRecord } from '@/stores/usageStore'
import { FEATURE_FLAGS } from '@/config/product'
import { toast } from 'sonner'
import { getErrorMessage, isAbortError } from '@/utils/error'
import { createSSEParserState, parseSSEBuffer, flushSSEBuffer, parseSSEData, type SSEEvent } from '@/utils/sseParser'
import { withRetry } from '@/utils/retry'
import { getRuntimeMode } from '@/utils/runtimeMode'

/**
 * MESCLI API 基础客户端
 * 设计原则：
 * 1. 与 MESCLI 后端松耦合 —— 所有 DTO 来自 types/mescli.ts
 * 2. 认证透明 —— 自动携带 JWT Token / MES Header
 * 3. SSE 流式 —— 专用方法处理 Server-Sent Events
 * 4. 错误统一 —— 所有错误包装为 ApiError
 * 5. 模式切换 —— 支持独立模式（不依赖 MESCLI 后端）
 */

/** 运行模式检测 */
export const IS_STANDALONE = import.meta.env.VITE_STANDALONE_MODE === 'true'

export const API_BASE = import.meta.env.VITE_API_BASE_URL || ''

class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public data?: unknown
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * 对可能包含中文的 Header 值做 URI 编码。
 * fetch 要求 Header value 必须是 ISO-8859-1 字符集，直接传中文会抛异常。
 * 后端统一使用 Uri.UnescapeDataString 解码。
 */
function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value)
}

/**
 * 判断 token 是否为 AIGateway 签发的 MES JWT。
 * 注意：website/cloud token 由外部系统签发，payload 中不会有 iss='AIGateway'、aud='MESUser'。
 */
function isMesJwtToken(token: string): boolean {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return false
    const payload = JSON.parse(atob(parts[1]))
    return payload?.iss === 'AIGateway' && payload?.aud === 'MESUser'
  } catch {
    return false
  }
}

/**
 * 是否应发送 MES 透传 Header。
 * - 无 token 时不发（未登录 / website/cloud 本地模式）。
 * - token 是 MES JWT 时才发（MES 在线模式或 MES 本地模式）。
 * 这能避免 website/cloud 登录后，stale 的 wonclaw_user_id 仍触发后端连内网 SQL Server。
 */
function shouldSendMesHeaders(): boolean {
  const token = localStorage.getItem('wonclaw_token')
  if (!token) return false
  return isMesJwtToken(token)
}

/** 清理过期的 MES 本地状态（切到 website/cloud/本地模式时调用） */
export function clearMesLocalState(): void {
  localStorage.removeItem('wonclaw_user_id')
  localStorage.removeItem('wonclaw_user_name')
  localStorage.removeItem('wonclaw_real_name')
  localStorage.removeItem('wonclaw_role_id')
  localStorage.removeItem('wonclaw_factory_id')
  localStorage.removeItem('wonclaw_dept_id')
  localStorage.removeItem('wonclaw_workshop_id')
  localStorage.removeItem('wonclaw_system_code')
}

/** 获取存储的认证信息 */
export function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  // JWT Token
  const token = localStorage.getItem('wonclaw_token')
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  // MES 透传 Header：仅在当前活跃身份是 MES 时才发送，
  // 防止 website/cloud/本地模式下 stale MES 状态触发后端 SQL Server 连接。
  if (shouldSendMesHeaders()) {
    const systemCode = localStorage.getItem('wonclaw_system_code') || 'ykhm'
    headers['X-System-Code'] = systemCode

    const userId = localStorage.getItem('wonclaw_user_id')
    if (userId) headers['X-MES-User-Id'] = userId

    const userName = localStorage.getItem('wonclaw_user_name')
    if (userName) headers['X-MES-User-Name'] = encodeHeaderValue(userName)

    const realName = localStorage.getItem('wonclaw_real_name')
    if (realName) headers['X-MES-Real-Name'] = encodeHeaderValue(realName)

    const roleId = localStorage.getItem('wonclaw_role_id')
    if (roleId) headers['X-MES-Role-Id'] = roleId

    const factoryId = localStorage.getItem('wonclaw_factory_id')
    if (factoryId) headers['X-MES-Factory-Id'] = factoryId

    const deptId = localStorage.getItem('wonclaw_dept_id')
    if (deptId) headers['X-MES-Dept-Id'] = deptId

    const workshopId = localStorage.getItem('wonclaw_workshop_id')
    if (workshopId) headers['X-MES-Workshop-Id'] = workshopId
  }

  return headers
}

/** 基础 fetch 封装 */
async function fetchApi<T>(
  path: string,
  options: RequestInit & { silent?: boolean } = {}
): Promise<T> {
  const url = `${API_BASE}${path}`
  const headers = {
    ...getAuthHeaders(),
    ...(options.headers || {}),
  }

  // 如果 body 是 FormData，移除 Content-Type（让浏览器自动设置 boundary）
  if (options.body instanceof FormData) {
    delete (headers as Record<string, string>)['Content-Type']
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  })

  if (!response.ok) {
    let errorText: string
    try {
      errorText = await response.text()
    } catch {
      errorText = `HTTP ${response.status}`
    }

    let errorData: unknown = errorText
    try {
      errorData = JSON.parse(errorText)
    } catch {
      // 非 JSON 错误响应，保留原始文本
    }

    const message = (errorData as { error?: string })?.error || `HTTP ${response.status}`
    const code = (errorData as { code?: string })?.code

    // 调用方要求静默时不弹 Toast（如非关键后台服务）
    if (!options.silent) {
      // 商业化错误全局提示（402/403 走 CommercialNoticeStore，不走 toast）
      if (response.status === 402 || response.status === 403) {
        const noticeType =
          code === 'quota_exhausted'
            ? 'quota_exhausted'
            : code === 'license_expired'
              ? 'license_expired'
              : code === 'license_revoked'
                ? 'license_revoked'
              : code === 'feature_not_allowed'
                ? 'feature_not_allowed'
                : 'payment_required'
        try {
          useCommercialNoticeStore.getState().showNotice(noticeType, message)
        } catch {
          // 避免在 API 层抛出异常影响正常错误流程
        }
      } else if (response.status === 401) {
        // 2026-07-24 审计修复：会话过期/被踢后必须清除本地 token 并回到登录态，
        // 否则 UI 仍显示已登录，后续请求会连续 401 弹 Toast。
        const friendlyMessage = getErrorMessage(
          { status: 401, message: errorText },
          '认证失败，请重新登录'
        )
        toast.error(friendlyMessage)
        try {
          localStorage.removeItem('wonclaw_token')
          localStorage.removeItem('wonclaw_website_token')
          // 清除 MES 透传身份信息，防止 stale header 继续触发后端认证异常
          localStorage.removeItem('wonclaw_user_id')
          localStorage.removeItem('wonclaw_user_name')
          localStorage.removeItem('wonclaw_real_name')
          localStorage.removeItem('wonclaw_role_id')
          localStorage.removeItem('wonclaw_factory_id')
          localStorage.removeItem('wonclaw_dept_id')
          localStorage.removeItem('wonclaw_workshop_id')
          localStorage.removeItem('wonclaw_system_code')
          // 刷新页面以触发 App.tsx 的会话恢复/登录门逻辑
          window.location.reload()
        } catch {
          // localStorage 操作失败不应阻塞错误抛出
        }
      } else if (response.status === 404) {
        // MESCLI 下调用不存在的接口（如 /api/apikeys）给出友好提示
        const friendlyMessage = getErrorMessage(
          { status: 404, message: errorText },
          '请求的资源不存在'
        )
        toast.error(friendlyMessage)
      } else {
        // 其他非 2xx 错误统一 Toast 提示
        const friendlyMessage = getErrorMessage(
          { status: response.status, message: errorText, error: message, code },
          '请求失败，请稍后重试'
        )
        toast.error(friendlyMessage)
      }
    }

    throw new ApiError(message, response.status, errorData)
  }

  // 204 No Content
  if (response.status === 204) {
    return undefined as T
  }

  // 检查 Content-Type
  const contentType = response.headers.get('content-type')
  if (contentType?.includes('application/json')) {
    return response.json() as Promise<T>
  }

  return response.text() as Promise<T>
}

// ==================== 认证 API ====================

const mescliAuthApi = {
  /** POST /api/auth/login */
  login: (req: LoginRequest): Promise<LoginResponse> =>
    fetchApi<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  /** POST /api/auth/logout */
  logout: (): Promise<{ success: boolean }> =>
    fetchApi<{ success: boolean }>('/api/auth/logout', {
      method: 'POST',
    }),

  /** GET /api/auth/user */
  getCurrentUser: (): Promise<UserInfo> =>
    fetchApi<UserInfo>('/api/auth/user'),
}

export const authApi = IS_STANDALONE ? standaloneAuthApi : mescliAuthApi

// ==================== 对话 API ====================

const mescliChatApi = {
  /** POST /api/chat/stream-sse —— SSE 流式对话（带请求层重试） */
  streamChat: (
    request: ChatRequest,
    onChunk: (chunk: StreamChunk) => void,
    onError?: (error: Error) => void,
    onDone?: () => void
  ): (() => void) => {
    const url = `${API_BASE}/api/chat/stream-sse`
    let aborted = false
    let currentAbortController: AbortController | null = null

    const executeStream = async (attempt: number): Promise<void> => {
      if (aborted) {
        const abortError = new Error('Request aborted')
        abortError.name = 'AbortError'
        throw abortError
      }

      currentAbortController = new AbortController()
      const headers = getAuthHeaders()

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: currentAbortController.signal,
        credentials: 'include',
      })

      if (!response.ok) {
        const text = await response.text()
        let errorMessage = text
        try {
          const parsed = JSON.parse(text)
          errorMessage = (parsed.error || parsed.message || text) as string
        } catch {
          // 非 JSON，保留原始文本
        }
        const friendlyMessage = getErrorMessage(
          { status: response.status, message: errorMessage },
          '对话服务异常，请稍后重试'
        )
        throw new ApiError(friendlyMessage, response.status)
      }

      const tokensInHeader = response.headers.get('x-usage-tokens-in')
      const tokensOutHeader = response.headers.get('x-usage-tokens-out')
      const tokensIn = tokensInHeader ? parseInt(tokensInHeader, 10) || 0 : 0
      const tokensOut = tokensOutHeader ? parseInt(tokensOutHeader, 10) || 0 : 0

      const reader = response.body?.getReader()
      if (!reader) throw new Error('Response body is null')

      const decoder = new TextDecoder()
      const sseState = createSSEParserState()

      /** 统一分发 SSE 事件；返回 true 表示流已结束。 */
      const handleEvent = (event: SSEEvent): boolean => {
        if (event.event === 'chunk' || event.event === 'message') {
          const parsed = parseSSEData(event.data)
          if (parsed && typeof parsed === 'object' && 'done' in parsed) {
            reportUsage(tokensIn, tokensOut)
            if (!aborted) onDone?.()
            return true
          }
          try {
            const chunk: StreamChunk = parsed as StreamChunk
            onChunk(chunk)
          } catch {
            // 忽略解析失败的 chunk
          }
          return false
        }

        switch (event.event) {
          case 'done':
            reportUsage(tokensIn, tokensOut)
            if (!aborted) onDone?.()
            return true
          case 'error': {
            const parsed = parseSSEData(event.data)
            const errorMessage =
              parsed && typeof parsed === 'object'
                ? (parsed as { content?: string; message?: string }).content ||
                  (parsed as { content?: string; message?: string }).message ||
                  String(parsed)
                : String(event.data)
            // 流内错误不重试：消费端已累积部分回复，重试会导致内容重复
            throw new ApiError(errorMessage, 400)
          }
          case 'title':
          case 'tool_call':
          case 'think':
            try {
              const chunk: StreamChunk = parseSSEData(event.data) as StreamChunk
              onChunk(chunk)
            } catch {
              // 忽略解析失败的 chunk
            }
            break
          default:
            try {
              const chunk: StreamChunk = parseSSEData(event.data) as StreamChunk
              onChunk(chunk)
            } catch {}
        }
        return false
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (aborted) break

        const text = decoder.decode(value, { stream: true })
        const events = parseSSEBuffer(sseState, text)

        for (const event of events) {
          if (handleEvent(event)) return
        }
      }

      const remainingEvents = flushSSEBuffer(sseState)
      for (const event of remainingEvents) {
        if (handleEvent(event)) return
      }

      reportUsage(tokensIn, tokensOut)
      if (!aborted) onDone?.()
    }

    // MESCLI-Online 走公网/VPN，网络抖动概率高，开启 SSE 连接层重试；
    // MESCLI-Local / Standalone 已在前端 modelClient 或本地代理层处理，保持 maxRetries=0 避免重复重试。
    const isOnline = getRuntimeMode() === 'mescli-online'

    withRetry(executeStream, {
      maxRetries: isOnline ? 2 : 0,
      baseDelayMs: 500,
      maxDelayMs: 5000,
    }).catch((error) => {
      if (!aborted && error.name !== 'AbortError') {
        const friendlyMessage = getErrorMessage(
          error,
          '对话连接异常，请检查网络或稍后重试'
        )
        if (!isAbortError(error)) {
          // 错误提示统一由调用方（如 chatStore.onError）负责，避免重复 Toast
          // toast.error(friendlyMessage)
        }
        onError?.(new Error(friendlyMessage))
      }
    })

    function reportUsage(tokensIn: number, tokensOut: number) {
      if (tokensIn > 0 || tokensOut > 0) {
        useUsageStore.getState().report(
          buildTodayUsageRecord({
            tokensIn,
            tokensOut,
            apiCalls: 1,
          })
        )
      }
    }

    return () => {
      aborted = true
      currentAbortController?.abort()
    }
  },
}

export const chatApi = IS_STANDALONE ? standaloneChatApi : mescliChatApi

// ==================== 历史会话 API ====================

const mescliHistoryApi = {
  /** GET /api/history */
  getConversations: (page = 1, pageSize = 20): Promise<Conversation[]> =>
    fetchApi<Conversation[]>(`/api/history?page=${page}&pageSize=${pageSize}`),

  /** POST /api/history */
  createConversation: (req: CreateConversationRequest): Promise<{ id: number; title: string }> =>
    fetchApi<{ id: number; title: string }>('/api/history', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  /** PUT /api/history/{conversationId} */
  updateTitle: (conversationId: number, req: UpdateTitleRequest): Promise<void> =>
    fetchApi<void>(`/api/history/${conversationId}`, {
      method: 'PUT',
      body: JSON.stringify(req),
    }),

  /** GET /api/history/{conversationId}/messages */
  getMessages: (conversationId: number): Promise<Message[]> =>
    fetchApi<Message[]>(`/api/history/${conversationId}/messages`),

  /** POST /api/history/{conversationId}/messages */
  saveMessage: (conversationId: number, message: Message): Promise<void> =>
    fetchApi<void>(`/api/history/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify(message),
    }),

  /** DELETE /api/history/{conversationId} */
  deleteConversation: (conversationId: number): Promise<void> =>
    fetchApi<void>(`/api/history/${conversationId}`, {
      method: 'DELETE',
    }),
}

// 历史会话统一走前端本地存储（IndexedDB），与 MESCLI/Standalone 解耦。
// 后续若需要后端持久化，可在此处切换回 mescliHistoryApi。
export const historyApi = standaloneHistoryApi

// ==================== 收藏夹 API ====================

const mescliFavoriteApi = {
  /** GET /api/favorite */
  getFavorites: (): Promise<FavoriteItem[]> =>
    fetchApi<FavoriteItem[]>('/api/favorite'),

  /** POST /api/favorite */
  addFavorite: (req: AddFavoriteRequest): Promise<{ id: number; title: string; prompt: string }> =>
    fetchApi<{ id: number; title: string; prompt: string }>('/api/favorite', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  /** PUT /api/favorite/{id} */
  updateFavorite: (id: number, req: UpdateFavoriteRequest): Promise<void> =>
    fetchApi<void>(`/api/favorite/${id}`, {
      method: 'PUT',
      body: JSON.stringify(req),
    }),

  /** DELETE /api/favorite/{id} */
  deleteFavorite: (id: number): Promise<void> =>
    fetchApi<void>(`/api/favorite/${id}`, {
      method: 'DELETE',
    }),
}

export const favoriteApi = IS_STANDALONE ? standaloneFavoriteApi : mescliFavoriteApi

// ==================== 工作流 API ====================

const mescliWorkflowApi = {
  /** POST /api/workflow/start */
  start: (req: StartWorkflowRequest): Promise<StartWorkflowResponse> =>
    fetchApi<StartWorkflowResponse>('/api/workflow/start', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  /** POST /api/workflow/{sessionId}/submit */
  submit: (sessionId: string, stepData: Record<string, unknown>): Promise<WorkflowStepResponse> =>
    fetchApi<WorkflowStepResponse>(`/api/workflow/${sessionId}/submit`, {
      method: 'POST',
      body: JSON.stringify(stepData),
    }),

  /** GET /api/workflow/{sessionId}/current */
  getCurrentStep: (sessionId: string): Promise<WorkflowStepResponse> =>
    fetchApi<WorkflowStepResponse>(`/api/workflow/${sessionId}/current`),

  /** POST /api/workflow/{sessionId}/cancel */
  cancel: (sessionId: string): Promise<{ message: string }> =>
    fetchApi<{ message: string }>(`/api/workflow/${sessionId}/cancel`, {
      method: 'POST',
    }),

  /** POST /api/workflow/search */
  search: (req: WorkflowSearchRequest): Promise<WorkflowSearchResponse> =>
    fetchApi<WorkflowSearchResponse>('/api/workflow/search', {
      method: 'POST',
      body: JSON.stringify(req),
    }),
}

export const workflowApi = IS_STANDALONE ? standaloneWorkflowApi : mescliWorkflowApi

// ==================== 工具目录 API ====================

const mescliToolApi = {
  /**
   * GET /api/capabilities
   *
   * 新的能力发现接口：返回后端工具目录 + 功能开关。
   */
  capabilities: async (systemCode?: string): Promise<ToolCatalogItem[]> => {
    const response = await mescliToolApi.capabilitiesFull(systemCode)
    return response.tools || []
  },

  /**
   * GET /api/capabilities 完整响应（含 features / version / 分层工具列表）。
   * 用于需要读取后端功能开关（如 frontend_loop_online）的场景。
   */
  capabilitiesFull: async (systemCode?: string): Promise<CapabilitiesResponse> => {
    const query = systemCode ? `?systemCode=${encodeURIComponent(systemCode)}` : ''
    const response = await fetch(`${API_BASE}/api/capabilities${query}`, {
      method: 'GET',
      headers: getAuthHeaders(),
      credentials: 'include',
    })
    if (!response.ok) {
      const text = await response.text()
      throw new ApiError(`获取能力目录失败：HTTP ${response.status} ${text}`, response.status)
    }
    return (await response.json()) as CapabilitiesResponse
  },

  /**
   * POST /api/tools/execute
   *
   * 新的统一工具执行接口，返回 SSE 格式的 ToolResultChunk 序列。
   * 前端将其归约为 ToolInvokeResult，并在执行期间累积进度信息。
   */
  execute: async (
    request: ToolInvokeRequest,
    options?: {
      /** 当后端返回 approval_required 时调用；返回 true 表示同意，false 表示拒绝 */
      onApprovalRequired?: (approval: {
        executionId: string
        toolUseId: string
        toolName: string
        reason?: string
        /** 已渲染的影响陈述句 */
        impactStatement?: string
        /** 原始工具参数 */
        rawParams?: Record<string, unknown>
        /** 审批过期时间（Unix 毫秒时间戳） */
        expiresAt?: number
        /** 风险等级 */
        riskLevel?: string
      }) => Promise<boolean>
    }
  ): Promise<ToolInvokeResult> => {
    const response = await fetch(`${API_BASE}/api/tools/execute`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(request),
      credentials: 'include',
    })
    if (!response.ok) {
      const text = await response.text()
      throw new ApiError(`工具执行请求失败：HTTP ${response.status} ${text}`, response.status)
    }

    const contentType = response.headers.get('content-type') || ''
    const isSSE = contentType.includes('text/event-stream')
    if (!isSSE) {
      // 后端返回了 JSON（旧实现或异常），直接解析
      return (await response.json()) as ToolInvokeResult
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new ApiError('工具执行响应体为空', 502)
    }

    const decoder = new TextDecoder()
    const sseState = createSSEParserState()
    const progressMessages: string[] = []
    let finalChunk: import('@/types/mescli').ToolResultChunk | undefined

    // 后端当前使用统一的 `data` 字段承载进度/结果/错误文本；
    // 消费时优先读取显式字段，再按 chunk 类型回退到 `data`。
    const resolveProgressMessage = (chunk: import('@/types/mescli').ToolResultChunk): string | undefined => {
      if (typeof chunk.progressMessage === 'string' && chunk.progressMessage.trim()) {
        return chunk.progressMessage.trim()
      }
      if (chunk.type === 'progress' && typeof chunk.data === 'string' && chunk.data.trim()) {
        return chunk.data.trim()
      }
      return undefined
    }

    const resolveResultText = (chunk: import('@/types/mescli').ToolResultChunk): string | undefined => {
      if (typeof chunk.resultData === 'string' && chunk.resultData.trim()) {
        return chunk.resultData.trim()
      }
      if (typeof chunk.resultSummary === 'string' && chunk.resultSummary.trim()) {
        return chunk.resultSummary.trim()
      }
      if (chunk.type === 'result' && typeof chunk.data === 'string' && chunk.data.trim()) {
        return chunk.data.trim()
      }
      return undefined
    }

    const resolveErrorText = (chunk: import('@/types/mescli').ToolResultChunk): string | undefined => {
      if (typeof chunk.error === 'string' && chunk.error.trim()) {
        return chunk.error.trim()
      }
      if (chunk.type === 'error' && typeof chunk.data === 'string' && chunk.data.trim()) {
        return chunk.data.trim()
      }
      return undefined
    }

    const processApproval = async (
      chunk: import('@/types/mescli').ToolResultChunk
    ): Promise<boolean> => {
      const executionId = chunk.executionId
      const toolUseId = chunk.toolUseId
      const toolName = chunk.toolName
      if (!executionId || !toolUseId) {
        finalChunk = {
          type: 'error',
          toolUseId: toolUseId || request.toolUseId || '',
          toolName: toolName || request.toolName,
          data: '后端审批请求缺少 executionId 或 toolUseId',
          error: '后端审批请求缺少 executionId 或 toolUseId',
          isError: true,
        }
        return false
      }
      if (!options?.onApprovalRequired) {
        finalChunk = {
          type: 'error',
          executionId,
          toolUseId,
          toolName: toolName || request.toolName,
          data: '工具执行需要用户审批，但当前上下文未提供审批回调',
          error: '工具执行需要用户审批，但当前上下文未提供审批回调',
          isError: true,
        }
        return false
      }
      const approved = await options.onApprovalRequired({
        executionId,
        toolUseId,
        toolName: toolName || request.toolName,
        reason: chunk.data || chunk.resultSummary || '该工具需要用户审批',
        impactStatement: chunk.impactStatement,
        rawParams: chunk.rawParams,
        expiresAt: chunk.expiresAt,
        riskLevel: chunk.riskLevel,
      })
      try {
        await mescliToolApi.submitApproval({
          executionId,
          toolUseId,
          approved,
          reason: approved ? '用户同意执行' : '用户拒绝执行',
        })
      } catch (err) {
        console.error('[mescliToolApi] 提交审批决策失败:', err)
        finalChunk = {
          type: 'error',
          executionId,
          toolUseId,
          toolName: toolName || request.toolName,
          data: '提交审批决策失败',
          error: err instanceof Error ? err.message : String(err),
          isError: true,
        }
        return false
      }
      return approved
    }

    const handleChunk = (chunk: import('@/types/mescli').ToolResultChunk): void => {
      const progress = resolveProgressMessage(chunk)
      if (progress) {
        progressMessages.push(progress)
        return
      }
      if (chunk.type === 'result' || chunk.type === 'error' || chunk.type === 'cancelled') {
        finalChunk = chunk
      }
    }

    const processEvents = async (events: SSEEvent[]) => {
      for (const event of events) {
        if (finalChunk) break
        const data = parseSSEData(event.data)
        if (data && typeof data === 'object' && 'done' in data) {
          continue
        }
        const chunk = data as import('@/types/mescli').ToolResultChunk
        if (!chunk || typeof chunk !== 'object') continue

        if (chunk.type === 'approval_required') {
          await processApproval(chunk)
          continue
        }

        handleChunk(chunk)
      }
    }

    while (true) {
      if (finalChunk) break
      const { done, value } = await reader.read()
      if (done) break

      const text = decoder.decode(value, { stream: true })
      const events = parseSSEBuffer(sseState, text)
      await processEvents(events)
    }

    if (!finalChunk) {
      const remaining = flushSSEBuffer(sseState)
      await processEvents(remaining)
    }

    // 消费结束后释放 reader，避免后端长时间挂起
    reader.cancel('工具执行已结束').catch(() => {})

    if (!finalChunk) {
      // 流正常结束但未收到 result/error：用进度消息兜底
      return {
        toolName: request.toolName,
        success: progressMessages.length > 0,
        data: progressMessages.join('\n') || undefined,
        error: progressMessages.length === 0 ? '工具执行未返回结果' : undefined,
      }
    }

    if (finalChunk.type === 'error') {
      const summary = resolveErrorText(finalChunk) || '工具执行失败'
      return {
        toolName: request.toolName,
        success: false,
        error: summary,
        structuredData: finalChunk.structuredData,
      }
    }

    if (finalChunk.type === 'cancelled') {
      return {
        toolName: request.toolName,
        success: false,
        error: '工具执行已取消',
        structuredData: finalChunk.structuredData,
      }
    }

    const outputText =
      resolveResultText(finalChunk) ||
      (progressMessages.length > 0 ? progressMessages.join('\n') : undefined)

    return {
      toolName: request.toolName,
      success: true,
      data: outputText,
      structuredData: finalChunk.structuredData,
    }
  },

  /** POST /api/tools/search —— 工具发现（v1.4） */
  search: (req: import('@/types/mescli').ToolSearchRequest): Promise<import('@/types/mescli').ToolSearchResponse> =>
    fetchApi<import('@/types/mescli').ToolSearchResponse>('/api/tools/search', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  /** GET /api/capabilities/tree —— 文件系统式能力浏览（v1.5） */
  tree: (path = '/', systemCode?: string): Promise<CapabilityTreeResponse> => {
    const params = new URLSearchParams()
    params.set('path', path)
    if (systemCode) params.set('systemCode', systemCode)
    return fetchApi<CapabilityTreeResponse>(`/api/capabilities/tree?${params.toString()}`)
  },

  /** GET /api/capabilities/schema —— 读取指定路径工具的完整 schema（v1.5） */
  schema: (path: string, systemCode?: string): Promise<CapabilitySchemaResponse> => {
    const params = new URLSearchParams()
    params.set('path', path)
    if (systemCode) params.set('systemCode', systemCode)
    return fetchApi<CapabilitySchemaResponse>(`/api/capabilities/schema?${params.toString()}`)
  },

  /** POST /api/tools/approval —— 提交 backend-driven 审批决策（v1.4） */
  submitApproval: (req: import('@/types/mescli').SubmitToolApprovalRequest): Promise<{ executionId: string; approved: boolean }> =>
    fetchApi<{ executionId: string; approved: boolean }>('/api/tools/approval', {
      method: 'POST',
      body: JSON.stringify(req),
    }),
}

export const toolApi = IS_STANDALONE ? standaloneToolApi : mescliToolApi

// ==================== 工作区文件系统 API ====================

const mescliWorkspaceApi = {
  /** GET /api/workspace/info —— 已解析的工作区根目录（连接状态展示用） */
  info: (): Promise<{ rootPath: string }> =>
    fetchApi<{ rootPath: string }>('/api/workspace/info'),

  /** GET /api/workspace/list —— 列出目录节点 */
  list: (path = '/workspace'): Promise<WorkspaceListResponse> =>
    fetchApi<WorkspaceListResponse>(`/api/workspace/list?path=${encodeURIComponent(path)}`),

  /** GET /api/workspace/read —— 读取文件内容与元数据 */
  read: (path: string): Promise<WorkspaceReadResponse> =>
    fetchApi<WorkspaceReadResponse>(`/api/workspace/read?path=${encodeURIComponent(path)}`),

  /** POST /api/workspace/write —— 写入或覆盖/追加文件 */
  write: (
    path: string,
    content: string,
    append?: boolean,
    encoding?: 'utf-8' | 'base64'
  ): Promise<WorkspaceNode> =>
    fetchApi<WorkspaceNode>('/api/workspace/write', {
      method: 'POST',
      body: JSON.stringify({ path, content, append, encoding } as WorkspaceWriteRequest),
    }),

  /** POST /api/workspace/upload —— 用户上传文件到工作区 */
  upload: (file: File): Promise<WorkspaceUploadResult> => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('declaredMimeType', file.type || 'application/octet-stream')
    return fetchApi<WorkspaceUploadResult>('/api/workspace/upload', {
      method: 'POST',
      body: formData,
    })
  },

  /** DELETE /api/workspace/delete —— 删除文件或空目录 */
  delete: (path: string): Promise<void> =>
    fetchApi<void>(`/api/workspace/delete?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    }),

  // ---------- S4 项目模式（/project 用户轨，受后端 Workspace:EnableProjectMode 门控） ----------

  /** GET /api/workspace/project —— 当前活跃项目根（未选择时 path=null） */
  getProject: (): Promise<{ path: string | null; name: string | null }> =>
    fetchApi<{ path: string | null; name: string | null }>('/api/workspace/project'),

  /** PUT /api/workspace/project —— 设置活跃项目根（幂等，会话激活时断言） */
  setProject: (path: string): Promise<{ path: string; name: string }> =>
    fetchApi<{ path: string; name: string }>('/api/workspace/project', {
      method: 'PUT',
      body: JSON.stringify({ path }),
    }),

  /** DELETE /api/workspace/project —— 清除活跃项目根 */
  clearProject: (): Promise<void> =>
    fetchApi<void>('/api/workspace/project', { method: 'DELETE' }),

  /** GET /api/workspace/browse —— 本机目录浏览（项目选择器逐级下钻；无 path 返回盘符） */
  browse: (path?: string): Promise<{ path: string; entries: { name: string; path: string; isDirectory: boolean }[] }> =>
    fetchApi<{ path: string; entries: { name: string; path: string; isDirectory: boolean }[] }>(
      `/api/workspace/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`
    ),

  /** GET /api/workspace/download —— 统一下载端点（双根共用，attachment 强制下载） */
  downloadUrl: (path: string): string =>
    `/api/workspace/download?path=${encodeURIComponent(path)}`,

  /** GET /api/workspace/preview —— 内联预览端点（正确 Content-Type，供 img/fetch 展示） */
  previewUrl: (path: string): string =>
    `/api/workspace/preview?path=${encodeURIComponent(path)}`,
}

const standaloneWorkspaceApi = {
  info: async (): Promise<{ rootPath: string | null }> => ({ rootPath: null }),
  list: async (): Promise<WorkspaceListResponse> => ({ path: '/workspace', nodes: [] }),
  read: async (path: string): Promise<WorkspaceReadResponse> => ({
    path,
    isText: true,
    sizeBytes: 0,
  }),
  write: async (path: string, _content: string, _append?: boolean): Promise<WorkspaceNode> => ({
    name: path.split('/').pop() || path,
    path,
    kind: 'file',
  }),
  /**
   * Standalone 上传落 VFS（打磨任务2 S3，前端闭环）：
   * 与后端 /api/workspace/upload 对齐——uploads/{yyyyMMdd}/ 下版本化命名、
   * 可执行文件黑名单、SHA-256 校验和；文本存全文，二进制存占位说明
   * （图片由对话流另行 base64 内联，Office 文件读取时自动生成占位）。
   */
  upload: async (file: File): Promise<WorkspaceUploadResult> => {
    const BLOCKED_EXECUTABLES = new Set([
      '.exe', '.dll', '.bat', '.cmd', '.sh', '.msi', '.jar', '.ps1', '.com', '.scr', '.vbs', '.js',
    ])
    const ext = ('.' + (file.name.split('.').pop() || 'bin')).toLowerCase()
    if (BLOCKED_EXECUTABLES.has(ext)) {
      throw new ApiError(`禁止上传可执行文件: ${ext}`, 400)
    }

    const { indexedDbAdapter } = await import('@/services/workspaceAdapters/indexedDbAdapter')

    const now = new Date()
    const pad = (n: number, w = 2) => String(n).padStart(w, '0')
    const dateDir = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`
    const baseName =
      file.name
        .slice(0, file.name.length - ext.length)
        .replace(/[<>:"\\|?*\x00-\x1f]/g, '_')
        .replace(/\.{2,}/g, '_')
        .trim() || 'upload'

    // 同名版本化：_v2.._v100（对齐后端 MaxVersionAttempts）
    let version = 1
    let targetPath = ''
    while (version <= 100) {
      const suffix = version > 1 ? `_v${version}` : ''
      const candidate = `/workspace/uploads/${dateDir}/${baseName}${suffix}_${timePart}${ext}`
      if (!(await indexedDbAdapter.fileExists(candidate))) {
        targetPath = candidate
        break
      }
      version++
    }
    if (!targetPath) {
      throw new ApiError('文件版本数超过上限，请删除旧版本后重试', 409)
    }

    const TEXT_LIKE = /^(text\/|application\/(json|xml|csv|x-ndjson))/
    const TEXT_EXTS = new Set([
      '.txt', '.md', '.markdown', '.json', '.csv', '.xml', '.yaml', '.yml',
      '.log', '.ts', '.tsx', '.jsx', '.css', '.scss', '.html', '.py', '.sql', '.ini', '.cfg',
    ])
    const isText = TEXT_LIKE.test(file.type) || TEXT_EXTS.has(ext)
    const content = isText
      ? await file.text()
      : `二进制文件（${ext}），大小 ${file.size} 字节，无法直接读取文本内容。`

    // SHA-256 校验和（可选，失败不阻塞上传）
    let checksum: string | undefined
    try {
      const buf = await file.arrayBuffer()
      const hash = await crypto.subtle.digest('SHA-256', buf)
      checksum = Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    } catch {
      // checksum 可选
    }

    await indexedDbAdapter.writeFile(targetPath, content, {
      skipSync: !isText, // 二进制占位不同步到 File System Access 真实目录，避免写出损坏文件
      meta: {
        size: file.size,
        source: 'user_upload',
        mimeType: file.type || 'application/octet-stream',
        status: 'Ready',
        version,
        checksum,
      },
    })

    return {
      path: targetPath,
      name: targetPath.split('/').pop() || file.name,
      sizeBytes: file.size,
      mimeType: file.type || 'application/octet-stream',
      status: 'ready',
      version,
      checksumSha256: checksum,
      createdAt: now.toISOString(),
    }
  },
  delete: async (): Promise<void> => {},

  // ---------- S4 项目模式：Standalone 暂不支持（S5 走 File System Access 句柄） ----------
  getProject: async (): Promise<{ path: string | null; name: string | null }> => ({ path: null, name: null }),
  setProject: async (): Promise<{ path: string; name: string }> => {
    throw new ApiError('项目模式需要 MESCLI Local，Standalone 将在后续版本支持（S5）', 400)
  },
  clearProject: async (): Promise<void> => {},
  browse: async (): Promise<{ path: string; entries: { name: string; path: string; isDirectory: boolean }[] }> => {
    throw new ApiError('项目模式需要 MESCLI Local，Standalone 将在后续版本支持（S5）', 400)
  },
  downloadUrl: (path: string): string => path,
  // Standalone 暂无二进制内联预览（IndexedDB 不存二进制），透传虚拟路径
  previewUrl: (path: string): string => path,
}

export const workspaceApi = IS_STANDALONE ? standaloneWorkspaceApi : mescliWorkspaceApi

// ==================== 会话-文件索引 API（工作区对话隔离，预览坞水合） ====================

import type { WorkspaceItemDto } from '@/types/artifactDock'

const mescliWorkspaceItemsApi = {
  /** GET /api/workspace/items?conversationId= —— 该会话归集的产物/上传/呈现条目 */
  list: async (conversationId: number): Promise<WorkspaceItemDto[]> => {
    const res = await fetchApi<{ conversationId: number; items: WorkspaceItemDto[] }>(
      `/api/workspace/items?conversationId=${conversationId}`
    )
    return res.items ?? []
  },
}

const standaloneWorkspaceItemsApi = {
  // Standalone 暂无会话-文件索引（IndexedDB 索引为 P2 项），返回空表示"无水合产物"
  list: async (_conversationId: number): Promise<WorkspaceItemDto[]> => [],
}

export const workspaceItemsApi = IS_STANDALONE ? standaloneWorkspaceItemsApi : mescliWorkspaceItemsApi

// ==================== 配置 API ====================

/**
 * MESCLI 后端种子中部分 Provider 的默认模型较旧，与前端 Standalone 的
 * PROVIDERS 默认模型（参考 learn/02/workshop/AI模型API配置参考手册.md）不一致。
 * 在 MESCLI Local / Online 共享同一套 ProviderConfig 的情况下，前端在展示和
 * 使用前把已知的旧默认模型升级到推荐模型；若用户已自定义为其他模型，则保留。
 */
const OUTDATED_MODELS_BY_PROVIDER: Record<string, string[]> = {
  openai: ['gpt-4o-mini'],
  kimi: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'moonshot-v1-256k', 'kimi-k2'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  'kimi-code': ['opus'],
  qwen: ['qwen-turbo'],
  zhipu: ['glm-4-flash'],
  hunyuan: ['hunyuan-lite'],
  doubao: ['doubao-pro-128k'],
  ernie: ['ernie-speed'],
}

/** 后端 provider id 与前端 PROVIDERS key 的映射（例如 anthropic -> claude） */
const BACKEND_PROVIDER_ID_MAP: Record<string, string> = {
  anthropic: 'claude',
}

export function normalizeBackendProviderConfig(provider: ProviderConfig): ProviderConfig {
  const frontendId = BACKEND_PROVIDER_ID_MAP[provider.provider] || provider.provider
  const canonical = PROVIDERS[frontendId]
  if (!canonical) return provider

  const outdated = OUTDATED_MODELS_BY_PROVIDER[provider.provider] || []
  const shouldUpdateModel =
    !provider.model ||
    provider.model === canonical.defaultModel ||
    outdated.includes(provider.model)

  // MESCLI 后端返回的 ProviderConfig 可能缺少 baseUrl（如 DB 中未填）。
  // OpenAI 兼容 Provider 在 MESCLI Local 下需要直连，空 baseUrl 会拼成相对路径 /v1/chat/completions，
  // 导致 404「请求的资源不存在」。Anthropic 兼容 Provider 在 Local 下走后端代理，不依赖此字段。
  const shouldFillBaseUrl = !provider.baseUrl && canonical.baseUrl

  return {
    ...provider,
    model: shouldUpdateModel ? canonical.defaultModel : provider.model,
    baseUrl: shouldFillBaseUrl ? canonical.baseUrl : provider.baseUrl,
  }
}

const mescliConfigApi = {
  /** GET /api/config/providers */
  getProviders: (): Promise<ProviderConfig[]> =>
    fetchApi<ProviderConfig[]>('/api/config/providers').then((list) =>
      list.map(normalizeBackendProviderConfig)
    ),

  /** GET /api/config/providers/{provider} */
  getProvider: (provider: string): Promise<ProviderConfig> =>
    fetchApi<ProviderConfig>(`/api/config/providers/${provider}`).then((p) =>
      normalizeBackendProviderConfig(p)
    ),

  /** PUT /api/config/providers/{provider} */
  upsertProvider: (provider: string, config: ProviderConfig): Promise<void> =>
    fetchApi<void>(`/api/config/providers/${provider}`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
}

export const configApi = IS_STANDALONE ? standaloneConfigApi : mescliConfigApi

const mescliUserConfigApi = {
  /** GET /api/userconfig */
  getConfigs: (): Promise<UserConfigDto[]> =>
    fetchApi<UserConfigDto[]>('/api/userconfig'),

  /** GET /api/userconfig/{provider} */
  getConfig: (provider: string): Promise<UserConfigDto> =>
    fetchApi<UserConfigDto>(`/api/userconfig/${provider}`),

  /** PUT /api/userconfig/{provider} */
  upsertConfig: (provider: string, config: UserConfigDto): Promise<void> =>
    fetchApi<void>(`/api/userconfig/${provider}`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

  /** GET /api/userconfig/{provider}/apikey */
  getApiKey: (provider: string): Promise<{ apiKey: string }> =>
    fetchApi<{ apiKey: string }>(`/api/userconfig/${provider}/apikey`),
}

export const userConfigApi = IS_STANDALONE ? standaloneUserConfigApi : mescliUserConfigApi

// ==================== 语音 API ====================

const mescliVoiceApi = {
  /** POST /api/voice/recognize */
  recognize: (audioBlob: Blob): Promise<VoiceRecognizeResponse> => {
    const formData = new FormData()
    formData.append('audio', audioBlob, 'recording.webm')

    return fetchApi<VoiceRecognizeResponse>('/api/voice/recognize', {
      method: 'POST',
      body: formData,
    })
  },
}

export const voiceApi = IS_STANDALONE ? standaloneVoiceApi : mescliVoiceApi

// ==================== 附件 API ====================

const mescliAttachmentApi = {
  upload: async (conversationId: number, attachment: FileAttachmentDto): Promise<void> =>
    fetchApi<void>(`/api/attachments/${conversationId}`, {
      method: 'POST',
      body: JSON.stringify(attachment),
    }),

  getAttachments: async (conversationId: number): Promise<FileAttachmentDto[]> =>
    fetchApi<FileAttachmentDto[]>(`/api/attachments/${conversationId}`),

  deleteAttachment: async (attachmentId: string): Promise<void> =>
    fetchApi<void>(`/api/attachments/${attachmentId}`, {
      method: 'DELETE',
    }),
}

export const attachmentApi = IS_STANDALONE ? standaloneAttachmentApi : mescliAttachmentApi

export interface VersionInfo {
  version: string
  downloadUrl: string
  releaseNotes: string
  mandatory: boolean
  /** 下载地址主机白名单（后端配置下发，前端跳转浏览器下载前 fail-closed 校验） */
  allowedHosts?: string[]
}

// ==================== 升级 API ====================

const mescliUpdateApi = {
  /** GET /api/version */
  checkVersion: (): Promise<VersionInfo> =>
    fetchApi<VersionInfo>('/api/version'),

  /** POST /api/version/apply（流式 NDJSON：{"progress":n} 行上报下载进度） */
  applyUpdate: async (
    downloadUrl?: string,
    onProgress?: (percent: number) => void
  ): Promise<{ message: string; installerPath: string }> => {
    const response = await fetch(`${API_BASE}/api/version/apply`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ downloadUrl: downloadUrl || '' }),
      credentials: 'include',
    })

    // 校验阶段的错误仍是普通 JSON 响应
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try {
        const data = (await response.json()) as { error?: string; message?: string }
        message = data?.error || data?.message || message
      } catch {
        // 非 JSON 错误响应，保留默认消息
      }
      throw new ApiError(message, response.status)
    }

    if (!response.body) {
      throw new ApiError('Empty response from update server', 500)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let result = { message: 'Installer started', installerPath: '' }

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        try {
          const data = JSON.parse(line) as {
            progress?: number
            done?: boolean
            message?: string
            error?: string
          }
          if (typeof data.progress === 'number') onProgress?.(data.progress)
          if (data.error) throw new ApiError(data.error, 500)
          if (data.done) {
            result = { message: data.message || result.message, installerPath: '' }
          }
        } catch (err) {
          if (err instanceof ApiError) throw err
          // 单行解析失败忽略，继续读后续行
        }
      }
    }

    return result
  },
}

const standaloneUpdateApi = {
  checkVersion: async (): Promise<VersionInfo> => {
    const url = import.meta.env.VITE_UPDATE_CHECK_URL
    if (!url) {
      return { version: '1.0.0', downloadUrl: '', releaseNotes: '', mandatory: false }
    }
    const response = await fetch(url, { credentials: 'omit' })
    if (!response.ok) {
      throw new ApiError(`Failed to check version: HTTP ${response.status}`, response.status)
    }
    return response.json() as Promise<VersionInfo>
  },

  applyUpdate: async (
    downloadUrl?: string,
    _onProgress?: (percent: number) => void
  ): Promise<{ message: string; installerPath: string }> => {
    const url = downloadUrl || ''
    if (!url) {
      throw new ApiError('Download URL is not configured')
    }
    // Standalone 模式下无法直接执行安装程序，打开下载链接由用户手动安装
    window.open(url, '_blank')
    return { message: 'Download opened', installerPath: url }
  },
}

export const updateApi = IS_STANDALONE ? standaloneUpdateApi : mescliUpdateApi

const mescliCronApiLocal = mescliCronApi

export const cronApi = IS_STANDALONE ? standaloneCronApi : mescliCronApiLocal

export const dagWorkflowApi = IS_STANDALONE ? standaloneDagWorkflowApi : mescliDagWorkflowApi

export interface PluginApi {
  getPlugins(): Promise<InstalledPlugin[]>
  getPlugin(id: string): Promise<InstalledPlugin | undefined>
  installPlugin(file: File): Promise<InstalledPlugin>
  uninstallPlugin(id: string): Promise<void>
  togglePlugin(id: string, isEnabled: boolean): Promise<InstalledPlugin>
}

const mescliPluginApi: PluginApi = {
  getPlugins: async () => fetchApi<InstalledPlugin[]>('/api/plugins'),

  getPlugin: async (id) => fetchApi<InstalledPlugin>(`/api/plugins/${id}`),

  installPlugin: async (file) => {
    const formData = new FormData()
    formData.append('package', file)
    return fetchApi<InstalledPlugin>('/api/plugins/install', {
      method: 'POST',
      body: formData,
    })
  },

  uninstallPlugin: async (id) => {
    await fetchApi<void>(`/api/plugins/${id}`, { method: 'DELETE' })
  },

  togglePlugin: async (id, isEnabled) =>
    fetchApi<InstalledPlugin>(`/api/plugins/${id}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ isEnabled }),
    }),
}

export const pluginApi: PluginApi = IS_STANDALONE ? standalonePluginApi : mescliPluginApi

// ==================== 权限 API ====================

const mescliPermissionApi = {
  /** GET /api/auth/permissions —— 获取当前用户可访问的功能列表 */
  getPermissions: async (): Promise<UserPermissions> => {
    try {
      return await fetchApi<UserPermissions>('/api/auth/permissions')
    } catch (err) {
      // 后端尚未实现时，默认放行所有功能，避免阻塞现有 MESCLI 模式
      if ((err as ApiError).status === 404) {
        return { features: Object.values(FEATURE_FLAGS), isAdmin: true }
      }
      throw err
    }
  },
}

const standalonePermissionApi = {
  getPermissions: async (): Promise<UserPermissions> => ({
    features: Object.values(FEATURE_FLAGS),
    isAdmin: true,
  }),
}

export const permissionApi = IS_STANDALONE ? standalonePermissionApi : mescliPermissionApi

const mescliEmbeddingApi = {
  /** POST /api/embed —— 本地 ONNX embedding（语义搜索的非关键依赖，失败时静默降级） */
  embed: (
    texts: string[]
  ): Promise<{ vectors: number[][]; model: string; dimensions: number; cached: boolean }> =>
    fetchApi('/api/embed', {
      method: 'POST',
      body: JSON.stringify({ texts }),
      silent: true,
    }),
}

const standaloneEmbeddingApi = {
  embed: async (): Promise<never> => {
    throw new ApiError('本地嵌入服务在 Standalone 模式下不可用', 503)
  },
}

export const embeddingApi = IS_STANDALONE ? standaloneEmbeddingApi : mescliEmbeddingApi

// ==================== 导出 ====================

export { ApiError, fetchApi }
export type { StreamChunk }
