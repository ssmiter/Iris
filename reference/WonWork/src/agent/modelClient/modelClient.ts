/**
 * ModelClient 抽象层
 *
 * 对齐 claude-code 的 `deps.callModel(options)` 设计：
 * - Agentic 循环只依赖 `ModelClient` 接口，不感知具体 Provider 协议
 * - 每个 Provider（OpenAI/Anthropic/本地模型）实现相同的调用契约
 * - 工具调用、流式解析、错误处理都封装在实现内部
 *
 * 当前采用回调式流接口（与 WonWork 现有 SSE 架构兼容），
 * 未来可演进为 AsyncIterable<StreamChunk>。
 */

import type { Message, ToolDefinition, StreamChunk } from '@/types/mescli'
import type { ExecutionMode } from '@/agent/types'

export interface ModelClientRequest {
  provider: string
  model: string
  apiKey?: string
  baseUrl?: string
  temperature?: number
  maxTokens?: number
  systemPrompt?: string
  skillPrompts?: string[]
  messages: Message[]
  tools?: ToolDefinition[]
  executionMode?: ExecutionMode
  /** 透传字段，用于后端审计/链路追踪 */
  conversationId?: number
  systemCode?: string
  /** 是否保存到历史记录；内部工作流生成/修复等调用应设为 false */
  saveToHistory?: boolean
}

export interface ModelClientStreamCallbacks {
  onChunk: (chunk: StreamChunk) => void
  onError: (error: Error) => void
  onDone: () => void
}

export interface ModelClient {
  /** Provider 标识，如 openai / anthropic / ollama */
  readonly providerId: string
  /** 该 Provider 是否支持 function calling */
  readonly supportsTools: boolean
  /**
   * 发起流式对话。
   * 返回一个 abort 函数，用于中断请求。
   */
  streamChat(request: ModelClientRequest, callbacks: ModelClientStreamCallbacks): () => void
}

/**
 * ModelClient 工厂。
 *
 * 根据 providerId 和 baseUrl 创建对应实现。
 * 未知 Provider 默认按 OpenAI 兼容协议处理。
 */
export async function createModelClient(
  providerId: string,
  baseUrl?: string
): Promise<ModelClient> {
  const factory = MODEL_CLIENT_REGISTRY.get(providerId)
  if (factory) {
    return factory(baseUrl)
  }

  // 未知 provider：尝试识别 Anthropic 兼容，否则按 OpenAI 兼容兜底
  if (isAnthropicCompatibleProvider(providerId, baseUrl)) {
    const { createAnthropicModelClient } = await import('./anthropicModelClient')
    return createAnthropicModelClient(providerId, baseUrl)
  }

  const { createOpenAIModelClient } = await import('./openaiModelClient')
  return createOpenAIModelClient(providerId, baseUrl)
}

const MODEL_CLIENT_REGISTRY = new Map<
  string,
  (baseUrl?: string) => ModelClient
>()

export function registerModelClient(
  providerId: string,
  factory: (baseUrl?: string) => ModelClient
): void {
  MODEL_CLIENT_REGISTRY.set(providerId, factory)
}

/**
 * 注册本地模型客户端。
 * 本地模型（Ollama/LM Studio）调用方式与云端不同，单独注册。
 */
export function registerLocalModelClient(factory: (baseUrl?: string) => ModelClient): void {
  registerModelClient('ollama', factory)
  registerModelClient('lmstudio', factory)
  registerModelClient('webllm', factory)
}

/**
 * 判断 Provider 是否走 Anthropic 兼容协议。
 */
export function isAnthropicCompatibleProvider(providerId: string, baseUrl?: string): boolean {
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
 * 判断当前 Provider/模型是否支持 Anthropic tool_reference / defer_loading beta。
 *
 * 仅 Anthropic 原生协议（Claude、Kimi Code 等）支持 defer_loading；
 * OpenAI 兼容、本地模型、第三方代理不支持，需要前端过滤延迟工具。
 */
export function providerSupportsDeferredLoading(
  providerId: string,
  model?: string
): boolean {
  if (!isAnthropicCompatibleProvider(providerId, undefined)) return false
  // 已知不支持 tool_reference 的模型模式（如 haiku）
  if (model) {
    const lower = model.toLowerCase()
    if (lower.includes('haiku')) return false
  }
  return true
}

/**
 * 判断 Provider 是否支持 function calling。
 */
export function modelClientSupportsTools(providerId: string, baseUrl?: string): boolean {
  if (isAnthropicCompatibleProvider(providerId, baseUrl)) return true
  // 本地模型默认支持（实际能力由 localModelClient 内部处理）
  if (providerId === 'ollama' || providerId === 'lmstudio' || providerId === 'webllm') return true
  // 已知 OpenAI 兼容 Provider 均支持 tools
  const knownOpenAICompatibleIds = new Set([
    'openai', 'kimi', 'deepseek', 'qwen', 'zhipu', 'baichuan',
    'spark', 'hunyuan', 'doubao', 'ernie', 'custom',
  ])
  if (knownOpenAICompatibleIds.has(providerId)) return true
  // 未知 Provider 按 OpenAI 兼容协议处理，让其自行失败而非前端拦截
  return true
}
