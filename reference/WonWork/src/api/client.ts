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
  type WorkspaceDrive,
  type WorkspaceReadResponse,
  type WorkspaceNode,
  type WorkspaceWriteRequest,
  type WorkspaceUploadResult,
  type WorkspaceGrepRequest,
  type WorkspaceGrepResponse,
  type WorkspaceGlobRequest,
  type WorkspaceGlobResponse,
  type ShellTaskEvent,
} from '@/types/mescli'

import {
  standaloneAuthApi,
  standaloneChatApi,
  standaloneHistoryApi,
  standaloneFavoriteApi,
  standaloneConfigApi,
  standaloneUserConfigApi,
  standaloneVoiceApi,
  standaloneAttachmentApi,
  standaloneCronApi,
  standalonePluginApi,
  standaloneToolApi,
  normalizeMessagePayload,
  PROVIDERS,
} from './standaloneApi'
import { mescliCronApi } from './mescli/cronApi'
import { sliceTail, sliceTurnRange, type LayeredMessages } from './historyTurns'
import { useCommercialNoticeStore } from '@/stores/commercialNoticeStore'
import { useRuntimeConfigStore } from '@/stores/runtimeConfigStore'
import type { InstalledPlugin } from '@/types/plugin'
import type {
  MescliPackageListItem,
  MescliPackageMutationResponse,
  MescliPackagePullResponse,
  MescliPackageSystemItem,
  MescliPackageUpdate,
} from '@/types/mescliPackage'
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

  // 管理员提权 token（权限码登录）：与主 token 正交，后端中间件解析后叠加提权标记
  const adminToken = localStorage.getItem('wonclaw_admin_token')
  if (adminToken) {
    headers['X-Admin-Token'] = adminToken
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

/** 401 toast 去重：启动期多个请求并发 401 时只提示一次，避免一屏连弹 */
let lastUnauthorizedToastAt = 0
function toastUnauthorizedOnce(message: string): void {
  const now = Date.now()
  if (now - lastUnauthorizedToastAt < 5000) return
  lastUnauthorizedToastAt = now
  toast.error(message)
}

/** 基础 fetch 封装 */
async function fetchApi<T>(
  path: string,
  options: RequestInit & { silent?: boolean } = {}
): Promise<T> {
  const url = `${API_BASE}${path}`

  // 2026-08-06 竞态修复：发请求时快照凭证。旧 token 的在途请求可能在新登录
  // 完成后才返回 401，401 清理只应在"凭证未变（确属同一会话过期）"时执行，
  // 否则迟到的旧 401 会误清新登录态（现象：刚登录就弹"未登录或会话已过期"）。
  const tokenSnapshot = {
    token: localStorage.getItem('wonclaw_token'),
    websiteToken: localStorage.getItem('wonclaw_website_token'),
  }

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

    // 调用方要求静默时不弹 Toast（如非关键后台服务）；
    // 401 的凭证清理+回登录态属会话卫生，silent 只压其 toast，不跳过清理。
    if (response.status === 401 || !options.silent) {
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
        // 2026-08-06：仅当凭证自请求发出后未变化才清理——迟到的旧 token 401
        // 不动新会话；匿名请求（本就无凭证）的 401 不打扰用户，错误照常抛给调用方。
        const credentialsUnchanged =
          localStorage.getItem('wonclaw_token') === tokenSnapshot.token &&
          localStorage.getItem('wonclaw_website_token') === tokenSnapshot.websiteToken
        const hadStoredCredentials = Boolean(tokenSnapshot.token || tokenSnapshot.websiteToken)
        if (credentialsUnchanged && hadStoredCredentials) {
          if (!options.silent) {
            const friendlyMessage = getErrorMessage(
              { status: 401, message: errorText },
              '认证失败，请重新登录'
            )
            toastUnauthorizedOnce(friendlyMessage)
          }
          try {
            localStorage.removeItem('wonclaw_token')
            localStorage.removeItem('wonclaw_website_token')
            // 清除 MES 透传身份信息，防止 stale header 继续触发后端认证异常
            clearMesLocalState()
            // 刷新一次回到登录态。清理后凭证已空，后续并发 401 不会重复刷新，
            // 错误的运行模式或临时后端异常也不会造成无限刷新循环。
            // 2026-07-31：刷新前留旗标——reload 后 toast 已失，登录页据此显示
            // "登录状态已过期"静态说明，用户不至于莫名被踢回登录页。
            try {
              sessionStorage.setItem('wonclaw_session_expired', '1')
            } catch {
              // sessionStorage 不可用时静默降级（只是少一行解释）
            }
            window.location.reload()
          } catch {
            // localStorage 操作失败不应阻塞错误抛出
          }
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
  /** GET /api/history —— pageSize 缺省给足：前端会话列表是全量排序展示，不分页 */
  getConversations: (page = 1, pageSize = 10000): Promise<Conversation[]> =>
    fetchApi<Conversation[]>(`/api/history?page=${page}&pageSize=${pageSize}`),

  /** POST /api/history */
  createConversation: (req: CreateConversationRequest): Promise<{ id: number; title: string; parentConversationId?: number | null }> =>
    fetchApi<{ id: number; title: string; parentConversationId?: number | null }>('/api/history', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  /** PUT /api/history/{conversationId}/task-state —— 任务会话状态机回写（2026-09-01 二阶段） */
  updateTaskState: (conversationId: number, taskState: 'running' | 'done' | 'error' | 'cancelled'): Promise<void> =>
    fetchApi<void>(`/api/history/${conversationId}/task-state`, {
      method: 'PUT',
      body: JSON.stringify({ taskState }),
    }),

  /** PUT /api/history/{conversationId}/project —— 项目目录绑定（2026-09-09 二阶段；path=null 解绑）。
   *  silent：绑定失败由调用方内存态如实呈现（绑定即 UI 状态，无幽灵 toast） */
  setConversationProject: (conversationId: number, path: string | null): Promise<void> =>
    fetchApi<void>(`/api/history/${conversationId}/project`, {
      method: 'PUT',
      body: JSON.stringify({ path }),
      silent: true,
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

  /** GET /api/history/{conversationId}/messages?tailTurns=N —— §16.6 分层加载：尾 N 轮全量+更早轮轻量行 */
  getMessagesTail: (conversationId: number, tailTurns: number): Promise<LayeredMessages> =>
    fetchApi<LayeredMessages>(`/api/history/${conversationId}/messages?tailTurns=${tailTurns}`),

  /** GET /api/history/{conversationId}/messages/turns?fromTurn=&toTurn= —— §16.6 按轮补拉全量行 */
  getMessagesTurnRange: (conversationId: number, fromTurn: number, toTurn: number): Promise<Message[]> =>
    fetchApi<Message[]>(`/api/history/${conversationId}/messages/turns?fromTurn=${fromTurn}&toTurn=${toTurn}`),

  /** POST /api/history/{conversationId}/messages */
  saveMessage: (conversationId: number, message: Message): Promise<void> =>
    fetchApi<void>(`/api/history/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify(message),
    }),

  /** PUT /api/history/{conversationId}/messages/tool/{toolCallId} —— P0-5b 折叠写回（2026-08-04 起后端已实现） */
  updateToolMessageContent: (conversationId: number, toolCallId: string, content: string): Promise<void> =>
    fetchApi<void>(`/api/history/${conversationId}/messages/tool/${encodeURIComponent(toolCallId)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  /** DELETE /api/history/{conversationId} */
  deleteConversation: (conversationId: number): Promise<void> =>
    fetchApi<void>(`/api/history/${conversationId}`, {
      method: 'DELETE',
    }),
}

/**
 * 历史双写向前 + 读合并（2026-08-04，替代 r74 的纯 IndexedDB 方案）。
 *
 * 背景：r74（07-10）把历史切到纯 IndexedDB 后，后端 AiConversation 再无新数据，
 * admin_list_conversations 等后端视角全部失真；r235 统一了后端存储管道（UserDataStore=Local
 * → LocalHistoryService/SQLite），此处把前端最后一截接上。
 *
 * 语义：
 * - 新会话只写后端（后端 SQLite 即本机持久层——后端不可用时整个应用也不可用，不存在
 *   "后端挂了还要写历史"的离线场景），IndexedDB 不再新增，避免双写不一致。
 * - IndexedDB 存量会话（r74 时代）不迁移、原样可读：getConversations 合并两路返回。
 * - 路由按 id 水位线无状态判定：id ≥ 1e9 → 后端，否则 → IndexedDB 存量。
 *   水位线由 LocalDbInitializer 抬升（sqlite_sequence 起步 1e9），保证新后端 id 与
 *   IndexedDB 存量小 id 永不相交——分支锚点/压缩边界/记忆游标等嵌会话 id 的跨模块 key 零迁移。
 * - 水位线之前的后端遗留行（id < 1e9，r74 之前 dev 时代写入）有意不合并进列表：
 *   它们自 r74 起就不可见，且与 IndexedDB 存量 id 撞号，合并会让路由歧义。
 *   admin_list_conversations 后端视角仍可见，不丢审计。
 * - Standalone（无后端）不走这里，维持纯 IndexedDB。
 */
const BACKEND_HISTORY_ID_FLOOR = 1_000_000_000

/**
 * Local 用户数据车道闸门（2026-08-04）：仅当后端 runtime-config 明确本身份在 Local 车道
 * （水位线 SQLite）时才把用户数据（历史/记忆）读写路由到后端。Online 车道一律回退纯浏览器存储——
 * fail-safe 方向：错走本地只是暂缓上后端，错走后端=新数据被路由/水位线过滤"创建即消失"。
 *
 * 必须等 runtime-config 加载完再判定：启动时数据加载与 config 拉取并发，
 * 未加载就放行会判成"纯本地"，导致新会话刷新后从侧栏消失（2026-08-04 实测回归）。
 */
export async function useLocalUserDataStore(): Promise<boolean> {
  const store = useRuntimeConfigStore.getState()
  if (!store.loaded) await store.load()
  return useRuntimeConfigStore.getState().config.localUserDataStore === true
}

// 历史存储沿用原别名（调用点零改动）
const useBackendHistory = useLocalUserDataStore

/** SQLite datetime('now') 是 UTC 但序列化无时区后缀，浏览器 Date.parse 会误当本地时间（+8 区差 8 小时）。
 * 统一补 Z 再解析——会话排序、消息时间戳、压缩边界 cutoffTs 比较都依赖正确纪元毫秒。 */
function utcIso(s: string): string {
  if (s.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(s)) return s
  return s.replace(' ', 'T') + 'Z'
}

/** 后端 Message 核心列（与 AiMessage 表/Models.Message.cs 对齐；reasoningContent 在模型里但无对应列，归 extras） */
const HISTORY_CORE_KEYS = new Set([
  'role', 'content', 'toolCalls', 'toolCallId', 'toolCallName', 'toolCallStatus',
  'structuredData', 'thinkingProcess', 'webBridgeState', 'renderNodes',
])
/** 不入库的会话内瞬态字段：id/时间戳（库层赋 CreatedAt）/IndexedDB 外键/流式标记/wireContent（冻结仅会话内，持久化 defer P2）/分层加载线字段（index/turnIndex/light，查询期标注，落库即污染 extras） */
const HISTORY_TRANSIENT_KEYS = new Set(['id', 'createdAt', 'timestamp', 'conversationId', 'isStreaming', 'wireContent', 'index', 'turnIndex', 'light'])

/**
 * 历史保真打包（2026-08-04 审计修复）：核心列之外的字段（sentTurns/reasoningContent/
 * isSupplement/isSystemEvent/rounds/answers/attachments 等）整体进 extras 不透明往返——
 * 恢复 IndexedDB 时代的全字段 round-trip，缺 sentTurns 会让 P0-5a 前缀缓存保真在重载后失效。
 */
function toBackendMessagePayload(message: Message): Record<string, unknown> {
  const core: Record<string, unknown> = {}
  const extras: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(message as unknown as Record<string, unknown>)) {
    if (v === undefined) continue
    if (HISTORY_CORE_KEYS.has(k)) core[k] = v
    else if (!HISTORY_TRANSIENT_KEYS.has(k)) extras[k] = v
  }
  // 原始毫秒时间戳经 extras 往返（2026-08-05 精度修复）：后端 datetime('now') 只有秒级，
  // 重载后同秒消息的 cutoffTs/分支锚点比较会翻转；客户端发言时刻才是语义时间。
  const ts = (message as unknown as { timestamp?: unknown }).timestamp
  if (typeof ts === 'number') extras.clientTs = ts
  if (Object.keys(extras).length > 0) core.extras = extras
  return core
}

/** extras 展开还原 + CreatedAt 归一（UTC 补 Z，chatStore 据它恢复消息真实时间戳/压缩边界语义） */
function fromBackendMessage(m: Message): Message {
  const { extras, createdAt, ...rest } = normalizeMessagePayload(m) as Message & {
    extras?: Record<string, unknown>
    createdAt?: string
  }
  const restored = { ...(extras || {}), ...rest } as Message & { createdAt?: string }
  if (createdAt) restored.createdAt = utcIso(createdAt)
  return restored
}

/**
 * 消息级写穿缓存（2026-08-04 体验修复）：历史走 HTTP 后，每次点开会话都要
 * 后端查询 + 全量 JSON（含 RenderNodes 大载荷）序列化 + 代理解析，长会话要几百 ms，
 * 表现为"内容空一下再弹出"。缓存后二次打开零成本。
 * 一致性：所有写路径（saveMessage 追加 / 折叠写回 / delete 失效）都经过本对象，
 * 写成功后同步更新缓存——单用户单实例下无第三方改库入口，无失效难题。
 * LRU 上限防长会话 RenderNodes 载荷无限占用内存。
 */
const MESSAGE_CACHE_LIMIT = 10
const messageCache = new Map<number, Message[]>()

function messageCacheGet(conversationId: number): Message[] | undefined {
  const cached = messageCache.get(conversationId)
  if (cached) {
    // LRU：命中即提到最新
    messageCache.delete(conversationId)
    messageCache.set(conversationId, cached)
  }
  return cached
}

function messageCachePut(conversationId: number, messages: Message[]): void {
  messageCache.delete(conversationId)
  messageCache.set(conversationId, messages)
  while (messageCache.size > MESSAGE_CACHE_LIMIT) {
    const oldest = messageCache.keys().next().value
    if (oldest === undefined) break
    messageCache.delete(oldest)
  }
}

/**
 * 缓存版本戳（2026-08-04 审计修复）：GET 在途期间发生的任何写（saveMessage/折叠写回/删除）
 * 都会 bump 版本，GET 完成后版本已变则丢弃结果不入缓存——修"长会话加载中发新消息，
 * 旧响应固化成缓存导致整会话期消息丢失"的竞态；删除后在途 GET 复活缓存项同理被挡。
 */
const cacheVersions = new Map<number, number>()
const bumpCacheVersion = (id: number) => cacheVersions.set(id, (cacheVersions.get(id) ?? 0) + 1)
const cacheVersion = (id: number) => cacheVersions.get(id) ?? 0

const syncedHistoryApi = {
  getConversations: async (): Promise<Conversation[]> => {
    if (!(await useBackendHistory())) return standaloneHistoryApi.getConversations()
    const [backend, local] = await Promise.all([
      // 后端不可达（如未登录 401/网络异常）时降级为纯本地列表，不阻塞入口
      mescliHistoryApi.getConversations().catch(() => [] as Conversation[]),
      standaloneHistoryApi.getConversations().catch(() => [] as Conversation[]),
    ])
    return [
      ...backend
        .filter((c) => c.id >= BACKEND_HISTORY_ID_FLOOR)
        .map((c) => ({
          ...c,
          source: 'backend' as const,
          // UTC 归一：侧栏相对时间/合并排序都靠它（SQLite datetime 无时区后缀）
          createdAt: utcIso(c.createdAt),
          updatedAt: utcIso(c.updatedAt),
        })),
      ...local.map((c) => ({ ...c, source: 'local' as const })),
    ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  },

  createConversation: async (req: CreateConversationRequest): Promise<{ id: number; title: string }> => {
    if (!(await useBackendHistory())) return standaloneHistoryApi.createConversation(req)
    return mescliHistoryApi.createConversation(req)
  },

  /** 任务会话状态回写（2026-09-01 二阶段）：与 updateTitle 同路由规则 */
  updateTaskState: async (conversationId: number, taskState: 'running' | 'done' | 'error' | 'cancelled'): Promise<void> => {
    if ((await useBackendHistory()) && conversationId >= BACKEND_HISTORY_ID_FLOOR)
      return mescliHistoryApi.updateTaskState(conversationId, taskState)
    return standaloneHistoryApi.updateTaskState(conversationId, taskState)
  },

  /** 项目目录绑定（2026-09-09 二阶段）：与 updateTitle 同路由规则（Local 车道落列，其余落 IndexedDB 记录字段） */
  setConversationProject: async (conversationId: number, path: string | null): Promise<void> => {
    if ((await useBackendHistory()) && conversationId >= BACKEND_HISTORY_ID_FLOOR)
      return mescliHistoryApi.setConversationProject(conversationId, path)
    return standaloneHistoryApi.setConversationProject(conversationId, path)
  },

  updateTitle: async (conversationId: number, req: UpdateTitleRequest): Promise<void> => {
    if ((await useBackendHistory()) && conversationId >= BACKEND_HISTORY_ID_FLOOR)
      return mescliHistoryApi.updateTitle(conversationId, req)
    return standaloneHistoryApi.updateTitle(conversationId, req)
  },

  getMessages: async (conversationId: number): Promise<Message[]> => {
    const cached = messageCacheGet(conversationId)
    if (cached) return cached
    const versionAtStart = cacheVersion(conversationId)
    const messages =
      (await useBackendHistory()) && conversationId >= BACKEND_HISTORY_ID_FLOOR
        ? (await mescliHistoryApi.getMessages(conversationId)).map(fromBackendMessage)
        : await standaloneHistoryApi.getMessages(conversationId)
    // 在途期间有写则结果已过期，丢弃不入缓存（下次重新拉取）
    if (cacheVersion(conversationId) === versionAtStart) messageCachePut(conversationId, messages)
    return messages
  },

  /**
   * 分层历史（2026-09-02 §16.6）：尾 tailTurns 轮全量 + 更早轮轻量行（带 index/turnIndex/light）。
   * 有意不走消息级写穿缓存：缓存存的是全量形状，轻量行化会删掉字段，
   * 切片若落在缓存对象上会污染全量缓存（saveMessage 写穿复用同一引用）。
   * IndexedDB 存量车道无后端切片，本地内存切片成同形状。
   */
  getMessagesTail: async (conversationId: number, tailTurns: number): Promise<LayeredMessages> => {
    if ((await useBackendHistory()) && conversationId >= BACKEND_HISTORY_ID_FLOOR) {
      const res = await mescliHistoryApi.getMessagesTail(conversationId, tailTurns)
      // 版本错配兜底：旧后端不识 tailTurns 参数会回 legacy 纯数组——按全量非分层处理，
      // 不让 undefined.map 把加载打挂（前后端同版本发布是常态，此分支只是软着陆）
      if (Array.isArray(res)) return { messages: (res as unknown as Message[]).map(fromBackendMessage), totalTurns: 0 }
      return { messages: res.messages.map(fromBackendMessage), totalTurns: res.totalTurns }
    }
    const local = await standaloneHistoryApi.getMessages(conversationId)
    return sliceTail(local, tailTurns)
  },

  /** 按轮补拉（§16.6）：turns [fromTurn, toTurn) 全量行；本地车道内存切片 */
  getMessagesTurnRange: async (conversationId: number, fromTurn: number, toTurn: number): Promise<Message[]> => {
    if ((await useBackendHistory()) && conversationId >= BACKEND_HISTORY_ID_FLOOR)
      return (await mescliHistoryApi.getMessagesTurnRange(conversationId, fromTurn, toTurn)).map(fromBackendMessage)
    const local = await standaloneHistoryApi.getMessages(conversationId)
    return sliceTurnRange(local, fromTurn, toTurn)
  },

  saveMessage: async (conversationId: number, message: Message): Promise<void> => {
    bumpCacheVersion(conversationId)
    if ((await useBackendHistory()) && conversationId >= BACKEND_HISTORY_ID_FLOOR)
      await mescliHistoryApi.saveMessage(conversationId, toBackendMessagePayload(message) as unknown as Message)
    else await standaloneHistoryApi.saveMessage(conversationId, message)
    // 写穿：持久化成功后追加到缓存，保持与存储层同序
    messageCacheGet(conversationId)?.push(message)
  },

  updateToolMessageContent: async (conversationId: number, toolCallId: string, content: string): Promise<void> => {
    bumpCacheVersion(conversationId)
    if ((await useBackendHistory()) && conversationId >= BACKEND_HISTORY_ID_FLOOR)
      await mescliHistoryApi.updateToolMessageContent(conversationId, toolCallId, content)
    else await standaloneHistoryApi.updateToolMessageContent(conversationId, toolCallId, content)
    // 写穿：折叠写回同步到缓存（与 IndexedDB/后端一样只改首个命中行）
    const target = messageCacheGet(conversationId)?.find((m) => m.toolCallId === toolCallId)
    if (target) target.content = content
  },

  deleteConversation: async (conversationId: number): Promise<void> => {
    bumpCacheVersion(conversationId)
    messageCache.delete(conversationId)
    if ((await useBackendHistory()) && conversationId >= BACKEND_HISTORY_ID_FLOOR) {
      await mescliHistoryApi.deleteConversation(conversationId)
      // 顺手清扫 IndexedDB 里同会话 id 的附件/消息残留（附件管道仍在前端本地）；
      // 水位线保证该 id 不属于任何本地存量会话，不会误删
      await standaloneHistoryApi.deleteConversation(conversationId).catch(() => {})
      return
    }
    return standaloneHistoryApi.deleteConversation(conversationId)
  },
}

// 历史会话：Standalone 无后端走纯 IndexedDB；其余模式走后端权威 + IndexedDB 存量合并（syncedHistoryApi）。
export const historyApi = IS_STANDALONE ? standaloneHistoryApi : syncedHistoryApi

// ==================== 收藏夹 API ====================

// 2026-07-31 反馈去重：favoriteStore 的 catch 已按场景弹上下文文案，
// API 层统一 silent，避免同一失败双 toast（401 会话清理不受 silent 影响）。
const mescliFavoriteApi = {
  /** GET /api/favorite */
  getFavorites: (): Promise<FavoriteItem[]> =>
    fetchApi<FavoriteItem[]>('/api/favorite', { silent: true }),

  /** POST /api/favorite */
  addFavorite: (req: AddFavoriteRequest): Promise<{ id: number; title: string; prompt: string }> =>
    fetchApi<{ id: number; title: string; prompt: string }>('/api/favorite', {
      method: 'POST',
      body: JSON.stringify(req),
      silent: true,
    }),

  /** PUT /api/favorite/{id} */
  updateFavorite: (id: number, req: UpdateFavoriteRequest): Promise<void> =>
    fetchApi<void>(`/api/favorite/${id}`, {
      method: 'PUT',
      body: JSON.stringify(req),
      silent: true,
    }),

  /** DELETE /api/favorite/{id} */
  deleteFavorite: (id: number): Promise<void> =>
    fetchApi<void>(`/api/favorite/${id}`, {
      method: 'DELETE',
      silent: true,
    }),
}

export const favoriteApi = IS_STANDALONE ? standaloneFavoriteApi : mescliFavoriteApi

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
    // [probe] 2026-08-31 排查"发送前置段慢"——定位 ensureSessionTools vs conventions 耗时，取证后移除
    const t0 = performance.now()
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
    const parsed = (await response.json()) as CapabilitiesResponse
    console.log(`[probe] capabilitiesFull: ${(performance.now() - t0).toFixed(0)}ms`)
    return parsed
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
      /** 后端 SSE progress 事件（如 pip 安装日志）实时回调；2026-07-31 进度动脉修复 */
      onProgress?: (message: string) => void
      /** 用户中断信号：abort 会关闭 SSE 连接，后端 RequestAborted 联动取消执行令牌
       * （2026-08-28 审计实锤的"假取消"修复——此前中断只改前端文案，后端写工具照跑） */
      signal?: AbortSignal
    }
  ): Promise<ToolInvokeResult> => {
    const response = await fetch(`${API_BASE}/api/tools/execute`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(request),
      credentials: 'include',
      signal: options?.signal ?? null,
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
        // 进度动脉：除了归约进最终结果，还要实时透传给瀑布节点（pip 安装等长任务可见）
        try {
          options?.onProgress?.(progress)
        } catch {
          // 进度回调异常不得中断工具执行流
        }
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
      // 发现原语在 Agent 循环内调用：错误作为工具结果回喂模型并留在瀑布流节点，不弹 Toast 打扰用户
      silent: true,
    }),

  /** GET /api/capabilities/tree —— 文件系统式能力浏览（v1.5） */
  tree: (path = '/', systemCode?: string): Promise<CapabilityTreeResponse> => {
    const params = new URLSearchParams()
    params.set('path', path)
    if (systemCode) params.set('systemCode', systemCode)
    return fetchApi<CapabilityTreeResponse>(`/api/capabilities/tree?${params.toString()}`, { silent: true })
  },

  /** GET /api/capabilities/all —— 全量扁平能力清单（v1.6，供 /capabilities 虚拟文件系统本地 grep/glob） */
  all: (systemCode?: string): Promise<ToolCatalogItem[]> => {
    const params = new URLSearchParams()
    if (systemCode) params.set('systemCode', systemCode)
    const query = params.toString()
    return fetchApi<ToolCatalogItem[]>(`/api/capabilities/all${query ? `?${query}` : ''}`, { silent: true })
  },

  /** GET /api/capabilities/schema —— 读取指定路径工具的完整 schema（v1.5） */
  schema: (path: string, systemCode?: string): Promise<CapabilitySchemaResponse> => {
    const params = new URLSearchParams()
    params.set('path', path)
    if (systemCode) params.set('systemCode', systemCode)
    return fetchApi<CapabilitySchemaResponse>(`/api/capabilities/schema?${params.toString()}`, { silent: true })
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

  /** GET /api/workspace/list —— 列出目录节点。browse=浏览面板用户通道（跳过登记闸，见后端注释） */
  list: (path = '/workspace', recursive = false, browse = false): Promise<WorkspaceListResponse> =>
    // silent：浏览面板把 409 目录挑战转灰态授权卡、把失败转内联错误态——
    // 非 silent 会让每次浏览挑战先弹一个全局 toast 再显示灰态（双份呈现）
    fetchApi<WorkspaceListResponse>(
      `/api/workspace/list?path=${encodeURIComponent(path)}${recursive ? '&recursive=true' : ''}${browse ? '&browse=true' : ''}`,
      { silent: true }
    ),

  /** GET /api/workspace/read —— 读取文件内容与元数据；offset/limit（1-based 行切片）下沉服务端，大文件不整读 */
  read: (path: string, offset?: number, limit?: number, browse = false): Promise<WorkspaceReadResponse> =>
    // silent：read 的全部调用方都在工具/适配器路径（backendWorkspaceAdapter），
    // "文件不存在"是读工具的正常答案——适配器兜住后以工具结果回给模型，
    // 404 toast 会让用户看到没有任何瀑布节点对应的莫名报错（子 Agent 内部步骤不渲染）。
    fetchApi<WorkspaceReadResponse>(
      `/api/workspace/read?path=${encodeURIComponent(path)}` +
        `${offset !== undefined ? `&offset=${offset}` : ''}${limit !== undefined ? `&limit=${limit}` : ''}${browse ? '&browse=true' : ''}`,
      {
        silent: true,
      }
    ),

  /** POST /api/workspace/write —— 写入或覆盖/追加文件 */
  write: (
    path: string,
    content: string,
    append?: boolean,
    encoding?: 'utf-8' | 'base64',
    browse = false
  ): Promise<WorkspaceNode> =>
    // silent：同类治理——写失败由工具结果/catch 传达（writeFileTool success:false、
    // explore 落盘 catch 降级），不弹无节点对应的 toast。
    // browse=true=浏览面板用户通道（2026-09-09 二阶段）：只跳登记闸，与 open/rename/mkdir/delete 同款
    fetchApi<WorkspaceNode>('/api/workspace/write', {
      method: 'POST',
      body: JSON.stringify({ path, content, append, encoding, browse } as WorkspaceWriteRequest),
      silent: true,
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

  /** DELETE /api/workspace/delete —— 删除文件或目录；recursive=允许非空目录，recycle=进系统回收站（Windows），browse=面板用户通道（跳登记闸） */
  delete: (path: string, opts?: { recursive?: boolean; recycle?: boolean; browse?: boolean }): Promise<{ recycled?: boolean }> =>
    fetchApi<{ recycled?: boolean }>(
      `/api/workspace/delete?path=${encodeURIComponent(path)}${opts?.recursive ? '&recursive=true' : ''}${opts?.recycle ? '&recycle=true' : ''}${opts?.browse ? '&browse=true' : ''}`,
      {
        method: 'DELETE',
      }
    ),

  /** POST /api/workspace/open —— 用系统默认程序打开（.docx→Word、.xlsx→Excel；browse=面板用户通道） */
  open: (path: string, browse = false): Promise<{ path: string }> =>
    fetchApi<{ path: string }>('/api/workspace/open', {
      method: 'POST',
      body: JSON.stringify({ path, browse }),
      silent: true,
    }),

  /** POST /api/workspace/rename —— 同目录重命名（400=非法名称，409=同名已存在） */
  rename: (path: string, newName: string, browse = false): Promise<{ path: string; name: string }> =>
    fetchApi<{ path: string; name: string }>('/api/workspace/rename', {
      method: 'POST',
      body: JSON.stringify({ path, newName, browse }),
      silent: true,
    }),

  /** POST /api/workspace/mkdir —— 新建文件夹（path=父目录+新名，409=已存在） */
  mkdir: (path: string, browse = false): Promise<{ path: string; name: string }> =>
    fetchApi<{ path: string; name: string }>('/api/workspace/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path, browse }),
      silent: true,
    }),

  /** POST /api/workspace/grep —— 服务端内容检索（2026-08-02）：一次请求替代 N+1 串行读。
   *  silent：端点缺失（旧后端）时适配器静默回退前端并发扫读，不弹无节点对应的 toast。 */
  grep: (request: WorkspaceGrepRequest): Promise<WorkspaceGrepResponse> =>
    fetchApi<WorkspaceGrepResponse>('/api/workspace/grep', {
      method: 'POST',
      body: JSON.stringify(request),
      silent: true,
    }),

  /** POST /api/workspace/glob —— 服务端 glob（2026-09-01 P0-7）。
   *  silent：端点缺失（旧后端）时适配器静默回退"列举+本地过滤"，不弹无节点对应的 toast。 */
  glob: (request: WorkspaceGlobRequest): Promise<WorkspaceGlobResponse> =>
    fetchApi<WorkspaceGlobResponse>('/api/workspace/glob', {
      method: 'POST',
      body: JSON.stringify(request),
      silent: true,
    }),

  // ---------- P0-3 挂载点登记制（已登记目录根，机器级持久） ----------

  /** GET /api/workspace/roots —— 已登记目录根列表（roots=持久层，sessionRoots=会话层） */
  listRoots: (): Promise<{ roots: string[]; sessionRoots?: string[] }> =>
    fetchApi<{ roots: string[]; sessionRoots?: string[] }>('/api/workspace/roots', { silent: true }),

  /** GET /api/workspace/conventions —— 约定文件发现（CLAUDE.md 分层：用户/工作区/项目/cwd 链） */
  conventions: (): Promise<{
    files: { path: string; scope: string; content: string; truncated: boolean }[]
    skipped: number
  }> => {
    // [probe] 2026-08-31 排查"发送前置段慢"——定位 ensureSessionTools vs conventions 耗时，取证后移除
    const t0 = performance.now()
    return fetchApi<{
      files: { path: string; scope: string; content: string; truncated: boolean }[]
      skipped: number
    }>('/api/workspace/conventions', { silent: true }).then((r) => {
      console.log(`[probe] conventions: ${(performance.now() - t0).toFixed(0)}ms`)
      return r
    })
  },

  /**
   * POST /api/workspace/roots —— 登记目录根（审批卡触达）。
   * scope='session'：会话层（内存，审批"允许/本对话不再询问"）；缺省：持久层（"始终允许"）。
   */
  registerRoot: (
    path: string,
    scope?: 'session'
  ): Promise<{ path: string; roots: string[]; sessionRoots?: string[] }> =>
    fetchApi<{ path: string; roots: string[]; sessionRoots?: string[] }>('/api/workspace/roots', {
      method: 'POST',
      body: JSON.stringify(scope ? { path, scope } : { path }),
      silent: true,
    }),

  /** DELETE /api/workspace/roots —— 撤销目录根登记 */
  unregisterRoot: (path: string): Promise<void> =>
    fetchApi<void>(`/api/workspace/roots?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
      silent: true,
    }),

  /** GET /api/workspace/download —— 统一下载端点（双根共用，attachment 强制下载） */
  downloadUrl: (path: string, browse = false): string =>
    `/api/workspace/download?path=${encodeURIComponent(path)}${browse ? '&browse=true' : ''}`,

  /** GET /api/workspace/preview —— 内联预览端点（正确 Content-Type，供 img/fetch 展示） */
  previewUrl: (path: string, browse = false): string =>
    `/api/workspace/preview?path=${encodeURIComponent(path)}${browse ? '&browse=true' : ''}`,

  // ---------- 后台命令任务（2026-09-01 二阶段切片2，run_command run_in_background 配套） ----------

  /** GET /api/workspace/shell/tasks/{id}/wait —— 事件长等待（非轮询）：exited/stalled 即返回，
   *  无事件服务端挂起至多 120s 回 heartbeat；任务不存在（后端重启）404。silent：任务丢失是
   *  正常生命周期事件，由 watcher 转成对话内通知，不弹 toast。 */
  waitShellTask: (taskId: string, signal?: AbortSignal): Promise<ShellTaskEvent> =>
    fetchApi<ShellTaskEvent>(`/api/workspace/shell/tasks/${encodeURIComponent(taskId)}/wait`, {
      silent: true,
      signal: signal ?? null,
    }),

  /** POST /api/workspace/shell/tasks/{id}/stop —— 终止后台命令任务（整棵进程树） */
  stopShellTask: (taskId: string): Promise<{ stopped: boolean }> =>
    fetchApi<{ stopped: boolean }>(`/api/workspace/shell/tasks/${encodeURIComponent(taskId)}/stop`, {
      method: 'POST',
      silent: true,
    }),

  /** GET /api/workspace/drives —— 本机固定盘枚举（浏览目录浮层「我的电脑」位点；
   *  只报环境事实，不走登记闸；进具体盘仍按 409 挑战逐盘授权） */
  drives: (): Promise<{ drives: WorkspaceDrive[] }> =>
    fetchApi<{ drives: WorkspaceDrive[] }>('/api/workspace/drives', { silent: true }),

  /** POST /api/workspace/reveal —— 在系统文件管理器中打开/选中（浏览目录浮层配套，
   *  本机动作无副作用；browse=面板用户通道；未登记目录 409 挑战由调用方自行消化，不弹 toast） */
  reveal: (path: string, browse = false): Promise<{ path: string }> =>
    fetchApi<{ path: string }>('/api/workspace/reveal', {
      method: 'POST',
      body: JSON.stringify({ path, browse }),
      silent: true,
    }),
}

const standaloneWorkspaceApi = {
  info: async (): Promise<{ rootPath: string | null }> => ({ rootPath: null }),
  drives: async (): Promise<{ drives: WorkspaceDrive[] }> => ({ drives: [] }),
  list: async (): Promise<WorkspaceListResponse> => ({ path: '/workspace', nodes: [] }),
  read: async (path: string, _offset?: number, _limit?: number): Promise<WorkspaceReadResponse> => ({
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
  delete: async (): Promise<{ recycled?: boolean }> => ({}),
  // Standalone 无本机文件系统写能力（重命名/新建/默认程序打开均为 MESCLI Local 后端能力）
  open: async (_path?: string, _browse?: boolean): Promise<{ path: string }> => {
    throw new ApiError('打开文件需要 MESCLI Local 后端', 501)
  },
  rename: async (): Promise<{ path: string; name: string }> => {
    throw new ApiError('重命名需要 MESCLI Local 后端', 501)
  },
  mkdir: async (): Promise<{ path: string; name: string }> => {
    throw new ApiError('新建文件夹需要 MESCLI Local 后端', 501)
  },

  // Standalone 无服务端检索（IndexedDB 适配器在前端内存自扫），返回空结果保持类型对齐
  grep: async (_request: WorkspaceGrepRequest): Promise<WorkspaceGrepResponse> => ({
    matches: [],
    truncated: false,
    scannedFiles: 0,
  }),

  // Standalone 无服务端 glob（IndexedDB 适配器在前端内存自扫），返回空结果保持类型对齐
  glob: async (_request: WorkspaceGlobRequest): Promise<WorkspaceGlobResponse> => ({
    matches: [],
    truncated: false,
    scannedFiles: 0,
  }),

  // ---------- P0-3 挂载点登记制：Standalone 无本机目录概念，恒空 ----------
  listRoots: async (): Promise<{ roots: string[]; sessionRoots?: string[] }> => ({ roots: [] }),
  conventions: async (): Promise<{ files: { path: string; scope: string; content: string; truncated: boolean }[]; skipped: number }> => ({ files: [], skipped: 0 }),
  registerRoot: async (): Promise<{ path: string; roots: string[]; sessionRoots?: string[] }> => {
    throw new ApiError('目录登记需要 MESCLI Local 后端', 400)
  },
  unregisterRoot: async (): Promise<void> => {},
  downloadUrl: (path: string, _browse?: boolean): string => path,
  // Standalone 暂无二进制内联预览（IndexedDB 不存二进制），透传虚拟路径
  previewUrl: (path: string, _browse?: boolean): string => path,
  // Standalone 无本机 shell（命令执行是 MESCLI Local 后端能力）
  waitShellTask: async (): Promise<ShellTaskEvent> => {
    throw new ApiError('后台命令任务需要 MESCLI Local 后端', 400)
  },
  stopShellTask: async (): Promise<{ stopped: boolean }> => ({ stopped: false }),
  // Standalone 无本机文件管理器（打开系统资源管理器是 MESCLI Local 后端能力）
  reveal: async (_path?: string, _browse?: boolean): Promise<{ path: string }> => {
    throw new ApiError('在文件管理器中打开需要 MESCLI Local 后端', 501)
  },}

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

  /** GET /api/userconfig/{provider}
   *  silent：唯一调用方 resolveProviderCredentials 把 404 当"未配置 baseUrl 覆盖"的正常分支
   *  （catch 后回落 provider 默认 baseUrl）——后端该路由对未配置 provider 返回裸 NotFound，
   *  不 silent 每次凭证解析都弹"请求的资源不存在"toast（apikey 路由已同款修复：404 改返回空串） */
  getConfig: (provider: string): Promise<UserConfigDto> =>
    fetchApi<UserConfigDto>(`/api/userconfig/${provider}`, { silent: true }),

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

// ==================== 数据库连接配置（开发者选项） ====================

export interface ConnectionProfileInfo {
  name: string
  server: string
  database: string
  userId: string
  isActive: boolean
}

export interface ConnectionConfigInfo {
  systemCode: string
  server: string
  database: string
  userId: string
  hasPassword: boolean
  /** override=自定义覆盖；default=appsettings 默认 */
  source: 'override' | 'default'
  /** 当前生效连接匹配的命名配置名；无匹配（临时覆盖/默认）为 null */
  activeProfile: string | null
  profiles: ConnectionProfileInfo[]
}

export interface ConnectionConfigInput {
  server: string
  database: string
  userId: string
  password: string
}

export interface ConnectionProfileInput extends ConnectionConfigInput {
  name: string
}

const mescliConnectionApi = {
  /** GET /api/connections/{systemCode} */
  getConnection: (systemCode: string): Promise<ConnectionConfigInfo> =>
    fetchApi<ConnectionConfigInfo>(`/api/connections/${encodeURIComponent(systemCode)}`),

  /** PUT /api/connections/{systemCode}（临时覆盖：先试连，成功才落盘，即时生效） */
  saveConnection: (systemCode: string, config: ConnectionConfigInput): Promise<{ message: string }> =>
    fetchApi<{ message: string }>(`/api/connections/${encodeURIComponent(systemCode)}`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

  /** POST /api/connections/{systemCode}/test（仅试连不落盘） */
  testConnection: (systemCode: string, config: ConnectionConfigInput): Promise<{ message: string }> =>
    fetchApi<{ message: string }>(`/api/connections/${encodeURIComponent(systemCode)}/test`, {
      method: 'POST',
      body: JSON.stringify(config),
    }),

  /** DELETE /api/connections/{systemCode}（移除覆盖，回退默认；不影响已保存的命名配置） */
  resetConnection: (systemCode: string): Promise<{ message: string }> =>
    fetchApi<{ message: string }>(`/api/connections/${encodeURIComponent(systemCode)}`, {
      method: 'DELETE',
    }),

  /** POST /api/connections/{systemCode}/profiles（保存命名配置并激活，重名覆盖） */
  saveProfile: (systemCode: string, profile: ConnectionProfileInput): Promise<{ message: string }> =>
    fetchApi<{ message: string }>(`/api/connections/${encodeURIComponent(systemCode)}/profiles`, {
      method: 'POST',
      body: JSON.stringify(profile),
    }),

  /** POST /api/connections/{systemCode}/profiles/{name}/activate（切换激活） */
  activateProfile: (systemCode: string, profileName: string): Promise<{ message: string }> =>
    fetchApi<{ message: string }>(
      `/api/connections/${encodeURIComponent(systemCode)}/profiles/${encodeURIComponent(profileName)}/activate`,
      { method: 'POST' }
    ),

  /** DELETE /api/connections/{systemCode}/profiles/{name}（删激活项会回退默认） */
  deleteProfile: (systemCode: string, profileName: string): Promise<{ message: string }> =>
    fetchApi<{ message: string }>(
      `/api/connections/${encodeURIComponent(systemCode)}/profiles/${encodeURIComponent(profileName)}`,
      { method: 'DELETE' }
    ),
}

// standalone 无后端 SQL Server，该功能不存在；卡片也不会渲染，这里仅满足双实现接线约定
const standaloneConnectionApi: typeof mescliConnectionApi = {
  getConnection: () => Promise.reject(new Error('当前模式不支持数据库连接配置')),
  saveConnection: () => Promise.reject(new Error('当前模式不支持数据库连接配置')),
  testConnection: () => Promise.reject(new Error('当前模式不支持数据库连接配置')),
  resetConnection: () => Promise.reject(new Error('当前模式不支持数据库连接配置')),
  saveProfile: () => Promise.reject(new Error('当前模式不支持数据库连接配置')),
  activateProfile: () => Promise.reject(new Error('当前模式不支持数据库连接配置')),
  deleteProfile: () => Promise.reject(new Error('当前模式不支持数据库连接配置')),
}

export const connectionApi = IS_STANDALONE ? standaloneConnectionApi : mescliConnectionApi

// ==================== 管理员提权（权限码登录） ====================

export interface AdminElevateResult {
  adminToken: string
  /** ISO 时间戳 */
  expiresAt: string
}

export interface AdminStatus {
  elevated: boolean
  expiresAt: string | null
}

const mescliAdminAuthApi = {
  /** POST /api/admin/auth/elevate（权限码 → 4h 提权 token；5 次失败锁 15 分钟） */
  elevate: (accessCode: string): Promise<AdminElevateResult> =>
    fetchApi<AdminElevateResult>('/api/admin/auth/elevate', {
      method: 'POST',
      body: JSON.stringify({ accessCode }),
    }),

  /** GET /api/admin/auth/status */
  getStatus: (): Promise<AdminStatus> => fetchApi<AdminStatus>('/api/admin/auth/status'),

  /** POST /api/admin/auth/revoke（客户端主动退出；真吊销靠 4h 过期） */
  revoke: (): Promise<{ message: string }> =>
    fetchApi<{ message: string }>('/api/admin/auth/revoke', { method: 'POST' }),
}

const standaloneAdminAuthApi: typeof mescliAdminAuthApi = {
  elevate: () => Promise.reject(new Error('当前模式不支持管理员提权')),
  getStatus: () => Promise.resolve({ elevated: false, expiresAt: null }),
  revoke: () => Promise.reject(new Error('当前模式不支持管理员提权')),
}

export const adminAuthApi = IS_STANDALONE ? standaloneAdminAuthApi : mescliAdminAuthApi

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

// ==================== MESCLI 客户工具包 API（与 MCP 插件完全分离） ====================

export const mescliPackageApi = {
  list: () => fetchApi<MescliPackageListItem[]>('/api/mescli-packages'),
  install: async (file: File) => {
    const formData = new FormData()
    formData.append('package', file)
    return fetchApi<MescliPackageMutationResponse>('/api/mescli-packages/install', {
      method: 'POST',
      body: formData,
    })
  },
  setEnabled: (packageId: string, isEnabled: boolean) =>
    fetchApi<MescliPackageMutationResponse>(`/api/mescli-packages/${encodeURIComponent(packageId)}/enable`, {
      method: 'PATCH',
      body: JSON.stringify({ isEnabled }),
    }),
  uninstall: (packageId: string) =>
    fetchApi<MescliPackageMutationResponse>(`/api/mescli-packages/${encodeURIComponent(packageId)}`, { method: 'DELETE' }),
  rollback: (packageId: string) =>
    fetchApi<MescliPackageMutationResponse>(`/api/mescli-packages/${encodeURIComponent(packageId)}/rollback`, { method: 'POST' }),
  /** Code 一键拉取：只在用户点击时调用，绝不自动触发 */
  pull: (code: string) =>
    fetchApi<MescliPackagePullResponse>('/api/mescli-packages/pull', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  systems: () => fetchApi<MescliPackageSystemItem[]>('/api/mescli-packages/systems', { silent: true }),
  updates: () => fetchApi<MescliPackageUpdate[]>('/api/mescli-packages/updates', { silent: true }),
}

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

// ==================== 文件级记忆 API（2026-09-03 下限工程） ====================
// 数据源 = ~/.wonwork/memory/ 目录下的 .md 文件，对齐 claude-code memdir。
// 旧 memoryApi（SQLite AiMemory 表）与 embeddingApi（语义检索）已随记忆文件化删除。

export interface UserMemoryFileEntry {
  relativePath: string
  name: string
  description: string
  type: string
  content: string
  lastModified: string
}

export const userMemoryApi = {
  /** GET /api/usermemory/index —— 读 MEMORY.md 索引 */
  getIndex: (): Promise<{ content: string; path: string }> =>
    fetchApi<{ content: string; path: string }>('/api/usermemory/index', { silent: true }),

  /** PUT /api/usermemory/index —— 写 MEMORY.md 索引 */
  putIndex: (content: string): Promise<void> =>
    fetchApi<void>('/api/usermemory/index', {
      method: 'PUT',
      body: JSON.stringify({ content }),
      silent: true,
    }),

  /** GET /api/usermemory/files —— 扫描全部记忆文件（清单+frontmatter） */
  listFiles: (): Promise<UserMemoryFileEntry[]> =>
    fetchApi<UserMemoryFileEntry[]>('/api/usermemory/files', { silent: true }),

  /** GET /api/usermemory/files/{path} —— 读单条记忆全文 */
  getFile: (path: string): Promise<{ path: string; content: string }> =>
    fetchApi<{ path: string; content: string }>(`/api/usermemory/files/${encodeURIComponent(path)}`, { silent: true }),

  /** PUT /api/usermemory/files/{path} —— 写单条记忆 */
  putFile: (path: string, content: string): Promise<{ path: string; fullPath: string }> =>
    fetchApi<{ path: string; fullPath: string }>(`/api/usermemory/files/${encodeURIComponent(path)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
      silent: true,
    }),

  /** DELETE /api/usermemory/files/{path} —— 删单条记忆 */
  deleteFile: (path: string): Promise<void> =>
    fetchApi<void>(`/api/usermemory/files/${encodeURIComponent(path)}`, {
      method: 'DELETE',
      silent: true,
    }),
}

// ==================== 供应商预设库 API（2026-09-07 对齐 cc-switch） ====================
// 数据源 = ~/.wonwork/providers.json；后端只存取文本，schema 归前端（types/providerProfile.ts）。
// standalone 无后端时 store 层降级纯 localStorage 缓存，这里不双实现。

export const providerProfilesApi = {
  /** GET /api/providerprofiles —— 读 providers.json 原文（不存在 content=null） */
  get: (): Promise<{ content: string | null; path: string }> =>
    fetchApi<{ content: string | null; path: string }>('/api/providerprofiles', { silent: true }),

  /** PUT /api/providerprofiles —— 整段覆写（后端仅校验合法 JSON 对象） */
  put: (content: string): Promise<void> =>
    fetchApi<void>('/api/providerprofiles', {
      method: 'PUT',
      body: JSON.stringify({ content }),
      silent: true,
    }),
}

// 供应商探测：浏览器直连有 CORS 问题，探测走后端（只报事实）。
export interface ProbeModelsResult {
  success: boolean
  models?: string[]
  sourceUrl?: string
  error?: string
}
export interface ProbePingResult {
  ok: boolean
  status?: number
  latencyMs?: number
  error?: string
}
export interface ProbeUsageResult {
  success: boolean
  planName?: string
  total?: number
  used?: number
  remaining?: number
  unit?: string
  error?: string
}

export const providerProbeApi = {
  /** POST /api/providerprobe/models —— 拉取供应商可用模型清单 */
  models: (req: { baseUrl: string; apiKey?: string; apiFormat?: string; modelsUrl?: string }): Promise<ProbeModelsResult> =>
    fetchApi<ProbeModelsResult>('/api/providerprobe/models', {
      method: 'POST',
      body: JSON.stringify(req),
      silent: true,
    }),

  /** POST /api/providerprobe/ping —— 连通性（GET base_url 判可达 + 延迟） */
  ping: (baseUrl: string): Promise<ProbePingResult> =>
    fetchApi<ProbePingResult>('/api/providerprobe/ping', {
      method: 'POST',
      body: JSON.stringify({ baseUrl }),
      silent: true,
    }),

  /** POST /api/providerprobe/usage —— 额度（URL 子串识别供应商，未识别如实报不支持） */
  usage: (req: { baseUrl: string; apiKey?: string }): Promise<ProbeUsageResult> =>
    fetchApi<ProbeUsageResult>('/api/providerprobe/usage', {
      method: 'POST',
      body: JSON.stringify(req),
      silent: true,
    }),
}

// ==================== 数据安全网关 API ====================

/** GET/PUT /api/security-gateway/preference 的响应形态（2026-08-10 P1） */
export interface SecurityGatewayPreference {
  enabled: boolean
  /** 后端裁决：仅 MES 已认证身份为 true；前端只展示，伪造 PUT 一律 403 */
  canEnable: boolean
  /** canEnable=false 时的原因：gateway_disabled=管理员未开放 / mes_login_required=未登录 MESCLI */
  reason?: 'gateway_disabled' | 'mes_login_required'
  rulesVersion?: string
}

/** GET/PUT /api/security-gateway/rules 的单条规则（六类固定顺序：身份证/信用代码/手机号/银行卡/邮箱/凭据） */
export interface SecurityGatewayRule {
  type: string
  enabled: boolean
  /** 占位符样例，如 ⟦身份证_7F3E9A21⟧（模型视角看到的代号） */
  sample: string
}

export interface SecurityGatewayRulesResponse {
  rulesVersion?: string
  rules: SecurityGatewayRule[]
}

/** GET /api/security-gateway/audit 的命中记录（元数据 only，绝不含原文） */
export interface SecurityGatewayAuditEvent {
  /** 后端 UTC 字符串 yyyy-MM-dd HH:mm:ss，前端负责本地化显示 */
  time: string
  /** 类型→次数字典，如 {"凭据":1} */
  hitTypes: Record<string, number>
  hitCount: number
  provider: string
  model: string
}

export interface SecurityGatewayAuditResponse {
  events: SecurityGatewayAuditEvent[]
}

export interface SecurityGatewayStats {
  today: number
  total: number
  lastHitAt: string | null
}

const mescliSecurityGatewayApi = {
  /** GET /api/security-gateway/preference（未登录也可调，返回 canEnable=false） */
  getPreference: (): Promise<SecurityGatewayPreference> =>
    fetchApi<SecurityGatewayPreference>('/api/security-gateway/preference', { silent: true }),

  /** PUT /api/security-gateway/preference */
  setPreference: (enabled: boolean): Promise<SecurityGatewayPreference> =>
    fetchApi<SecurityGatewayPreference>('/api/security-gateway/preference', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
      silent: true,
    }),

  /** GET /api/security-gateway/rules（六类规则+启用态；未登录 MES 时返回默认全量） */
  getRules: (): Promise<SecurityGatewayRulesResponse> =>
    fetchApi<SecurityGatewayRulesResponse>('/api/security-gateway/rules', { silent: true }),

  /** PUT /api/security-gateway/rules（单类启停，body { type, enabled }；非 MES 403） */
  setRule: (type: string, enabled: boolean): Promise<SecurityGatewayRulesResponse> =>
    fetchApi<SecurityGatewayRulesResponse>('/api/security-gateway/rules', {
      method: 'PUT',
      body: JSON.stringify({ type, enabled }),
      silent: true,
    }),

  /** GET /api/security-gateway/audit?limit=20（最近命中元数据，原文不留存） */
  getAudit: (limit = 20): Promise<SecurityGatewayAuditResponse> =>
    fetchApi<SecurityGatewayAuditResponse>(`/api/security-gateway/audit?limit=${limit}`, { silent: true }),

  /** GET /api/security-gateway/stats（今日/累计/最近命中时间） */
  getStats: (): Promise<SecurityGatewayStats> =>
    fetchApi<SecurityGatewayStats>('/api/security-gateway/stats', { silent: true }),
}

const standaloneSecurityGatewayApi: typeof mescliSecurityGatewayApi = {
  getPreference: () => Promise.resolve({ enabled: false, canEnable: false, reason: 'gateway_disabled' }),
  setPreference: () => Promise.reject(new Error('当前模式不支持数据安全网关')),
  getRules: () => Promise.resolve({ rules: [] }),
  setRule: () => Promise.reject(new Error('当前模式不支持数据安全网关')),
  getAudit: () => Promise.resolve({ events: [] }),
  getStats: () => Promise.resolve({ today: 0, total: 0, lastHitAt: null }),
}

export const securityGatewayApi = IS_STANDALONE ? standaloneSecurityGatewayApi : mescliSecurityGatewayApi

// ==================== 导出 ====================

export { ApiError, fetchApi }
export type { StreamChunk }
