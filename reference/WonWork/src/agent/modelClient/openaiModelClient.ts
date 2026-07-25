/**
 * OpenAI 兼容 ModelClient
 *
 * 适用于：
 * - OpenAI 官方
 * - Kimi（Moonshot）
 * - DeepSeek / 通义千问 / 智谱 / 百川 / 讯飞 / 腾讯 / 字节 / 百度等国产模型
 * - LM Studio / 自定义 OpenAI 兼容端点
 */

import type {
  Message,
  ToolDefinition,
  StreamChunk,
  ChatRequest,
} from '@/types/mescli'
import type {
  ModelClient,
  ModelClientRequest,
  ModelClientStreamCallbacks,
} from './modelClient'
import type { TransportProvider } from '@/agent/transport/transport'
import { createSSEParserState, parseSSEBuffer, flushSSEBuffer, parseSSEData } from '@/utils/sseParser'
import type { SSEEvent } from '@/utils/sseParser'
import { useUsageStore, buildTodayUsageRecord } from '@/stores/usageStore'
import { estimateTextTokens } from '@/utils/tokenEstimator'
import { buildOpenAICompatibleMessages } from './messageNormalizer'
import { createRetryableStream, type StreamAttempt } from './retryingStream'

export interface OpenAIModelClientOptions {
  providerId: string
  baseUrl: string
  defaultModel?: string
  transport?: TransportProvider
  /** 是否支持 function calling */
  supportsTools?: boolean
}

