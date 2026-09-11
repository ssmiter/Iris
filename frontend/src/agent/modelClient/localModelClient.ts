import { normalizeToolCalls } from '@/utils/normalizeToolCalls'
import type { Message, ToolDefinition, StreamChunk, LocalModelProvider } from '@/types/mescli'
import type {
  ModelClient,
  ModelClientRequest,
  ModelClientStreamCallbacks,
} from './modelClient'
import { buildLocalModelMessages } from './messageNormalizer'
import { createRetryableStream, type StreamAttempt } from './retryingStream'
import { createUsageTrackingCallbacks } from './usageTracking'

/**
 * 本地模型 ModelClient
 *
 * 适用于：
 * - Ollama
 * - LM Studio
 * - WebLLM（预留）
 */

export interface LocalModelClientOptions {
  providerId: string
  baseUrl: string
  defaultModel?: string
  apiKey?: string
}

export function createLocalModelClient(
  providerId: string,
  baseUrl?: string,
  options?: Partial<LocalModelClientOptions>
): ModelClient {
  const effectiveBaseUrl = baseUrl || ''
  const defaultModel = options?.defaultModel || ''
  const apiKey = options?.apiKey || ''

  return {
    providerId,
    supportsTools: true,

    streamChat(request: ModelClientRequest, userCallbacks: ModelClientStreamCallbacks): () => void {
      const isOllama = providerId === 'ollama'
      const url = isOllama
        ? `${effectiveBaseUrl}/api/chat`
        : `${effectiveBaseUrl}/v1/chat/completions`
      const body = buildLocalModelRequestBody(request, isOllama, defaultModel)

      const { callbacks, reportUsage } = createUsageTrackingCallbacks(request, userCallbacks)

      const retryable = createRetryableStream({
        retryOptions: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 8000 },
        callbacks,
        start: (streamCallbacks) =>
          executeStreaming({
            url,
            apiKey,
            body: JSON.stringify(body),
            isOllama,
            callbacks: streamCallbacks,
          }),
      })

      retryable.finished.then(reportUsage).catch(() => {
        // 错误已通过 callbacks.onError 发出
      })

      return retryable.abort
    },
  }
}

function buildLocalModelRequestBody(
  request: ModelClientRequest,
  isOllama: boolean,
  defaultModel: string
): Record<string, unknown> {
  const messages = buildLocalModelMessages(request, isOllama)

  const cleanTools =
    request.tools?.map((tool) => {
      const { defer_loading, ...rest } = tool.function as Record<string, unknown>
      return {
        type: 'function' as const,
        function: rest as { name: string; description: string; parameters?: unknown; strict?: boolean },
      }
    }) ?? []

  if (isOllama) {
    return {
      model: request.model || defaultModel,
      messages,
      stream: true,
      ...(cleanTools.length > 0 ? { tools: cleanTools } : {}),
    }
  }

  return {
    model: request.model || defaultModel,
    messages,
    temperature: request.temperature ?? 0.7,
    max_tokens: request.maxTokens ?? 2048,
    stream: true,
    ...(cleanTools.length > 0
      ? { tools: cleanTools, tool_choice: 'auto' }
      : {}),
  }
}

interface ExecuteStreamingOptions {
  url: string
  apiKey: string
  body: string
  isOllama: boolean
  callbacks: ModelClientStreamCallbacks
}

function executeStreaming(options: ExecuteStreamingOptions): StreamAttempt {
  const { url, apiKey, body, isOllama, callbacks } = options
  const abortController = new AbortController()

  const finished = fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body,
    signal: abortController.signal,
    credentials: 'omit',
  })
    .then(async (response) => {
      if (!response.ok) {
        const text = await response.text()
        const error = new Error(`HTTP ${response.status}: ${text}`)
        ;(error as { status?: number }).status = response.status
        throw error
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('Response body is null')

      const decoder = new TextDecoder()
      let buffer = ''

      try {
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
              parseOllamaLine(trimmed, callbacks)
            } else {
              parseOpenAICompatibleLine(trimmed, callbacks)
            }
          }
        }
      } finally {
        reader.releaseLock()
        try {
          await response.body?.cancel()
        } catch {
          // ignore
        }
      }

      callbacks.onDone()
    })
    .catch((error) => {
      if (error.name !== 'AbortError') {
        callbacks.onError(error)
      }
      throw error
    })

  return {
    abort: () => abortController.abort(),
    finished,
  }
}

function parseOllamaLine(line: string, callbacks: ModelClientStreamCallbacks): void {
  try {
    const parsed = JSON.parse(line)
    const content = parsed.message?.content
    if (content) {
      callbacks.onChunk({ type: 'content', content: String(content) })
    }
    const toolCalls = parsed.message?.tool_calls
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      callbacks.onChunk({ type: 'tool_call', toolCalls: normalizeToolCalls(toolCalls) })
    }
    if (parsed.done) {
      callbacks.onDone()
    }
  } catch {
    // ignore
  }
}
function parseOpenAICompatibleLine(line: string, callbacks: ModelClientStreamCallbacks): void {
  if (!line.startsWith('data: ')) return
  const data = line.slice(6)
  if (data === '[DONE]') {
    callbacks.onDone()
    return
  }
  try {
    const parsed = JSON.parse(data)
    const choices = parsed.choices as Array<Record<string, unknown>> | undefined
    const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
    if (delta?.content) {
      callbacks.onChunk({ type: 'content', content: String(delta.content) })
    }
    const toolCalls = delta?.tool_calls
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      callbacks.onChunk({ type: 'tool_call', toolCalls: normalizeToolCalls(toolCalls) })
    }
  } catch {
    // ignore
  }
}
