import type { LocalModelConfig, LocalModelInfo, LocalModelProvider, Message, ToolDefinition, ToolCall } from '@/types/mescli'
import type { StreamChunk } from './client'

export interface LocalModelDetectionResult {
  available: boolean
  models: LocalModelInfo[]
  error?: string
}

const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434'
const LMSTUDIO_DEFAULT_BASE_URL = 'http://localhost:1234'

async function safeFetch(url: string, options?: RequestInit, timeoutMs = 5000): Promise<Response | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      credentials: 'omit',
    })
    return response
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function detectOllama(baseUrl: string = OLLAMA_DEFAULT_BASE_URL): Promise<LocalModelDetectionResult> {
  const response = await safeFetch(`${baseUrl}/api/tags`)
  if (!response || !response.ok) {
    return { available: false, models: [], error: '无法连接 Ollama 服务' }
  }
  try {
    const data = (await response.json()) as { models?: Array<{ name: string; size?: number } > }
    const models = (data.models || []).map((m) => ({
      id: m.name,
      name: m.name,
      provider: 'ollama' as LocalModelProvider,
      baseUrl,
      size: m.size,
    }))
    return { available: models.length > 0, models }
  } catch {
    return { available: false, models: [], error: '解析 Ollama 模型列表失败' }
  }
}

async function detectLmStudio(baseUrl: string = LMSTUDIO_DEFAULT_BASE_URL): Promise<LocalModelDetectionResult> {
  const response = await safeFetch(`${baseUrl}/v1/models`)
  if (!response || !response.ok) {
    return { available: false, models: [], error: '无法连接 LM Studio 服务' }
  }
  try {
    const data = (await response.json()) as { data?: Array<{ id: string } > }
    const models = (data.data || []).map((m) => ({
      id: m.id,
      name: m.id,
      provider: 'lmstudio' as LocalModelProvider,
      baseUrl,
    }))
    return { available: models.length > 0, models }
  } catch {
    return { available: false, models: [], error: '解析 LM Studio 模型列表失败' }
  }
}

async function detectWebLLM(): Promise<LocalModelDetectionResult> {
  // WebLLM 需要额外引入 @mlc-ai/web-llm，当前版本仅保留接口占位
  return { available: false, models: [], error: 'WebLLM 支持尚未启用' }
}

async function listModels(config: LocalModelConfig): Promise<LocalModelInfo[]> {
  if (config.provider === 'ollama') {
    const result = await detectOllama(config.baseUrl)
    return result.models
  }
  if (config.provider === 'lmstudio') {
    const result = await detectLmStudio(config.baseUrl)
    return result.models
  }
  if (config.provider === 'webllm') {
    const result = await detectWebLLM()
    return result.models
  }
  return []
}

function mapLocalMessage(m: Message): Record<string, unknown> {
  const mapped: Record<string, unknown> = {
    role: m.role,
    content: m.content,
  }
  if (m.toolCalls && m.toolCalls.length > 0) {
    mapped.tool_calls = m.toolCalls
  }
  if (m.toolCallId) {
    mapped.tool_call_id = m.toolCallId
  }
  return mapped
}

function normalizeToolCalls(raw: unknown[]): ToolCall[] {
  return raw.map((tc: any) => ({
    id: tc.id || `tc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: 'function' as const,
    function: {
      name: tc.function?.name || '',
      arguments:
        typeof tc.function?.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments || {}),
    },
  }))
}

function streamChat(
  config: LocalModelConfig,
  messages: Message[],
  onChunk: (chunk: StreamChunk) => void,
  onError?: (error: Error) => void,
  onDone?: () => void,
  tools?: ToolDefinition[]
): () => void {
  const abortController = new AbortController()
  const baseUrl = config.baseUrl
  const isOllama = config.provider === 'ollama'
  const url = isOllama ? `${baseUrl}/api/chat` : `${baseUrl}/v1/chat/completions`

  const body = isOllama
    ? {
        model: config.model,
        messages: messages.map(mapLocalMessage),
        stream: true,
        ...(tools && tools.length > 0 ? { tools } : {}),
      }
    : {
        model: config.model,
        messages: messages.map(mapLocalMessage),
        temperature: config.temperature ?? 0.7,
        max_tokens: config.maxTokens ?? 2048,
        stream: true,
        ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      }

  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: abortController.signal,
    credentials: 'omit',
  })
    .then(async (response) => {
      if (!response.ok) {
        const text = await response.text()
        throw new Error(`HTTP ${response.status}: ${text}`)
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('Response body is null')

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          if (isOllama) {
            try {
              const parsed = JSON.parse(trimmed)
              const content = parsed.message?.content
              if (content) {
                onChunk({ type: 'content', content: String(content) })
              }
              const toolCalls = parsed.message?.tool_calls
              if (Array.isArray(toolCalls) && toolCalls.length > 0) {
                onChunk({ type: 'tool_call', toolCalls: normalizeToolCalls(toolCalls) })
              }
              if (parsed.done) {
                onDone?.()
                return
              }
            } catch {
              // ignore
            }
          } else {
            if (!trimmed.startsWith('data: ')) continue
            const data = trimmed.slice(6)
            if (data === '[DONE]') {
              onDone?.()
              return
            }
            try {
              const parsed = JSON.parse(data)
              const choices = parsed.choices as Array<Record<string, unknown>> | undefined
              const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
              if (delta?.content) {
                onChunk({ type: 'content', content: String(delta.content) })
              }
              const toolCalls = delta?.tool_calls
              if (Array.isArray(toolCalls) && toolCalls.length > 0) {
                onChunk({ type: 'tool_call', toolCalls: normalizeToolCalls(toolCalls) })
              }
            } catch {
              // ignore
            }
          }
        }
      }

      onDone?.()
    })
    .catch((error) => {
      if (error.name !== 'AbortError') {
        onError?.(error)
      }
    })

  return () => abortController.abort()
}

export const localModelApi = {
  detectOllama,
  detectLmStudio,
  detectWebLLM,
  listModels,
  streamChat,
}

export { OLLAMA_DEFAULT_BASE_URL, LMSTUDIO_DEFAULT_BASE_URL }
