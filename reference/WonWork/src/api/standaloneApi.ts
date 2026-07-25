import CronExpressionParser from 'cron-parser'
import type {
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
  WorkflowSearchResponse,
  ProviderConfig,
  UserConfigDto,
  ToolCatalogItem,
  ToolInvokeResult,
  ToolInvokeRequest,
  CapabilitiesResponse,
  VoiceRecognizeResponse,
  FileAttachmentDto,
  CapabilityTreeResponse,
  CapabilitySchemaResponse,
  CapabilityNode,
} from '@/types/mescli'
import type { CronTask, CronTaskResult, TaskExecutionMode, TaskStatus } from '@/types/cron'
import type { DagWorkflow } from '@/types/dagWorkflow'
import type { InstalledPlugin, PluginManifest } from '@/types/plugin'
import { validateManifest } from '@/types/plugin'
import { getIdentityPrompt } from '@/utils/identityPrompt'
import { buildCapabilityRegistry } from '@/utils/capabilityRegistry'
import { estimateTextTokens } from '@/utils/tokenEstimator'
import { getStandaloneToolCatalog } from '@/agent/tools'
import { useUsageStore, buildTodayUsageRecord } from '@/stores/usageStore'
import { mescliCronApi } from './mescli/cronApi'
import { toast } from 'sonner'
import { getErrorMessage } from '@/utils/error'
import { createSSEParserState, parseSSEBuffer, flushSSEBuffer, parseSSEData, type SSEEvent } from '@/utils/sseParser'
import { withRetry } from '@/utils/retry'
import { getIndexedDBName, getLocalStorageKey } from '@/utils/storageScope'
import {
  buildAnthropicMessagesUrl,
  normalizeMessagesForAnthropic,
  openaiToolToAnthropic,
} from './standalone/anthropicMessages'
import {
  createAnthropicStreamParserState,
  parseAnthropicStreamEvent,
} from './standalone/anthropicStreamParser'

/**
 * 当 VITE_USE_BACKEND_API=true 时，Standalone API 将部分操作转发到本地 AIGateway /api/*。
 * 这样 Preview 安装包可以保留 Standalone UI，同时把数据持久化到后端 SQLite。
 */
const USE_BACKEND = import.meta.env.VITE_USE_BACKEND_API === 'true'

class BackendApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public data?: unknown
  ) {
    super(message)
    this.name = 'BackendApiError'
  }
}

async function backendFetch<T>(path: string, options: RequestInit = {}, suppressToast = false): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  const token = localStorage.getItem('wonclaw_token')
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const userId = localStorage.getItem('wonclaw_user_id')
  if (userId) headers['X-MES-User-Id'] = userId

  const userName = localStorage.getItem('wonclaw_user_name')
  if (userName) headers['X-MES-User-Name'] = encodeURIComponent(userName)

  const realName = localStorage.getItem('wonclaw_real_name')
  if (realName) headers['X-MES-Real-Name'] = encodeURIComponent(realName)

  const roleId = localStorage.getItem('wonclaw_role_id')
  if (roleId) headers['X-MES-Role-Id'] = roleId

  const factoryId = localStorage.getItem('wonclaw_factory_id')
  if (factoryId) headers['X-MES-Factory-Id'] = factoryId

  const deptId = localStorage.getItem('wonclaw_dept_id')
  if (deptId) headers['X-MES-Dept-Id'] = deptId

  const workshopId = localStorage.getItem('wonclaw_workshop_id')
  if (workshopId) headers['X-MES-Workshop-Id'] = workshopId

  if (options.body instanceof FormData) {
    delete headers['Content-Type']
  }

  const response = await fetch(path, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers || {}),
    },
    credentials: 'include',
  })

  if (!response.ok) {
    let errorText: string
    try {
      errorText = await response.text()
    } catch {
      errorText = `HTTP ${response.status}`
    }
    // Standalone 模式下 backendFetch 错误也给出 Toast 提示（调用方可通过 suppressToast 关闭）
    const friendlyMessage = getErrorMessage(
      { status: response.status, message: errorText },
      '请求失败，请稍后重试'
    )
    if (!suppressToast) {
      toast.error(friendlyMessage)
    }
    throw new BackendApiError(friendlyMessage, response.status)
  }

  if (response.status === 204) {
    return undefined as T
  }

  const contentType = response.headers.get('content-type')
  if (contentType?.includes('application/json')) {
    return response.json() as Promise<T>
  }
  return response.text() as Promise<T>
}

/**
 * WonClaw 独立模式 API 实现
 * ==========================
 * 当 WonClaw 不依赖 MESCLI 后端时，所有功能通过以下方式实现：
 *
 * 1. 聊天 → 直接调用 AI 提供商 API（OpenAI / Kimi / Claude 等）
 * 2. 历史会话 → IndexedDB 本地存储
 * 3. 收藏夹 → IndexedDB 本地存储
 * 4. 工作流 → 前端本地工作流引擎
 * 5. 语音 → Web Speech API（浏览器原生）
 * 6. 认证 → 本地模式（无需登录或简单本地账号）
 * 7. 日报 → 前端调用 AI API 生成
 * 8. 模板 → 本地文件 + IndexedDB
 * 9. 配置 → localStorage 存储 API Key 等
 *
 * 使用方式：
 * 在 .env 中设置 VITE_STANDALONE_MODE=true
 * 或在运行时通过配置切换
 */

// ==================== IndexedDB 封装 ====================

function getDBName(): string {
  return getIndexedDBName()
}
const DB_VERSION = 9

interface StandaloneDB extends IDBDatabase {
  // 类型标记
}

async function openDB(): Promise<StandaloneDB> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(getDBName(), DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result as StandaloneDB)
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('conversations')) {
        const store = db.createObjectStore('conversations', { keyPath: 'id', autoIncrement: true })
        store.createIndex('updatedAt', 'updatedAt', { unique: false })
      }
      if (!db.objectStoreNames.contains('messages')) {
        const store = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true })
        store.createIndex('conversationId', 'conversationId', { unique: false })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }
      if (!db.objectStoreNames.contains('favorites')) {
        db.createObjectStore('favorites', { keyPath: 'id', autoIncrement: true })
      }
      if (!db.objectStoreNames.contains('templates')) {
        db.createObjectStore('templates', { keyPath: 'fileName' })
      }
      if (!db.objectStoreNames.contains('workflowSessions')) {
        db.createObjectStore('workflowSessions', { keyPath: 'sessionId' })
      }
      if (!db.objectStoreNames.contains('attachments')) {
        const store = db.createObjectStore('attachments', { keyPath: 'id' })
        store.createIndex('conversationId', 'conversationId', { unique: false })
      }
      if (!db.objectStoreNames.contains('workspaceMeta')) {
        db.createObjectStore('workspaceMeta', { keyPath: 'key' })
      }
      if (!db.objectStoreNames.contains('cronTasks')) {
        const store = db.createObjectStore('cronTasks', { keyPath: 'id' })
        store.createIndex('next_run_at', 'next_run_at', { unique: false })
        store.createIndex('is_enabled', 'is_enabled', { unique: false })
      }
      if (!db.objectStoreNames.contains('cronTaskExecutions')) {
        const store = db.createObjectStore('cronTaskExecutions', { keyPath: 'id', autoIncrement: true })
        store.createIndex('task_id', 'task_id', { unique: false })
      }
      if (!db.objectStoreNames.contains('dagWorkflows')) {
        db.createObjectStore('dagWorkflows', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('plugins')) {
        db.createObjectStore('plugins', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('files')) {
        const store = db.createObjectStore('files', { keyPath: 'path' })
        store.createIndex('parentPath', 'parentPath', { unique: false })
        store.createIndex('updatedAt', 'updatedAt', { unique: false })
      }
      // 对话视图状态（v9.4）：分支锚点快照、压缩边界等——体积大（含 renderNodes），
      // 放 IndexedDB 而非 localStorage。key 形如 `branches-<convId>` / `compacts-<convId>`。
      if (!db.objectStoreNames.contains('conversationViews')) {
        db.createObjectStore('conversationViews', { keyPath: 'key' })
      }
    }
  })
}

export async function dbGetAll<T>(storeName: string): Promise<T[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const store = tx.objectStore(storeName)
    const request = store.getAll()
    request.onsuccess = () => resolve(request.result as T[])
    request.onerror = () => reject(request.error)
  })
}

export async function dbGet<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const store = tx.objectStore(storeName)
    const request = store.get(key)
    request.onsuccess = () => resolve(request.result as T)
    request.onerror = () => reject(request.error)
  })
}

export async function dbAdd<T>(storeName: string, value: T): Promise<IDBValidKey> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    const request = store.add(value)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function dbPut<T>(storeName: string, value: T): Promise<IDBValidKey> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    const request = store.put(value)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function dbDelete(storeName: string, key: IDBValidKey): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    const request = store.delete(key)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

export async function dbGetByIndex<T>(
  storeName: string,
  indexName: string,
  key: IDBValidKey
): Promise<T[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const store = tx.objectStore(storeName)
    const index = store.index(indexName)
    const request = index.getAll(key)
    request.onsuccess = () => resolve(request.result as T[])
    request.onerror = () => reject(request.error)
  })
}

