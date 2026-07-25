/**
 * Anthropic 兼容 ModelClient
 *
 * 适用于：
 * - Claude 官方 API
 * - Kimi Code（https://api.kimi.com/coding）
 * - 其他 Anthropic Messages API 兼容端点
 */

import type { Message, ToolDefinition, StreamChunk } from '@/types/mescli'
import type {
  ModelClient,
  ModelClientRequest,
  ModelClientStreamCallbacks,
} from './modelClient'
import type { TransportProvider } from '@/agent/transport/transport'
import {
  buildAnthropicMessagesUrl,
  openaiToolToAnthropic,
} from '@/api/standalone/anthropicMessages'
import {
  createAnthropicStreamParserState,
  parseAnthropicStreamEvent,
} from '@/api/standalone/anthropicStreamParser'
import { createSSEParserState, parseSSEBuffer, flushSSEBuffer, parseSSEData } from '@/utils/sseParser'
import type { SSEEvent } from '@/utils/sseParser'
import { useUsageStore, buildTodayUsageRecord } from '@/stores/usageStore'
import { estimateTextTokens } from '@/utils/tokenEstimator'
import { buildAnthropicMessages } from './messageNormalizer'
import { createRetryableStream, type StreamAttempt } from './retryingStream'

export interface AnthropicModelClientOptions {
  providerId: string
  baseUrl: string
  defaultModel?: string
  transport?: TransportProvider
  /** Anthropic API version */
  apiVersion?: string
}

export function createAnthropicModelClient(
  providerId: string,
  baseUrl?: string,
  options?: Partial<AnthropicModelClientOptions>
): ModelClient {
  const effectiveBaseUrl = baseUrl || ''
  const defaultModel = options?.defaultModel || ''
  const apiVersion = options?.apiVersion || '2023-06-01'
  const transport =
    options?.transport ||
    (import.meta.env.DEV &&
    providerId === 'kimi-code' &&
    import.meta.env.VITE_USE_BACKEND_API !== 'true'
      ? new AnthropicDevProxyTransport()
      : new BrowserFetchTransport())

  return {
    providerId,
    supportsTools: true,

    streamChat(request: ModelClientRequest, userCallbacks: ModelClientStreamCallbacks): () => void {
      const effectiveModel = request.model || defaultModel
      const effectiveApiKey = request.apiKey || ''
      const body = buildAnthropicRequestBody(request, effectiveModel)
      const url = transport.buildUrl(providerId, effectiveBaseUrl, { isAnthropic: true })

      const { callbacks, reportUsage } = createUsageTrackingCallbacks(request, userCallbacks)

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': effectiveApiKey,
        'anthropic-version': apiVersion,
      }

      const retryable = createRetryableStream({
        retryOptions: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 8000 },
        callbacks,
        start: (streamCallbacks) =>
          executeStreaming({
            transport,
            url,
            headers,
            body: JSON.stringify(body),
            callbacks: streamCallbacks,
          }),
        fallback: (streamCallbacks) =>
          executeFallback({
            transport,
            url,
            headers,
            body: JSON.stringify({ ...body, stream: false }),
            callbacks: streamCallbacks,
          }),
      })

      retryable.finished.then(reportUsage).catch(() => {
        // 错误已通过 callbacks.onError 发出；兜底失败时不重复上报用量
      })

      return retryable.abort
    },
  }
}

function buildAnthropicRequestBody(
  request: ModelClientRequest,
  effectiveModel: string
): Record<string, unknown> {
  const { system, messages } = buildAnthropicMessages(request)

  const body: Record<string, unknown> = {
    model: effectiveModel,
    messages,
    system,
    max_tokens: request.maxTokens ?? 2048,
    stream: true,
  }

  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map(openaiToolToAnthropic)
    body.tool_choice = { type: 'auto' }
  }

  return body
}

interface ExecuteOptions {
  transport: TransportProvider
  url: string
  headers: Record<string, string>
  body: string
  callbacks: ModelClientStreamCallbacks
}