export function createOpenAIModelClient(
  providerId: string,
  baseUrl?: string,
  options?: Partial<OpenAIModelClientOptions>
): ModelClient {
  const effectiveBaseUrl = baseUrl || ''
  const defaultModel = options?.defaultModel || ''
  const supportsTools = options?.supportsTools !== false
  const transport = options?.transport || new BrowserFetchTransport()

  return {
    providerId,
    supportsTools,

    streamChat(request: ModelClientRequest, userCallbacks: ModelClientStreamCallbacks): () => void {
      const effectiveModel = request.model || defaultModel
      const effectiveApiKey = request.apiKey || ''
      const body = buildOpenAIRequestBody(request, effectiveModel)
      const url = transport.buildUrl(providerId, effectiveBaseUrl, { isAnthropic: false })

      const { callbacks, reportUsage } = createUsageTrackingCallbacks(request, userCallbacks)

      const retryable = createRetryableStream({
        retryOptions: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 8000 },
        callbacks,
        start: (streamCallbacks) =>
          executeStreaming({
            transport,
            url,
            headers: {
              'Content-Type': 'application/json',
              ...(effectiveApiKey ? { Authorization: `Bearer ${effectiveApiKey}` } : {}),
            },
            body: JSON.stringify(body),
            callbacks: streamCallbacks,
          }),
        fallback: (streamCallbacks) =>
          executeFallback({
            transport,
            url,
            headers: {
              'Content-Type': 'application/json',
              ...(effectiveApiKey ? { Authorization: `Bearer ${effectiveApiKey}` } : {}),
            },
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

function buildOpenAIRequestBody(
  request: ModelClientRequest,
  effectiveModel: string
): Record<string, unknown> {
  const messages = buildOpenAICompatibleMessages(request)

  const body: Record<string, unknown> = {
    model: effectiveModel,
    messages,
    temperature: request.temperature ?? 0.7,
    max_tokens: request.maxTokens ?? 2048,
    stream: true,
  }

  if (request.tools && request.tools.length > 0) {
    // OpenAI 协议不认识 defer_loading，需要剥离；strict 保留
    body.tools = request.tools.map((tool) => {
      const { defer_loading, ...restFunction } = tool.function as Record<string, unknown>
      return {
        type: 'function' as const,
        function: restFunction as {
          name: string
          description: string
          parameters?: unknown
          strict?: boolean
        },
      }
    })
    body.tool_choice = 'auto'
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
  const openAIToolCallAccumulator = createToolCallAccumulator()

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

      // 部分 OpenAI 兼容网关（如腾讯 TokenHub）业务错误时返回 200 + 普通 JSON 错误体（非 SSE）。
      // 若不检测，SSE 解析器读不到任何 data: 行，会静默产生"空轮次秒完成"。
      const contentType = response.headers.get('content-type') || ''
      if (!contentType.includes('text/event-stream')) {
        const text = await response.text()
        let errorMessage = text.slice(0, 500)
        try {
          const parsed = JSON.parse(text)
          errorMessage =
            (parsed.error?.message_zh || parsed.error?.message || parsed.error || parsed.message || errorMessage) as string
        } catch {
          // ignore
        }
        throw new Error(`AI 服务返回了非流式响应（可能是业务错误）: ${errorMessage}`)
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('Response body is null')

      const decoder = new TextDecoder()
      const sseState = createSSEParserState()

      const handleEvent = (event: SSEEvent): boolean => {
        if (event.event === 'chunk' || event.event === 'message' || event.event === 'tool_call') {
          const parsed = parseSSEData(event.data)
          if (parsed && typeof parsed === 'object' && 'done' in parsed) {
            callbacks.onDone()
            return true
          }
          try {
            const parsedData = parsed as Record<string, unknown>
            const chunk = parseStreamChunk(parsedData, openAIToolCallAccumulator)
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

        // 其他事件也尝试作为 JSON chunk 解析
        try {
          const parsedData = parseSSEData(event.data) as Record<string, unknown>
          const chunk = parseStreamChunk(parsedData, openAIToolCallAccumulator)
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
      const choices = data.choices as Array<Record<string, unknown>> | undefined
      const message = choices?.[0]?.message as Record<string, unknown> | undefined

      if (message?.content) {
        callbacks.onChunk({ type: 'content', content: String(message.content) })
      }

      const toolCalls = message?.tool_calls
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        callbacks.onChunk({ type: 'tool_call', toolCalls: normalizeToolCalls(toolCalls) })
      }

      const usage = data.usage as Record<string, unknown> | undefined
      if (usage) {
        callbacks.onChunk({
          type: 'usage',
          usage: {
            tokensIn: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
            tokensOut:
              typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
            totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
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

function createUsageTrackingCallbacks(
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

function parseStreamChunk(
  parsedData: Record<string, unknown>,
  accumulator: ReturnType<typeof createToolCallAccumulator>
): StreamChunk | null {
  const choices = parsedData.choices as Array<Record<string, unknown>> | undefined
  const delta = choices?.[0]?.delta as Record<string, unknown> | undefined

  // OpenAI 流式最后一个 chunk 可能携带真实 usage
  const usage = parsedData.usage as Record<string, unknown> | undefined
  if (usage) {
    return {
      type: 'usage',
      usage: {
        tokensIn: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
        tokensOut:
          typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
        totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
      },
    }
  }

  // DeepSeek-R1 / 部分 OpenAI 兼容接口会在 reasoning_content 中返回思考内容
  if (delta?.reasoning_content) {
    return { type: 'reasoning', reasoning: String(delta.reasoning_content) }
  }

  if (delta?.content) {
    return { type: 'content', content: String(delta.content) }
  }

  if (delta?.tool_calls) {
    return accumulator.processDelta(delta)
  }

  if (choices?.[0]?.finish_reason) {
    const finishReason = String(choices[0].finish_reason)
    return { type: 'done', stopReason: finishReason }
  }

  return null
}

/**
 * 工具调用流式累积器。
 *
 * OpenAI 兼容流式接口中，一个 tool_call 会分成多个 chunk 到达：
 * - 第一个 chunk 通常包含 id 和 function.name
 * - 后续 chunk 通过 index 关联，只补充 function.arguments
 */
function createToolCallAccumulator() {
  const callsByIndex = new Map<number, { id: string; name: string; args: string }>()

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

function normalizeToolCalls(raw: unknown[]): StreamChunk['toolCalls'] {
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

// 避免循环依赖：BrowserFetchTransport 定义在 transport.ts
import { BrowserFetchTransport } from '@/agent/transport/transport'