// ==================== 配置管理 ====================

interface StandaloneConfig {
  provider: string
  apiKey: string
  apiBase?: string
  model: string
  temperature: number
  maxTokens: number
  systemPrompt?: string
  /** 联网搜索提供商：bing 或自定义 endpoint */
  searchProvider?: 'bing' | 'custom'
  /** 联网搜索 API Key（Bing Web Search API v7 等） */
  searchApiKey?: string
  /** 自定义搜索 API Base URL，留空则使用 Bing 默认端点 */
  searchApiBaseUrl?: string
}

function getStandaloneConfig(): StandaloneConfig {
  const raw = localStorage.getItem(getLocalStorageKey('standalone_config'))
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as StandaloneConfig
      // 旧缓存防御（2026-07-24）：历史版本的 standalone_config 可能存了
      // 现已不存在的 provider（或字段缺失）。不校验直接返回会让
      // StandaloneSettingsView 的 PROVIDERS[config.provider] 取到 undefined，
      // 渲染时访问 .defaultModel 抛错 → 设置页白屏（"别人白屏、开发者正常"的元凶之一，
      // 因为开发者本机缓存是新的）。provider 无效时回退默认配置。
      if (parsed && typeof parsed === 'object' && PROVIDERS[parsed.provider]) {
        return parsed
      }
    } catch {
      // ignore
    }
  }
  const standaloneRegistry = buildCapabilityRegistry({
    mode: 'standalone',
    webBridgeStatus: 'disconnected',
    isMesLoggedIn: false,
  })
  return {
    provider: 'kimi',
    apiKey: '',
    model: 'kimi-k2.6',
    temperature: 0.7,
    maxTokens: 2048,
    systemPrompt: '', // 结构化 system prompt 由 chatStore 动态构建；其他入口使用 getIdentityPrompt 兜底
    searchProvider: 'bing',
    searchApiKey: '',
    searchApiBaseUrl: '',
  }
}

function setStandaloneConfig(config: StandaloneConfig): void {
  localStorage.setItem(getLocalStorageKey('standalone_config'), JSON.stringify(config))
}

// ==================== AI 提供商 SSE 流式调用 ====================

interface AIProvider {
  name: string
  baseUrl: string
  defaultModel: string
  headers(apiKey: string): Record<string, string>
  formatRequest(request: ChatRequest, config: StandaloneConfig): unknown
  parseStreamChunk(chunk: unknown): StreamChunk | null
  /** 是否支持 function calling（默认 true 的 OpenAI 兼容 provider） */
  supportsTools?: boolean
  /** 自定义最终请求 URL；未提供时默认走 OpenAI /v1/chat/completions */
  buildUrl?: (baseUrl: string) => string
}

/**
 * 工具调用流式累积器
 *
 * OpenAI 兼容流式接口中，一个 tool_call 会分成多个 chunk 到达：
 * - 第一个 chunk 通常包含 id 和 function.name
 * - 后续 chunk 通过 index 关联，只补充 function.arguments
 * 本累积器负责把分散的 delta 合并成完整的 tool_call，避免前端看到重复或残缺的工具调用。
 */
function createToolCallAccumulator() {
  const callsByIndex = new Map<number, { id: string; name: string; args: string }>()

  /**
   * 合并 arguments delta。
   * 不同提供商的行为不一致：
   * - OpenAI 规范：每个 chunk 只发增量片段；
   * - 部分国产模型/Moonshot：每个 chunk 发的是截至当前的全部参数（累积）。
   * 这里做兼容：如果新串是旧串的前缀/超集，直接取新的；否则按增量追加。
   */
  function mergeArguments(existing: string, delta: string): string {
    if (!existing) return delta
    if (!delta) return existing
    if (delta.startsWith(existing)) return delta
    if (existing.startsWith(delta)) return existing
    return existing + delta
  }

  return {
    processDelta(delta: Record<string, unknown>): StreamChunk | null {
      const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined
      if (!toolCalls || toolCalls.length === 0) return null

      for (const tc of toolCalls) {
        const index = Number(tc.index ?? 0)
        const existing = callsByIndex.get(index)
        const id = tc.id ? String(tc.id) : existing?.id || `tc-${Date.now()}-${index}`
        const func = tc.function as Record<string, unknown> | undefined
        const nameDelta = func?.name ? String(func.name) : ''
        const argsDelta = typeof func?.arguments === 'string' ? String(func.arguments) : ''

        callsByIndex.set(index, {
          id,
          name: nameDelta || existing?.name || '',
          args: mergeArguments(existing?.args || '', argsDelta),
        })
      }

      return {
        type: 'tool_call',
        toolCalls: Array.from(callsByIndex.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([, tc]) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.args },
          })),
      }
    },
  }
}

/**
 * 标准化 baseUrl：去除末尾多余斜杠，便于后续拼接固定路径。
 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/**
 * 构造 OpenAI 兼容 Chat Completions URL。
 * 兼容两种 baseUrl 写法：
 * - 已包含 /v1，如 https://api.moonshot.cn/v1 → 追加 /chat/completions
 * - 未包含 /v1，如 https://api.deepseek.com → 追加 /v1/chat/completions
 */
function buildOpenAIChatUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl)
  if (normalized.endsWith('/v1')) {
    return `${normalized}/chat/completions`
  }
  return `${normalized}/v1/chat/completions`
}

/**
 * 判断一个 Provider 是否走 Anthropic 兼容协议。
 *
 * 优先通过前端 PROVIDERS 常量判断；在 MESCLI Local 运行时，后端返回的 provider id
 * 可能与前端 key 不完全一致（例如 anthropic），此时通过 baseUrl 兜底识别。
 */
function isAnthropicCompatibleProvider(providerId: string, baseUrl?: string): boolean {
  const knownAnthropicIds = new Set(['claude', 'kimi-code', 'anthropic'])
  if (knownAnthropicIds.has(providerId)) return true
  if (baseUrl) {
    const lower = baseUrl.toLowerCase()
    if (lower.includes('api.anthropic.com') || lower.includes('api.kimi.com/coding')) {
      return true
    }
  }
  return false
}

/**
 * 判断 Provider 是否支持 function calling。
 *
 * 设计原则：
 * - 本地模型默认支持（实际能力由 localModelApi 内部处理）。
 * - 前端 PROVIDERS 常量中存在且 supportsTools !== false 时支持。
 * - Anthropic 兼容 Provider（kimi-code / claude / anthropic）明确支持。
 * - 兜底为 true：未知 Provider 按 OpenAI 兼容协议处理，让其自行失败而非前端拦截。
 */
function getProviderSupportsTools(providerId: string, baseUrl?: string): boolean {
  if (isAnthropicCompatibleProvider(providerId, baseUrl)) return true
  const provider = PROVIDERS[providerId]
  if (provider) return provider.supportsTools !== false
  return true
}

/**
 * 创建 Anthropic 兼容格式的 AI 提供商配置。
 * 适用于 Claude 原生以及 Kimi Code 等 Anthropic 兼容端点。
 *
 * Anthropic Messages API 与 OpenAI Chat Completions 的核心差异：
 * - 端点：baseUrl + /v1/messages
 * - 认证：x-api-key + anthropic-version
 * - 工具 schema：input_schema（而非 parameters）
 * - 消息格式：tool_use / tool_result content blocks
 * - 流事件：content_block_start / content_block_delta / content_block_stop / message_stop
 *
 * 这些差异由 ./standalone/anthropicMessages.ts 与 ./standalone/anthropicStreamParser.ts 封装，
 * 本函数只负责组合成 AIProvider 接口。
 */
function createAnthropicCompatibleProvider(
  name: string,
  baseUrl: string,
  defaultModel: string
): AIProvider {
  return {
    name,
    baseUrl,
    defaultModel,
    supportsTools: true,
    buildUrl: buildAnthropicMessagesUrl,
    headers: (apiKey) => ({
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    }),
    formatRequest: (request, config) => {
      const systemParts = [config.systemPrompt, ...(request.skillPrompts || [])].filter(Boolean)
      const body: Record<string, unknown> = {
        model: config.model || defaultModel,
        messages: normalizeMessagesForAnthropic(request.messages),
        system: systemParts.join('\n\n'),
        max_tokens: config.maxTokens,
        stream: true,
      }
      if (request.tools && request.tools.length > 0) {
        body.tools = request.tools.map(openaiToolToAnthropic)
        body.tool_choice = { type: 'auto' }
      }
      return body
    },
    parseStreamChunk: (chunk: unknown) => {
      // Anthropic 流解析依赖跨 chunk 状态（partial_json 累积），
      // 因此这里只返回 null；实际解析在 standaloneChatApi.streamChat 中通过
      // createAnthropicStreamParser 完成。
      return null
    },
  }
}

/**
 * 创建 OpenAI 兼容格式的 AI 提供商配置。
 * 目前市面主流国产模型（DeepSeek、通义千问、智谱、百川、讯飞星火、腾讯混元、字节豆包、百度文心）
 * 均提供 OpenAI 兼容的 API 端点，因此可复用同一套请求体与流式解析逻辑。
 */