function executeStreaming(options: ExecuteOptions): StreamAttempt {
  const { transport, url, headers, body, callbacks } = options
  const abortController = new AbortController()
  const anthropicStreamState = createAnthropicStreamParserState()

  const finished = transport
    .fetch({
      url,
      method: 'POST',
      headers,
      body,
      signal: abortController.signal,
    })
    .then(async (response) => {
      if (!response.ok) {
        const text = await response.text()
        let errorMessage = text
        try {
          const parsed = JSON.parse(text)
          errorMessage =
            (parsed.error?.message || parsed.error || parsed.message || text) as string
        } catch {
          // ignore
        }
        const error = new Error(`AI 服务请求失败 (${response.status}): ${errorMessage}`)
        ;(error as { status?: number }).status = response.status
        throw error
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('Response body is null')

      // 与 openaiModelClient 对齐的防御：部分网关/代理在业务错误时返回
      // HTTP 200 + 普通 JSON 错误体（而非 SSE 流）。不检测的话会把错误 JSON
      // 喂给 SSE 解析器，解析不出任何 chunk，表现为"空回答/工具不触发"且无任何报错。
      const contentType = response.headers.get('content-type') || ''
      if (!contentType.includes('text/event-stream')) {
        const text = await response.text()
        let errorMessage = text.slice(0, 500)
        try {
          const parsed = JSON.parse(text)
          errorMessage =
            (parsed.error?.message || parsed.error || parsed.message || errorMessage) as string
        } catch {
          // 非 JSON 错误体，保留原文
        }
        throw new Error(`AI 服务返回了非流式响应（可能是业务错误）: ${errorMessage}`)
      }

      const decoder = new TextDecoder()
      const sseState = createSSEParserState()

      const handleEvent = (event: SSEEvent): boolean => {
        if (event.event === 'chunk' || event.event === 'message') {
          const parsed = parseSSEData(event.data)
          if (parsed && typeof parsed === 'object' && 'done' in parsed) {
            callbacks.onDone()
            return true
          }
          try {
            const parsedData = parsed as Record<string, unknown>
            const chunk = parseAnthropicStreamEvent(parsedData, anthropicStreamState)
            if (chunk) callbacks.onChunk(chunk)
          } catch {
            // ignore parse errors
          }
          return false
        }

        if (event.event === 'done') {
          callbacks.onDone()
          return true
        }

        if (event.event === 'error') {
          const parsed = parseSSEData(event.data)
          const errorMessage =
            parsed && typeof parsed === 'object'
              ? (parsed as { message?: string }).message || String(parsed)
              : String(event.data)
          callbacks.onError(new Error(errorMessage))
          return true
        }

        // Anthropic 原生 SSE 通常走 event: chunk/message，
        // 但为了兼容某些代理，其他事件也尝试解析
        try {
          const parsedData = parseSSEData(event.data) as Record<string, unknown>
          const chunk = parseAnthropicStreamEvent(parsedData, anthropicStreamState)
          if (chunk) callbacks.onChunk(chunk)
        } catch {
          // ignore
        }
        return false
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

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

function executeFallback(options: ExecuteOptions): StreamAttempt {
  const { transport, url, headers, body, callbacks } = options
  const abortController = new AbortController()

  const finished = transport
    .fetch({
      url,
      method: 'POST',
      headers,
      body,
      signal: abortController.signal,
    })
    .then(async (response) => {
      if (!response.ok) {
        const text = await response.text()
        let errorMessage = text
        try {
          const parsed = JSON.parse(text)
          errorMessage =
            (parsed.error?.message || parsed.error || parsed.message || text) as string
        } catch {
          // ignore
        }
        const error = new Error(`AI 服务请求失败 (${response.status}): ${errorMessage}`)
        ;(error as { status?: number }).status = response.status
        throw error
      }

      const data = (await response.json()) as Record<string, unknown>
      const content = data.content as Array<Record<string, unknown>> | undefined

      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            const text = block.text
            if (typeof text === 'string' && text.length > 0) {
              callbacks.onChunk({ type: 'content', content: text })
            }
          } else if (block.type === 'tool_use') {
            const id = String(block.id || '')
            const name = String(block.name || '')
            const input =
              typeof block.input === 'object' && block.input !== null
                ? JSON.stringify(block.input)
                : '{}'
            callbacks.onChunk({
              type: 'tool_call',
              toolCalls: [
                {
                  id,
                  type: 'function',
                  function: { name, arguments: input },
                },
              ],
            })
          } else if (block.type === 'thinking') {
            const thinking = block.thinking
            if (typeof thinking === 'string' && thinking.length > 0) {
              callbacks.onChunk({ type: 'reasoning', content: thinking })
            }
          }
        }
      }

      const usage = data.usage as Record<string, unknown> | undefined
      if (usage) {
        callbacks.onChunk({
          type: 'usage',
          usage: {
            tokensIn: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
            tokensOut: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
            cacheReadTokens:
              typeof usage.cache_read_input_tokens === 'number'
                ? usage.cache_read_input_tokens
                : undefined,
            cacheCreationTokens:
              typeof usage.cache_creation_input_tokens === 'number'
                ? usage.cache_creation_input_tokens
                : undefined,
          },
        })
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

export function createUsageTrackingCallbacks(
  request: ModelClientRequest,
  userCallbacks: ModelClientStreamCallbacks
): {
  callbacks: ModelClientStreamCallbacks
  reportUsage: () => void
} {
  let outputText = ''
  let realTokensIn: number | undefined
  let realTokensOut: number | undefined

  const reportUsage = () => {
    const inputText = request.messages.map((m) => m.content).join('\n')
    const tokensIn = realTokensIn ?? estimateTextTokens(inputText)
    const tokensOut = realTokensOut ?? estimateTextTokens(outputText)
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

  const callbacks: ModelClientStreamCallbacks = {
    onChunk: (chunk) => {
      if (chunk.type === 'content') {
        outputText += chunk.content || ''
      } else if (chunk.type === 'usage' && chunk.usage) {
        if (typeof chunk.usage.tokensIn === 'number') realTokensIn = chunk.usage.tokensIn
        if (typeof chunk.usage.tokensOut === 'number') realTokensOut = chunk.usage.tokensOut
      }
      userCallbacks.onChunk(chunk)
    },
    onError: (error) => userCallbacks.onError(error),
    onDone: () => {
      reportUsage()
      userCallbacks.onDone()
    },
  }

  return { callbacks, reportUsage }
}

// 避免循环依赖
import { BrowserFetchTransport, AnthropicDevProxyTransport } from '@/agent/transport/transport'