function createOpenAICompatibleProvider(
  name: string,
  baseUrl: string,
  defaultModel: string
): AIProvider {
  return {
    name,
    baseUrl,
    defaultModel,
    supportsTools: true,
    buildUrl: buildOpenAIChatUrl,
    headers: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
    formatRequest: (request, config) => {
      const body: Record<string, unknown> = {
        model: config.model || defaultModel,
        messages: [
          ...(config.systemPrompt ? [{ role: 'system', content: config.systemPrompt }] : []),
          ...(request.skillPrompts?.map((p) => ({ role: 'system', content: p })) || []),
          ...request.messages.map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.toolCalls && m.toolCalls.length > 0 ? { tool_calls: m.toolCalls } : {}),
            ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
          })),
        ],
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        stream: true,
      }
      if (request.tools && request.tools.length > 0) {
        body.tools = request.tools
        body.tool_choice = 'auto'
      }
      return body
    },
    parseStreamChunk: (chunk: unknown) => {
      const c = chunk as Record<string, unknown>
      const choices = c.choices as Array<Record<string, unknown>> | undefined
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
      if (delta?.content) {
        return {
          type: 'content' as const,
          content: String(delta.content),
        }
      }
      const toolCalls = delta?.tool_calls as Array<Record<string, unknown>> | undefined
      if (toolCalls && toolCalls.length > 0) {
        return {
          type: 'tool_call' as const,
          toolCalls: toolCalls.map((tc) => ({
            id: String(tc.id || `tc-${Date.now()}`),
            type: 'function' as const,
            function: {
              name: String((tc.function as Record<string, unknown> | undefined)?.name || ''),
              arguments:
                typeof (tc.function as Record<string, unknown> | undefined)?.arguments === 'string'
                  ? String((tc.function as Record<string, unknown>).arguments)
                  : JSON.stringify((tc.function as Record<string, unknown> | undefined)?.arguments || {}),
            },
          })),
        }
      }
      if (choices?.[0]?.finish_reason) {
        return { type: 'done' as const }
      }
      return null
    },
  }
}

const PROVIDERS: Record<string, AIProvider> = {
  openai: createOpenAICompatibleProvider('OpenAI', 'https://api.openai.com/v1', 'gpt-5.5'),

  kimi: createOpenAICompatibleProvider('Kimi', 'https://api.moonshot.cn/v1', 'kimi-k2.6'),

  claude: createAnthropicCompatibleProvider('Claude (Anthropic)', 'https://api.anthropic.com', 'claude-sonnet-4-6'),

  // 国产模型预设（OpenAI 兼容）
  deepseek: createOpenAICompatibleProvider('DeepSeek', 'https://api.deepseek.com', 'deepseek-v4-flash'),

  // Kimi Code 走 Anthropic 兼容端点；Kimi Code 官方模型名为 kimi-for-coding
  'kimi-code': createAnthropicCompatibleProvider('KimiCode', 'https://api.kimi.com/coding/', 'kimi-for-coding'),

  qwen: createOpenAICompatibleProvider('Qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.7-plus'),
  zhipu: createOpenAICompatibleProvider('Zhipu GLM', 'https://open.bigmodel.cn/api/paas/v4', 'glm-4.7'),
  baichuan: createOpenAICompatibleProvider('Baichuan', 'https://api.baichuan-ai.com/v1', 'Baichuan4'),
  spark: createOpenAICompatibleProvider('Spark', 'https://spark-api-open.xf-yun.com/v1', 'generalv4'),
  hunyuan: createOpenAICompatibleProvider('Hunyuan', 'https://api.hunyuan.cloud.tencent.com/v1', 'hunyuan-turbos-latest'),
  doubao: createOpenAICompatibleProvider('Doubao', 'https://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-2-1-pro'),
  ernie: createOpenAICompatibleProvider('ERNIE', 'https://qianfan.baidubce.com/v2', 'ernie-5.1'),

  // WonWork Cloud / TokenHub（OpenAI 兼容，baseUrl/model 由官网套餐运行时下发）
  tokenhub: createOpenAICompatibleProvider('WonWork Cloud', '', ''),

  custom: {
    name: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    defaultModel: '',
    supportsTools: true,
    headers: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
    formatRequest: (request, config) => {
      const body: Record<string, unknown> = {
        model: config.model,
        messages: [
          ...(config.systemPrompt ? [{ role: 'system', content: config.systemPrompt }] : []),
          ...(request.skillPrompts?.map((p) => ({ role: 'system', content: p })) || []),
          ...request.messages.map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.toolCalls && m.toolCalls.length > 0 ? { tool_calls: m.toolCalls } : {}),
            ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
          })),
        ],
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        stream: true,
      }
      if (request.tools && request.tools.length > 0) {
        body.tools = request.tools
        body.tool_choice = 'auto'
      }
      return body
    },
    parseStreamChunk: (chunk: unknown) => {
      const c = chunk as Record<string, unknown>
      const choices = c.choices as Array<Record<string, unknown>> | undefined
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
      if (delta?.content) {
        return {
          type: 'content' as const,
          content: String(delta.content),
        }
      }
      const toolCalls = delta?.tool_calls as Array<Record<string, unknown>> | undefined
      if (toolCalls && toolCalls.length > 0) {
        return {
          type: 'tool_call' as const,
          toolCalls: toolCalls.map((tc) => ({
            id: String(tc.id || `tc-${Date.now()}`),
            type: 'function' as const,
            function: {
              name: String((tc.function as Record<string, unknown> | undefined)?.name || ''),
              arguments:
                typeof (tc.function as Record<string, unknown> | undefined)?.arguments === 'string'
                  ? String((tc.function as Record<string, unknown>).arguments)
                  : JSON.stringify((tc.function as Record<string, unknown> | undefined)?.arguments || {}),
            },
          })),
        }
      }
      if (choices?.[0]?.finish_reason) {
        return { type: 'done' as const }
      }
      return null
    },
  },
}

// ==================== 独立模式 API 实现 ====================

export const standaloneAuthApi = {
  /** 本地模式登录 —— 无需真实认证，创建本地用户 */
  login: async (req: LoginRequest): Promise<LoginResponse> => {
    if (USE_BACKEND) {
      const response = await backendFetch<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(req),
      })
      if (response.token && response.user) {
        localStorage.setItem('wonclaw_token', response.token)
        localStorage.setItem('wonclaw_user_id', String(response.user.userId))
        localStorage.setItem('wonclaw_user_name', response.user.userName)
        localStorage.setItem('wonclaw_real_name', response.user.realName)
        if (response.user.roleId) localStorage.setItem('wonclaw_role_id', String(response.user.roleId))
        if (response.user.factoryId) localStorage.setItem('wonclaw_factory_id', String(response.user.factoryId))
        if (response.user.deptId) localStorage.setItem('wonclaw_dept_id', String(response.user.deptId))
        if (response.user.workshopId) localStorage.setItem('wonclaw_workshop_id', String(response.user.workshopId))
        localStorage.setItem('wonclaw_system_code', response.user.systemCode)
      }
      return response
    }

    const user: UserInfo = {
      userId: 1,
      userName: req.workBarcode || 'local-user',
      realName: '本地用户',
      systemCode: req.systemCode || 'standalone',
      roleId: 1,
      factoryId: 1,
      deptId: 1,
      workshopId: 1,
    }
    const token = `standalone-token-${Date.now()}`
    localStorage.setItem('wonclaw_token', token)
    localStorage.setItem('wonclaw_user_id', String(user.userId))
    localStorage.setItem('wonclaw_user_name', user.userName)
    localStorage.setItem('wonclaw_real_name', user.realName)
    localStorage.setItem('wonclaw_system_code', user.systemCode)
    return { success: true, token, user }
  },

  logout: async (): Promise<{ success: boolean }> => {
    if (USE_BACKEND) {
      try {
        await backendFetch<{ success: boolean }>('/api/auth/logout', { method: 'POST' })
      } catch {
        // ignore
      }
    }
    localStorage.removeItem('wonclaw_token')
    return { success: true }
  },

  getCurrentUser: async (): Promise<UserInfo> => {
    if (USE_BACKEND) {
      return backendFetch<UserInfo>('/api/auth/user')
    }

    return {
      userId: Number(localStorage.getItem('wonclaw_user_id')) || 1,
      userName: localStorage.getItem('wonclaw_user_name') || 'local-user',
      realName: localStorage.getItem('wonclaw_real_name') || '本地用户',
      systemCode: localStorage.getItem('wonclaw_system_code') || 'standalone',
      roleId: Number(localStorage.getItem('wonclaw_role_id')) || 1,
      factoryId: Number(localStorage.getItem('wonclaw_factory_id')) || 1,
      deptId: Number(localStorage.getItem('wonclaw_dept_id')) || 1,
      workshopId: Number(localStorage.getItem('wonclaw_workshop_id')) || 1,
    }
  },
}

/**
 * 解析运行时 provider 配置。
 * 优先使用请求参数（用于 MESCLI Local 运行时传入的 provider/apiKey/baseUrl/model），
 * 回退到 Standalone 本地配置（用于 Standalone 模式）。
 */
function resolveRuntimeProvider(
  request: ChatRequest,
  config: StandaloneConfig
): {
  provider: AIProvider
  providerKey: string
  baseUrl: string
  apiKey: string
  runtimeConfig: StandaloneConfig
} {
  const providerKey = request.provider || config.provider
  const model = request.model || config.model
  const apiKey = request.apiKey || config.apiKey
  const apiBase = request.baseUrl || config.apiBase

  let provider = PROVIDERS[providerKey]
  if (!provider) {
    // MESCLI Local 后端可能返回 Standalone 不认识的 provider key，
    // 按 OpenAI 兼容协议兜底，使用传入的 baseUrl
    provider = createOpenAICompatibleProvider(providerKey, apiBase || '', model || '')
  }

  return {
    provider,
    providerKey,
    baseUrl: apiBase || provider.baseUrl,
    apiKey,
    runtimeConfig: {
      ...config,
      provider: providerKey,
      model: model || config.model,
      apiBase,
      apiKey,
    },
  }
}

export const standaloneChatApi = {
  /** 直接调用 AI 提供商 API 的 SSE 流式对话（带请求层重试） */
  streamChat: (
    request: ChatRequest,
    onChunk: (chunk: StreamChunk) => void,
    onError?: (error: Error) => void,
    onDone?: () => void
  ): (() => void) => {
    const fallbackConfig = getStandaloneConfig()
    const { provider, providerKey, baseUrl, apiKey, runtimeConfig } = resolveRuntimeProvider(request, fallbackConfig)
    const isAnthropic = isAnthropicCompatibleProvider(providerKey, baseUrl)
    const openAIToolCallAccumulator = createToolCallAccumulator()
    const anthropicStreamState = createAnthropicStreamParserState()

    const parseStreamChunkWithAccumulation = (parsedData: Record<string, unknown>): StreamChunk | null => {
      if (isAnthropic) {
        return parseAnthropicStreamEvent(parsedData, anthropicStreamState)
      }

      const choices = parsedData.choices as Array<Record<string, unknown>> | undefined
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
      if (delta?.tool_calls) {
        return openAIToolCallAccumulator.processDelta(delta)
      }
      return provider.parseStreamChunk(parsedData)
    }

    if (!apiKey) {
      const msg = '未配置 AI API Key，请在设置中添加'
      toast.error(msg)
      onError?.(new Error(msg))
      return () => {}
    }

    // Anthropic 兼容 Provider（Kimi Code 等）在浏览器中直接跨域会触发 OPTIONS 预检，
    // 而 Kimi 服务端未实现 OPTIONS 响应导致请求失败。
    // 解决方案：开发时通过 Vite proxy（/anthropic-proxy）转发；生产 Standalone 通过本地代理脚本。
    const useAnthropicProxy = isAnthropic && !USE_BACKEND
    const url = useAnthropicProxy
      ? '/anthropic-proxy/coding/v1/messages'
      : provider.buildUrl
        ? provider.buildUrl(baseUrl)
        : buildOpenAIChatUrl(baseUrl)

    const effectiveTools = provider.supportsTools === false ? undefined : request.tools
    const body = provider.formatRequest(
      { ...request, tools: effectiveTools },
      runtimeConfig
    ) as Record<string, unknown>
    let aborted = false
    let currentAbortController: AbortController | null = null
    let outputText = ''

    const executeStream = async (_attempt: number): Promise<void> => {
      if (aborted) {
        const abortError = new Error('Request aborted')
        abortError.name = 'AbortError'
        throw abortError
      }

      currentAbortController = new AbortController()

      const response = await fetch(url, {
        method: 'POST',
        headers: provider.headers(apiKey),
        body: JSON.stringify(body),
        signal: currentAbortController.signal,
      })

      if (!response.ok) {
        const text = await response.text()
        let errorMessage = text
        try {
          const parsed = JSON.parse(text)
          errorMessage = (parsed.error?.message || parsed.error || parsed.message || text) as string
        } catch {
          // 非 JSON，保留原始文本
        }
        const friendlyMessage = getErrorMessage(
          { status: response.status, message: errorMessage },
          'AI 服务请求失败，请检查 API Key 或稍后重试'
        )
        throw new Error(friendlyMessage)
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('Response body is null')

      const decoder = new TextDecoder()
      const sseState = createSSEParserState()

      /** 统一分发 SSE 事件；返回 true 表示流已结束。 */
      const handleEvent = (event: SSEEvent): boolean => {
        if (event.event === 'chunk' || event.event === 'message') {
          const parsed = parseSSEData(event.data)
          if (parsed && typeof parsed === 'object' && 'done' in parsed) {
            reportUsage()
            if (!aborted) onDone?.()
            return true
          }
          try {
            const parsedData = parsed as Record<string, unknown>
            const chunk = parseStreamChunkWithAccumulation(parsedData)
            if (chunk) {
              if (chunk.type === 'content') {
                outputText += chunk.content || ''
              }
              onChunk(chunk)
            }
          } catch {
            // ignore parse errors
          }
          return false
        }

        switch (event.event) {
          case 'done':
            reportUsage()
            if (!aborted) onDone?.()
            return true
          case 'error': {
            const parsed = parseSSEData(event.data)
            const errorMessage =
              parsed && typeof parsed === 'object'
                ? (parsed as { message?: string }).message || String(parsed)
                : String(event.data)
            // 流内错误不重试：消费端已累积部分回复，重试会导致内容重复
            throw new BackendApiError(errorMessage, 400)
          }
          case 'title':
          case 'tool_call':
          case 'think':
            try {
              const parsedData = parseSSEData(event.data) as Record<string, unknown>
              const chunk = parseStreamChunkWithAccumulation(parsedData)
              if (chunk) {
                if (chunk.type === 'content') {
                  outputText += chunk.content || ''
                }
                onChunk(chunk)
              }
            } catch {
              // ignore
            }
            break
          default:
            try {
              const parsedData = parseSSEData(event.data) as Record<string, unknown>
              const chunk = parseStreamChunkWithAccumulation(parsedData)
              if (chunk) {
                if (chunk.type === 'content') {
                  outputText += chunk.content || ''
                }
                onChunk(chunk)
              }
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

      reportUsage()
      if (!aborted) onDone?.()
    }

    withRetry(executeStream, { maxRetries: 0, baseDelayMs: 500, maxDelayMs: 5000 }).catch((error) => {
      if (!aborted && error.name !== 'AbortError') {
        const friendlyMessage = getErrorMessage(
          error,
          '对话连接异常，请检查网络或稍后重试'
        )
        // 错误提示统一由调用方（如 chatStore.onError）负责，避免重复 Toast
        onError?.(new Error(friendlyMessage))
      }
    })

    function reportUsage() {
      const inputText = request.messages.map((m) => m.content).join('\n')
      const tokensIn = estimateTextTokens(inputText)
      const tokensOut = estimateTextTokens(outputText)
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

// 本地 Conversation 存储结构（扩展 MESCLI 类型）
interface LocalConversation extends Conversation {
  updatedAtNum: number
}

// 本地 Message 存储结构
interface LocalMessage extends Message {
  id: number
  createdAt: string
  conversationId: number
}

export const standaloneHistoryApi = {
  getConversations: async (): Promise<Conversation[]> => {
    if (USE_BACKEND) {
      return backendFetch<Conversation[]>('/api/history')
    }
    const items = await dbGetAll<LocalConversation>('conversations')
    return items.sort((a, b) => (b.updatedAtNum || 0) - (a.updatedAtNum || 0))
  },

  createConversation: async (req: CreateConversationRequest): Promise<{ id: number; title: string }> => {
    if (USE_BACKEND) {
      return backendFetch<{ id: number; title: string }>('/api/history', {
        method: 'POST',
        body: JSON.stringify(req),
      })
    }
    const now = new Date().toISOString()
    const conv: Omit<LocalConversation, 'id'> = {
      userId: 1,
      title: req.title || '新对话',
      systemCode: 'standalone',
      createdAt: now,
      updatedAt: now,
      updatedAtNum: Date.now(),
    }
    const id = await dbPut('conversations', conv) as number
    return { id, title: conv.title }
  },

  updateTitle: async (conversationId: number, req: UpdateTitleRequest): Promise<void> => {
    if (USE_BACKEND) {
      await backendFetch<void>(`/api/history/${conversationId}`, {
        method: 'PUT',
        body: JSON.stringify(req),
      })
      return
    }
    const conv = await dbGet<LocalConversation>('conversations', conversationId)
    if (conv) {
      conv.title = req.title
      conv.updatedAt = new Date().toISOString()
      conv.updatedAtNum = Date.now()
      await dbPut('conversations', conv)
    }
  },

  getMessages: async (conversationId: number): Promise<Message[]> => {
    if (USE_BACKEND) {
      return backendFetch<Message[]>(`/api/history/${conversationId}/messages`)
    }
    const messages = await dbGetByIndex<LocalMessage>('messages', 'conversationId', conversationId)
    return messages
      .sort((a, b) => {
        // 历史数据可能用前端字符串 id 作为主键，减法会产生 NaN 导致排序不稳定（
        // 表现为切换对话后消息按角色/随机聚拢）。新数据使用 autoIncrement 数字 id，
        // 按主键排序即正确的展示顺序；旧数据回退到 createdAt。
        if (typeof a.id === 'number' && typeof b.id === 'number') {
          return a.id - b.id
        }
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      })
      .map(({ conversationId: _cid, ...msg }) => msg as Message)
  },

  saveMessage: async (conversationId: number, message: Message): Promise<void> => {
    if (USE_BACKEND) {
      // MESCLI 后端未实现该端点，静默失败避免重复 Toast
      await backendFetch<void>(
        `/api/history/${conversationId}/messages`,
        {
          method: 'POST',
          body: JSON.stringify(message),
        },
        true
      )
      return
    }
    await saveMessage(conversationId, message)
  },

  deleteConversation: async (conversationId: number): Promise<void> => {
    if (USE_BACKEND) {
      await backendFetch<void>(`/api/history/${conversationId}`, { method: 'DELETE' })
      return
    }
    await dbDelete('conversations', conversationId)
    const messages = await dbGetByIndex<LocalMessage>('messages', 'conversationId', conversationId)
    for (const msg of messages) {
      await dbDelete('messages', msg.id)
    }
    const attachments = await dbGetByIndex<FileAttachmentDto>('attachments', 'conversationId', conversationId)
    for (const att of attachments) {
      await dbDelete('attachments', att.id)
    }
  },
}

/** 保存消息到 IndexedDB（供 chatStore 使用） */
export async function saveMessage(
  conversationId: number,
  message: Omit<Message, 'id' | 'createdAt'>
): Promise<Message> {
  const now = new Date().toISOString()
  // 前端 ChatMessage 自带字符串 id，不能让它覆盖 IndexedDB 的 autoIncrement 数字主键，
  // 否则 getMessages 中 a.id - b.id 会出现 NaN，导致消息顺序错乱、角色聚拢。
  const messageBody = { ...message }
  delete (messageBody as any).id
  const msg: Omit<LocalMessage, 'id'> = {
    ...messageBody,
    createdAt: now,
    conversationId,
  }
  const id = await dbAdd('messages', msg) as number
  ;(msg as LocalMessage).id = id

  // 更新会话时间
  const conv = await dbGet<LocalConversation>('conversations', conversationId)
  if (conv) {
    conv.updatedAt = now
    conv.updatedAtNum = Date.now()
    await dbPut('conversations', conv)
  }

  const { id: _id, createdAt, conversationId: _cid, ...result } = msg as LocalMessage
  return result as Message
}

export const standaloneFavoriteApi = {
  getFavorites: async (): Promise<FavoriteItem[]> => {
    if (USE_BACKEND) {
      return backendFetch<FavoriteItem[]>('/api/favorite')
    }
    return dbGetAll<FavoriteItem>('favorites')
  },

  addFavorite: async (req: AddFavoriteRequest): Promise<{ id: number; title: string; prompt: string }> => {
    if (USE_BACKEND) {
      return backendFetch<{ id: number; title: string; prompt: string }>('/api/favorite', {
        method: 'POST',
        body: JSON.stringify(req),
      })
    }
    const now = new Date().toISOString()
    const item: Omit<FavoriteItem, 'id'> = {
      userId: 1,
      title: req.title,
      prompt: req.prompt,
      systemCode: 'standalone',
      createdAt: now,
      updatedAt: now,
    }
    const id = await dbAdd('favorites', item) as number
    return { id, title: req.title, prompt: req.prompt }
  },

  updateFavorite: async (id: number, req: UpdateFavoriteRequest): Promise<void> => {
    if (USE_BACKEND) {
      await backendFetch<void>(`/api/favorite/${id}`, {
        method: 'PUT',
        body: JSON.stringify(req),
      })
      return
    }
    const item = await dbGet<FavoriteItem>('favorites', id)
    if (item) {
      await dbPut('favorites', { ...item, ...req, updatedAt: new Date().toISOString() })
    }
  },

  deleteFavorite: async (id: number): Promise<void> => {
    if (USE_BACKEND) {
      await backendFetch<void>(`/api/favorite/${id}`, { method: 'DELETE' })
      return
    }
    await dbDelete('favorites', id)
  },
}

export const standaloneWorkflowApi = {
  /** 前端本地工作流引擎 */
  start: async (req: StartWorkflowRequest): Promise<StartWorkflowResponse> => {
    const sessionId = `standalone-wf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const session = {
      sessionId,
      workflowCode: req.workflowCode,
      currentStep: 0,
      data: {} as Record<string, unknown>,
      status: 'running' as const,
      createdAt: Date.now(),
    }
    await dbPut('workflowSessions', session)

    return {
      sessionId,
      workflowName: req.workflowCode,
      step: {
        type: 'form',
        success: true,
        step: {
          id: 'step-1',
          name: req.workflowCode,
          type: 'Form',
          prompt: '请在下方填写所需信息',
          fields: [
            { id: 'input', name: 'input', type: 'TextArea', required: true },
          ],
        },
      },
    }
  },

  submit: async (sessionId: string, stepData: Record<string, unknown>): Promise<WorkflowStepResponse> => {
    const session = await dbGet<{
      sessionId: string
      currentStep: number
      data: Record<string, unknown>
      status: string
    }>('workflowSessions', sessionId)

    if (!session) throw new Error('工作流会话不存在')

    session.currentStep += 1
    session.data = { ...session.data, ...stepData }
    await dbPut('workflowSessions', session)

    if (session.currentStep >= 3) {
      return {
        type: 'result',
        success: true,
        step: {
          id: `step-${session.currentStep + 1}`,
          name: '处理完成',
          type: 'Result',
          prompt: '工作流已执行完毕',
        },
        result: {
          success: true,
          message: '工作流执行完成',
        },
      }
    }

    return {
      type: 'form',
      success: true,
      step: {
        id: `step-${session.currentStep + 1}`,
        name: `步骤 ${session.currentStep + 1}`,
        type: 'Form',
        prompt: '请继续填写信息',
        fields: [
          { id: `field-${session.currentStep}`, name: `field_${session.currentStep}`, type: 'Text', required: true },
        ],
      },
    }
  },

  getCurrentStep: async (sessionId: string): Promise<WorkflowStepResponse> => {
    const session = await dbGet<{
      sessionId: string
      currentStep: number
      data: Record<string, unknown>
    }>('workflowSessions', sessionId)

    if (!session) throw new Error('工作流会话不存在')

    return {
      type: 'form',
      success: true,
      step: {
        id: `step-${session.currentStep + 1}`,
        name: `步骤 ${session.currentStep + 1}`,
        type: 'Form',
        prompt: '继续填写',
        fields: [
          { id: `field-${session.currentStep}`, name: `field_${session.currentStep}`, type: 'Text', required: true },
        ],
      },
    }
  },

  cancel: async (sessionId: string): Promise<{ message: string }> => {
    await dbDelete('workflowSessions', sessionId)
    return { message: '工作流已取消' }
  },

  search: async (): Promise<WorkflowSearchResponse> => {
    return {
      success: true,
      message: '本地工作流列表',
      items: [
        { id: 'standalone-analysis', name: '数据分析', description: '上传数据进行分析' },
      ],
    }
  },
}

export const standaloneToolApi = {
  /** Standalone 模式返回前端本地工具目录（read_file / write_file / list_files / grep / glob 等） */
  list: async (_systemCode?: string): Promise<ToolCatalogItem[]> => {
    return getStandaloneToolCatalog(_systemCode)
  },

  /** Standalone 模式能力清单与 list 等价（无后端服务） */
  capabilities: async (_systemCode?: string): Promise<ToolCatalogItem[]> => {
    return getStandaloneToolCatalog(_systemCode)
  },

  /** Standalone 模式完整能力响应（无后端服务，无 features） */
  capabilitiesFull: async (_systemCode?: string): Promise<CapabilitiesResponse> => {
    return {
      tools: getStandaloneToolCatalog(_systemCode),
      domainTools: [],
      primitiveTools: [],
      adminTools: [],
      workflowTools: [],
    }
  },

  /** Standalone 模式本地工具发现：在无后端时按关键词搜索本地原语目录 */
  search: async (req: import('@/types/mescli').ToolSearchRequest): Promise<import('@/types/mescli').ToolSearchResponse> => {
    const query = (req.query || '').toLowerCase().trim()
    const category = req.category ? req.category.trim().toLowerCase() : undefined
    const limit = typeof req.limit === 'number' && req.limit > 0 ? Math.min(req.limit, 50) : 5

    const catalog = getStandaloneToolCatalog(req.systemCode)
    const tools = catalog
      .filter((item) => {
        const name = item.name.toLowerCase()
        if (name === 'tool_search') return false
        const desc = (item.description || '').toLowerCase()
        const cat = (item.category || '').toLowerCase()
        const matchesQuery = !query || name.includes(query) || desc.includes(query)
        const matchesCategory = !category || cat === category
        return matchesQuery && matchesCategory
      })
      .slice(0, limit)
      .map((item) => ({
        name: item.name,
        description: item.description,
        tier: item.tier,
        category: item.category,
        loadStrategy: item.loadStrategy,
      }))

    return { tools, query: req.query }
  },

  /** Standalone 模式模拟能力树：所有本地原语挂在 /local 下 */
  tree: async (path = '/', _systemCode?: string): Promise<CapabilityTreeResponse> => {
    const normalizedPath = path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/'
    const catalog = getStandaloneToolCatalog(_systemCode)

    if (normalizedPath === '/') {
      const localChildren = catalog
        .map((item) => item.name)
        .filter((name) => name !== 'list_capabilities' && name !== 'read_capability')
      const nodes: CapabilityNode[] = [
        {
          name: 'local',
          path: '/local',
          kind: 'folder',
          description: '前端本地原语',
          children: localChildren,
        },
      ]
      return { path: '/', nodes }
    }

    if (normalizedPath === '/local') {
      const nodes: CapabilityNode[] = catalog
        .filter((item) => item.name !== 'list_capabilities' && item.name !== 'read_capability')
        .map((item) => ({
          name: item.name,
          path: `/local/${item.name}`,
          kind: 'tool',
          description: item.description,
          tier: item.tier,
          category: item.category,
        }))
      return { path: '/local', nodes }
    }

    return { path: normalizedPath, nodes: [] }
  },

  /** Standalone 模式读取本地原语 schema */
  schema: async (path: string, _systemCode?: string): Promise<CapabilitySchemaResponse> => {
    const normalizedPath = path.replace(/\\/g, '/').replace(/\/+/g, '/')
    const catalog = getStandaloneToolCatalog(_systemCode)
    const targetName = normalizedPath.split('/').pop()?.toLowerCase()
    const item = catalog.find((t) => t.name.toLowerCase() === targetName)
    if (!item) {
      throw new Error(`路径 ${path} 不存在`)
    }
    return {
      path: normalizedPath,
      name: item.name,
      description: item.description,
      parameters: item.parameters,
      riskLevel: item.riskLevel,
      tier: item.tier,
      category: item.category,
    }
  },

  /** Standalone 模式不支持后端 Tool 调用；实际执行由前端 ToolExecutor 完成 */
  invoke: async (_toolName: string, _args: Record<string, unknown>, _systemCode?: string): Promise<ToolInvokeResult> => {
    throw new Error('Standalone 模式不支持后端 Tool 调用')
  },

  /** Standalone 模式不支持后端 Tool 调用 */
  execute: async (_request: ToolInvokeRequest, _options?: unknown): Promise<ToolInvokeResult> => {
    throw new Error('Standalone 模式不支持后端 Tool 调用')
  },

  /** Standalone 模式不存在 backend-driven 审批 */
  submitApproval: async (_req: import('@/types/mescli').SubmitToolApprovalRequest): Promise<{ executionId: string; approved: boolean }> => {
    throw new Error('Standalone 模式不存在后端审批闭环')
  },
}

export const standaloneConfigApi = {
  getProviders: async (): Promise<ProviderConfig[]> => {
    if (USE_BACKEND) {
      return backendFetch<ProviderConfig[]>('/api/config/providers')
    }
    return [
      { provider: 'openai', model: 'gpt-5.5', baseUrl: 'https://api.openai.com/v1' },
      { provider: 'kimi', model: 'kimi-k2.6', baseUrl: 'https://api.moonshot.cn/v1' },
      { provider: 'claude', model: 'claude-sonnet-4-6', baseUrl: 'https://api.anthropic.com' },
      { provider: 'deepseek', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com' },
      { provider: 'kimi-code', model: 'opus', baseUrl: 'https://api.kimi.com/coding/' },
      { provider: 'qwen', model: 'qwen3.7-plus', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { provider: 'zhipu', model: 'glm-4.7', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
      { provider: 'baichuan', model: 'Baichuan4', baseUrl: 'https://api.baichuan-ai.com/v1' },
      { provider: 'spark', model: 'generalv4', baseUrl: 'https://spark-api-open.xf-yun.com/v1' },
      { provider: 'hunyuan', model: 'hunyuan-turbos-latest', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1' },
      { provider: 'doubao', model: 'doubao-seed-2-1-pro', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
      { provider: 'ernie', model: 'ernie-5.1', baseUrl: 'https://qianfan.baidubce.com/v2' },
      { provider: 'tokenhub', model: '', baseUrl: '' },
      { provider: 'custom', model: '', baseUrl: '' },
    ]
  },

  getProvider: async (provider: string): Promise<ProviderConfig> => {
    if (USE_BACKEND) {
      return backendFetch<ProviderConfig>(`/api/config/providers/${provider}`)
    }
    const p = PROVIDERS[provider]
    return { provider, model: p?.defaultModel || '', baseUrl: p?.baseUrl || '' }
  },

  upsertProvider: async (provider: string, config: ProviderConfig): Promise<void> => {
    if (USE_BACKEND) {
      await backendFetch<void>(`/api/config/providers/${provider}`, {
        method: 'PUT',
        body: JSON.stringify(config),
      })
    }
    // Standalone 模式下配置存储在 localStorage，无需后端
  },
}

export const standaloneUserConfigApi = {
  getConfigs: async (): Promise<UserConfigDto[]> => {
    if (USE_BACKEND) {
      return backendFetch<UserConfigDto[]>('/api/userconfig')
    }
    const config = getStandaloneConfig()
    return [
      {
        provider: config.provider,
        apiKey: config.apiKey ? '***' : '',
        model: config.model,
        baseUrl: config.apiBase || PROVIDERS[config.provider]?.baseUrl,
      },
    ]
  },

  getConfig: async (provider: string): Promise<UserConfigDto> => {
    if (USE_BACKEND) {
      return backendFetch<UserConfigDto>(`/api/userconfig/${provider}`)
    }
    const config = getStandaloneConfig()
    return {
      provider,
      apiKey: config.apiKey ? '***' : '',
      model: config.model,
      baseUrl: config.apiBase || PROVIDERS[provider]?.baseUrl,
    }
  },

  upsertConfig: async (provider: string, config: UserConfigDto): Promise<void> => {
    if (USE_BACKEND) {
      await backendFetch<void>(`/api/userconfig/${provider}`, {
        method: 'PUT',
        body: JSON.stringify(config),
      })
      return
    }
    const current = getStandaloneConfig()
    setStandaloneConfig({
      ...current,
      provider: provider as StandaloneConfig['provider'],
      apiKey: config.apiKey || current.apiKey,
      model: config.model || current.model,
      apiBase: config.baseUrl || current.apiBase,
    })
  },

  getApiKey: async (provider: string): Promise<{ apiKey: string }> => {
    if (USE_BACKEND) {
      return backendFetch<{ apiKey: string }>(`/api/userconfig/${provider}/apikey`)
    }
    const config = getStandaloneConfig()
    return { apiKey: config.apiKey || '' }
  },
}

export const standaloneAttachmentApi = {
  upload: async (_conversationId: number, attachment: FileAttachmentDto): Promise<void> => {
    if (USE_BACKEND) {
      await backendFetch<void>(`/api/attachments/${_conversationId}`, {
        method: 'POST',
        body: JSON.stringify(attachment),
      })
      return
    }
    await dbPut('attachments', attachment)
  },

  getAttachments: async (conversationId: number): Promise<FileAttachmentDto[]> => {
    if (USE_BACKEND) {
      return backendFetch<FileAttachmentDto[]>(`/api/attachments/${conversationId}`)
    }
    return dbGetByIndex<FileAttachmentDto>('attachments', 'conversationId', conversationId)
  },

  deleteAttachment: async (attachmentId: string): Promise<void> => {
    if (USE_BACKEND) {
      await backendFetch<void>(`/api/attachments/${attachmentId}`, { method: 'DELETE' })
      return
    }
    await dbDelete('attachments', attachmentId)
  },
}

export const standaloneVoiceApi = {
  recognize: async (): Promise<VoiceRecognizeResponse> => {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      throw new Error('浏览器不支持语音识别，请使用 Chrome/Edge')
    }

    return new Promise((resolve, reject) => {
      const win = window as unknown as Record<string, unknown>
      const SpeechRecognitionCtor = (win.SpeechRecognition || win.webkitSpeechRecognition) as new () => unknown
      const recognition = new SpeechRecognitionCtor() as {
        lang: string
        continuous: boolean
        interimResults: boolean
        onresult: ((event: unknown) => void) | null
        onerror: ((event: unknown) => void) | null
        start: () => void
      }
      recognition.lang = 'zh-CN'
      recognition.continuous = false
      recognition.interimResults = false

      recognition.onresult = (event: unknown) => {
        const e = event as { results: Array<Array<{ transcript: string }>> }
        const transcript = e.results[0][0].transcript
        resolve({ text: transcript })
      }

      recognition.onerror = (event: unknown) => {
        const e = event as { error: string }
        reject(new Error(`语音识别错误: ${e.error}`))
      }

      recognition.start()
    })
  },
}

// ==================== 定时任务 API（Standalone 模式） ====================

export interface CronTaskCreateRequest {
  name: string
  description?: string
  cronExpression: string
  executionMode: string
  payload: Record<string, unknown>
  isEnabled?: boolean
}

export interface CronTaskUpdateRequest {
  name?: string
  description?: string
  cronExpression?: string
  executionMode?: string
  payload?: Record<string, unknown>
  isEnabled?: boolean
}

function generateCronTaskId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function computeNextRun(expression?: string, from = new Date()): string | undefined {
  if (!expression) return undefined
  try {
    const interval = CronExpressionParser.parse(expression, { currentDate: from })
    return interval.next().toISOString() ?? undefined
  } catch {
    return undefined
  }
}

function buildCronTask(input: Omit<CronTask, 'id' | 'status' | 'created_at' | 'updated_at' | 'last_run_at' | 'next_run_at' | 'run_count'>, id: string, now: string): CronTask {
  return {
    id,
    name: input.name,
    description: input.description,
    task_type: input.task_type ?? 'recurring',
    cron: input.cron,
    one_time_at: input.one_time_at,
    interval_seconds: input.interval_seconds,
    payload: input.payload,
    is_enabled: input.is_enabled ?? true,
    status: 'pending',
    created_at: now,
    updated_at: now,
    last_run_at: undefined,
    next_run_at: computeNextRun(input.cron?.expression),
    run_count: 0,
    stale_after_days: input.stale_after_days ?? 7,
    stale_policy: input.stale_policy ?? 'notify_and_delete',
    session_id: input.session_id,
    tags: input.tags ?? [],
  }
}

export const standaloneCronApi = {
  getTasks: async (): Promise<CronTask[]> => {
    if (USE_BACKEND) {
      return mescliCronApi.getTasks()
    }
    const tasks = await dbGetAll<CronTask>('cronTasks')
    return tasks.sort((a, b) => {
      if (!a.next_run_at) return 1
      if (!b.next_run_at) return -1
      return new Date(a.next_run_at).getTime() - new Date(b.next_run_at).getTime()
    })
  },

  createTask: async (task: Omit<CronTask, 'id' | 'status' | 'created_at' | 'updated_at' | 'last_run_at' | 'next_run_at' | 'run_count'>): Promise<CronTask> => {
    if (USE_BACKEND) {
      return mescliCronApi.createTask(task)
    }
    const now = new Date().toISOString()
    const created = buildCronTask(task, generateCronTaskId(), now)
    await dbPut('cronTasks', created)
    return created
  },

  updateTask: async (id: string, updates: Partial<CronTask>): Promise<CronTask> => {
    if (USE_BACKEND) {
      return mescliCronApi.updateTask(id, updates)
    }
    const existing = await dbGet<CronTask>('cronTasks', id)
    if (!existing) throw new Error(`Task not found: ${id}`)

    const now = new Date().toISOString()
    const updated: CronTask = {
      ...existing,
      ...updates,
      cron: updates.cron ?? existing.cron,
      payload: updates.payload ?? existing.payload,
      updated_at: now,
    }

    if (updates.cron?.expression !== undefined || updates.is_enabled !== undefined) {
      updated.next_run_at = updated.is_enabled ? computeNextRun(updated.cron?.expression) : undefined
    }

    await dbPut('cronTasks', updated)
    return updated
  },

  deleteTask: async (id: string): Promise<void> => {
    if (USE_BACKEND) {
      await mescliCronApi.deleteTask(id)
      return
    }
    await dbDelete('cronTasks', id)
  },

  runTask: async (id: string): Promise<CronTaskResult> => {
    if (USE_BACKEND) {
      return mescliCronApi.runTask(id)
    }

    const task = await dbGet<CronTask>('cronTasks', id)
    if (!task) throw new Error(`Task not found: ${id}`)

    const triggeredAt = new Date().toISOString()
    const mode = task.payload?.execution_mode ?? 'llm_prompt'
    let success = true
    let output = ''
    let errorMessage = ''

    try {
      if (mode === 'llm_prompt') {
        const prompt = (task.payload?.prompt as string) || ''
        if (!prompt) throw new Error('缺少 prompt')

        const config = getStandaloneConfig()
        const provider = PROVIDERS[config.provider] || PROVIDERS.kimi
        // standalone 模式下使用已构建好的 registry（config.systemPrompt 已包含 identity prompt）
        const fallbackRegistry = buildCapabilityRegistry({
          mode: 'standalone',
          webBridgeStatus: 'disconnected',
          isMesLoggedIn: false,
        })
        const messages: Message[] = [
          { role: 'system', content: config.systemPrompt || getIdentityPrompt(fallbackRegistry) },
          { role: 'user', content: prompt },
        ]
        const request: ChatRequest = {
          provider: config.provider,
          model: config.model,
          baseUrl: config.apiBase,
          apiKey: config.apiKey,
          messages,
        }

        let content = ''
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('执行超时')), 5 * 60 * 1000)
          standaloneChatApi.streamChat(
            request,
            (chunk) => {
              if (chunk.type === 'content' && chunk.content) {
                content += chunk.content
              }
            },
            (err) => {
              clearTimeout(timer)
              reject(err)
            },
            () => {
              clearTimeout(timer)
              resolve()
            }
          )
        })
        output = content
      } else if (mode === 'workflow') {
        throw new Error('Standalone 模式不支持需要 MES 数据库的工作流任务')
      } else {
        throw new Error(`Standalone 模式暂不支持执行模式: ${mode}`)
      }
    } catch (err) {
      success = false
      errorMessage = err instanceof Error ? err.message : '执行失败'
    }

    const completedAt = new Date().toISOString()
    const result: CronTaskResult = {
      task_id: id,
      triggered_at: triggeredAt,
      completed_at: completedAt,
      status: (success ? 'completed' : 'failed') as TaskStatus,
      output,
      error_message: errorMessage || undefined,
      execution_time_ms: new Date(completedAt).getTime() - new Date(triggeredAt).getTime(),
    }
    await dbPut('cronTaskExecutions', result)

    // 更新任务计数与下次执行时间
    const nextRun = task.is_enabled ? computeNextRun(task.cron?.expression, new Date(completedAt)) : undefined
    const updated: CronTask = {
      ...task,
      status: result.status,
      last_run_at: completedAt,
      next_run_at: nextRun,
      run_count: (task.run_count ?? 0) + 1,
      updated_at: completedAt,
    }
    await dbPut('cronTasks', updated)

    return result
  },

  toggleTask: async (id: string): Promise<CronTask> => {
    if (USE_BACKEND) {
      return mescliCronApi.toggleTask(id)
    }
    const existing = await dbGet<CronTask>('cronTasks', id)
    if (!existing) throw new Error(`Task not found: ${id}`)
    const now = new Date().toISOString()
    const isEnabled = !(existing.is_enabled ?? true)
    const updated: CronTask = {
      ...existing,
      is_enabled: isEnabled,
      next_run_at: isEnabled ? computeNextRun(existing.cron?.expression) : undefined,
      updated_at: now,
    }
    await dbPut('cronTasks', updated)
    return updated
  },

  // Internal helpers used by standalone cron scheduler store
  _saveTask: async (task: CronTask): Promise<void> => {
    await dbPut('cronTasks', task)
  },

  _saveExecution: async (result: CronTaskResult): Promise<void> => {
    await dbPut('cronTaskExecutions', result)
  },

  _getExecutions: async (taskId: string, limit = 20): Promise<CronTaskResult[]> => {
    const all = await dbGetAll<CronTaskResult>('cronTaskExecutions')
    return all
      .filter((r) => r.task_id === taskId)
      .sort((a, b) => new Date(b.triggered_at).getTime() - new Date(a.triggered_at).getTime())
      .slice(0, limit)
  },
}

function generateDagWorkflowId(): string {
  return `dag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export const standaloneDagWorkflowApi = {
  getAll: async (): Promise<DagWorkflow[]> => {
    const items = await dbGetAll<DagWorkflow>('dagWorkflows')
    return items.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  },

  getById: async (id: string): Promise<DagWorkflow | undefined> => {
    return dbGet<DagWorkflow>('dagWorkflows', id)
  },

  create: async (workflow: Omit<DagWorkflow, 'id' | 'createdAt' | 'updatedAt'>): Promise<DagWorkflow> => {
    const now = new Date().toISOString()
    const created: DagWorkflow = {
      ...workflow,
      id: generateDagWorkflowId(),
      createdAt: now,
      updatedAt: now,
    }
    await dbPut('dagWorkflows', created)
    return created
  },

  update: async (id: string, updates: Partial<DagWorkflow>): Promise<DagWorkflow> => {
    const existing = await dbGet<DagWorkflow>('dagWorkflows', id)
    if (!existing) throw new Error(`DAG workflow not found: ${id}`)

    const updated: DagWorkflow = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    }
    await dbPut('dagWorkflows', updated)
    return updated
  },

  delete: async (id: string): Promise<void> => {
    await dbDelete('dagWorkflows', id)
  },

  duplicate: async (id: string): Promise<DagWorkflow> => {
    const original = await dbGet<DagWorkflow>('dagWorkflows', id)
    if (!original) throw new Error(`DAG workflow not found: ${id}`)
    const now = new Date().toISOString()
    const copy: DagWorkflow = {
      ...original,
      id: generateDagWorkflowId(),
      name: `${original.name} (Copy)`,
      createdAt: now,
      updatedAt: now,
    }
    await dbPut('dagWorkflows', copy)
    return copy
  },

  /** Standalone 模式下导出全部工作流为 JSON Blob */
  exportAll: async (): Promise<Blob> => {
    const items = await dbGetAll<DagWorkflow>('dagWorkflows')
    const exportDto = {
      ExportedAt: new Date().toISOString(),
      Version: '1.0',
      Workflows: items.map((wf) => ({
        Name: wf.name,
        Description: wf.description,
        Version: wf.version,
        NodesJson: JSON.stringify(wf.nodes),
        EdgesJson: JSON.stringify(wf.edges),
        InputSchemaJson: wf.inputSchema ? JSON.stringify(wf.inputSchema) : null,
        OutputMappingJson: wf.outputMapping ? JSON.stringify(wf.outputMapping) : null,
        SecurityPolicyJson: wf.securityPolicy ? JSON.stringify(wf.securityPolicy) : null,
        TagsJson: wf.tags ? JSON.stringify(wf.tags) : null,
      })),
    }
    const json = JSON.stringify(exportDto, null, 2)
    return new Blob([json], { type: 'application/json' })
  },

  /** Standalone 模式下从 JSON 文本导入工作流 */
  import: async (jsonText: string): Promise<DagWorkflow[]> => {
    const parsed = JSON.parse(jsonText)
    const items = parsed.Workflows ?? parsed.workflows ?? (Array.isArray(parsed) ? parsed : [parsed])
    const imported: DagWorkflow[] = []
    for (const wf of items) {
      const now = new Date().toISOString()
      const created: DagWorkflow = {
        id: generateDagWorkflowId(),
        name: wf.Name || wf.name || 'Imported Workflow',
        description: wf.Description ?? wf.description ?? '',
        version: wf.Version ?? wf.version ?? '1.0.0',
        nodes: wf.NodesJson ? JSON.parse(wf.NodesJson) : (wf.nodes ?? []),
        edges: wf.EdgesJson ? JSON.parse(wf.EdgesJson) : (wf.edges ?? []),
        inputSchema: wf.InputSchemaJson ? JSON.parse(wf.InputSchemaJson) : (wf.inputSchema ?? undefined),
        outputMapping: wf.OutputMappingJson ? JSON.parse(wf.OutputMappingJson) : (wf.outputMapping ?? undefined),
        securityPolicy: wf.SecurityPolicyJson ? JSON.parse(wf.SecurityPolicyJson) : (wf.securityPolicy ?? undefined),
        tags: wf.TagsJson ? JSON.parse(wf.TagsJson) : (wf.tags ?? undefined),
        createdAt: now,
        updatedAt: now,
      }
      await dbPut('dagWorkflows', created)
      imported.push(created)
    }
    return imported
  },
}

// ==================== 插件 API（Standalone 模式） ====================

/**
 * 简易 ZIP 解析器：从插件包中提取 manifest.json。
 * 支持 Deflate（通过 DecompressionStream）和 Stored（无压缩）两种压缩方式。
 */
async function extractManifestFromPluginPackage(file: File): Promise<PluginManifest> {
  const buffer = await file.arrayBuffer()
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  // 1. 定位 End of Central Directory Record（EOCD）
  let eocdOffset = -1
  const searchRange = Math.min(bytes.length, 65536)
  for (let i = bytes.length - 22; i >= bytes.length - searchRange && i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset === -1) {
    // 可能不是 ZIP，尝试直接按 JSON 解析
    const text = new TextDecoder().decode(bytes)
    try {
      return JSON.parse(text) as PluginManifest
    } catch {
      throw new Error('插件包格式无效：无法解析 ZIP 或 JSON')
    }
  }

  const centralDirOffset = view.getUint32(eocdOffset + 16, true)
  const totalEntries = view.getUint16(eocdOffset + 10, true)

  // 2. 遍历 Central Directory 查找 manifest.json
  let offset = centralDirOffset
  let manifestEntry:
    | { localHeaderOffset: number; compressedSize: number; uncompressedSize: number; compressionMethod: number }
    | undefined

  for (let entry = 0; entry < totalEntries; entry++) {
    if (offset + 46 > bytes.length) break
    const signature = view.getUint32(offset, true)
    if (signature !== 0x02014b50) break

    const compressionMethod = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const fileNameLength = view.getUint16(offset + 28, true)
    const extraFieldLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localHeaderOffset = view.getUint32(offset + 42, true)

    const fileNameBytes = bytes.slice(offset + 46, offset + 46 + fileNameLength)
    const fileName = new TextDecoder().decode(fileNameBytes)

    if (fileName === 'manifest.json' || fileName.endsWith('/manifest.json')) {
      manifestEntry = {
        localHeaderOffset,
        compressedSize,
        uncompressedSize,
        compressionMethod,
      }
      break
    }

    offset += 46 + fileNameLength + extraFieldLength + commentLength
  }

  if (!manifestEntry) {
    throw new Error('插件包中缺少 manifest.json')
  }

  // 3. 读取 Local Header，定位文件数据起始位置
  const { localHeaderOffset, compressionMethod, compressedSize, uncompressedSize } = manifestEntry
  if (localHeaderOffset + 30 > bytes.length) {
    throw new Error('插件包本地文件头超出范围')
  }

  const localSignature = view.getUint32(localHeaderOffset, true)
  if (localSignature !== 0x04034b50) {
    throw new Error('插件包本地文件头签名无效')
  }

  const localFileNameLength = view.getUint16(localHeaderOffset + 26, true)
  const localExtraLength = view.getUint16(localHeaderOffset + 28, true)
  const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraLength
  const dataBytes = bytes.slice(dataOffset, dataOffset + compressedSize)

  let manifestText: string
  if (compressionMethod === 0) {
    manifestText = new TextDecoder().decode(dataBytes)
  } else if (compressionMethod === 8) {
    // Deflate
    try {
      const ds = new DecompressionStream('deflate-raw')
      const writer = ds.writable.getWriter()
      await writer.write(dataBytes)
      await writer.close()
      const output = []
      const reader = ds.readable.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        output.push(value)
      }
      const totalLength = output.reduce((sum, arr) => sum + arr.length, 0)
      const decompressed = new Uint8Array(totalLength)
      let pos = 0
      for (const arr of output) {
        decompressed.set(arr, pos)
        pos += arr.length
      }
      manifestText = new TextDecoder().decode(decompressed)
    } catch {
      throw new Error('解压 manifest.json 失败，请尝试使用无压缩方式打包 ZIP')
    }
  } else {
    throw new Error(`不支持的 ZIP 压缩方式：${compressionMethod}`)
  }

  try {
    return JSON.parse(manifestText) as PluginManifest
  } catch {
    throw new Error('manifest.json 不是有效的 JSON')
  }
}

export const standalonePluginApi = {
  getPlugins: async (): Promise<InstalledPlugin[]> => {
    if (USE_BACKEND) {
      return backendFetch<InstalledPlugin[]>('/api/plugins')
    }
    return dbGetAll<InstalledPlugin>('plugins')
  },

  getPlugin: async (id: string): Promise<InstalledPlugin | undefined> => {
    if (USE_BACKEND) {
      return backendFetch<InstalledPlugin>(`/api/plugins/${id}`)
    }
    return dbGet<InstalledPlugin>('plugins', id)
  },

  installPlugin: async (file: File): Promise<InstalledPlugin> => {
    if (USE_BACKEND) {
      const formData = new FormData()
      formData.append('package', file)
      return backendFetch<InstalledPlugin>('/api/plugins/install', {
        method: 'POST',
        body: formData,
      })
    }
    const manifest = await extractManifestFromPluginPackage(file)
    const validation = validateManifest(manifest)
    if (!validation.valid) {
      throw new Error(`manifest 校验失败：${validation.errors.join('；')}`)
    }

    const existing = await dbGet<InstalledPlugin>('plugins', manifest.id)
    const now = new Date().toISOString()
    const installed: InstalledPlugin = {
      id: manifest.id,
      manifest,
      isEnabled: existing?.isEnabled ?? true,
      installedAt: existing?.installedAt || now,
      updatedAt: now,
      packageHash: `${file.name}-${file.size}-${file.lastModified}`,
    }
    await dbPut('plugins', installed)
    return installed
  },

  uninstallPlugin: async (id: string): Promise<void> => {
    if (USE_BACKEND) {
      await backendFetch<void>(`/api/plugins/${id}`, { method: 'DELETE' })
      return
    }
    await dbDelete('plugins', id)
  },

  togglePlugin: async (id: string, isEnabled: boolean): Promise<InstalledPlugin> => {
    if (USE_BACKEND) {
      return backendFetch<InstalledPlugin>(`/api/plugins/${id}/toggle`, {
        method: 'POST',
        body: JSON.stringify({ isEnabled }),
      })
    }
    const existing = await dbGet<InstalledPlugin>('plugins', id)
    if (!existing) throw new Error(`Plugin not found: ${id}`)
    const updated: InstalledPlugin = {
      ...existing,
      isEnabled,
      updatedAt: new Date().toISOString(),
    }
    await dbPut('plugins', updated)
    return updated
  },
}

// ==================== 导出配置工具 ====================

export { getStandaloneConfig, setStandaloneConfig, PROVIDERS, getProviderSupportsTools }
export type { StandaloneConfig }
