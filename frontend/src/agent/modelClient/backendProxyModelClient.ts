import type { ModelClient, ModelClientRequest, ModelClientStreamCallbacks } from './modelClient'
import type { ChatRequest, StreamChunk } from '@/types/mescli'
import { API_BASE, getAuthHeaders } from '@/api/client'
import { ensureToolResultPairing } from './messageNormalizer'
import { createRetryableStream, type StreamAttempt } from './retryingStream'
import {
  createSSEParserState,
  parseSSEBuffer,
  flushSSEBuffer,
  parseSSEData,
} from '@/utils/sseParser'
import type { SSEEvent } from '@/utils/sseParser'
import { createUsageTrackingCallbacks } from './usageTracking'
import { isProfileProviderId, profileIdFromProviderId } from '@/types/providerProfile'
import { useProviderProfileStore } from '@/stores/providerProfileStore'
import { normalizeToolCalls } from '@/utils/normalizeToolCalls'

/**
 * 供应商预设库（2026-09-07）：profile:<id> 只活在前端。后端 ProviderFactory
 * 不认识该命名空间，发往 /api/chat/proxy 前翻译成它认识的 id——
 * anthropic 格式 → 'anthropic'，openai 格式 → 'custom'（两者的 model/baseUrl/apiKey
 * 本就全部由请求携带，ProviderFactory 对 custom 的注释明示这一点）。
 */
export function resolveProxyProviderId(providerId: string): string {
  if (!isProfileProviderId(providerId)) return providerId
  const profileId = profileIdFromProviderId(providerId)
  const profile = useProviderProfileStore.getState().profiles.find((p) => p.id === profileId)
  return profile?.meta.apiFormat === 'anthropic' ? 'anthropic' : 'custom'
}

/**
 * 后端代理 ModelClient（MESCLI-Online 前端循环 / MESCLI-Local Anthropic 兼容 Provider）。
 *
 * 当后端能力清单开启 `frontend_loop_online` 时，MESCLI-Online 不再走后端
 * `/api/chat/stream-sse`（后端驱动工具执行），而是走 `/api/chat/proxy`：
 * - 后端仅作为 LLM 流代理，不执行工具；
 * - 前端 Agentic 循环本地执行工具并将结果回灌结果，与 Standalone/MESCLI-Local 一致。
 *
 * 此外，MESCLI-Local 的 Anthropic 兼容 Provider（Kimi Code / Claude）在浏览器生产包中
 * 直接跨域会被 CORS 拦截，也通过此后端代理转发。
 */

export const BACKEND_PROXY_PROVIDER_ID = 'backend-proxy'

function buildChatRequest(request: ModelClientRequest): ChatRequest {
  return {
    provider: resolveProxyProviderId(request.provider),
    model: request.model,
    apiKey: request.apiKey,
    baseUrl: request.baseUrl,
    conversationId: request.conversationId,
    // 代理链路原本原样透传 messages，旁路了前端归一化层；
    // 后端 Provider（Anthropic/OpenAICompatible）均无 tool_use/tool_result 配对修复，
    // 历史中的 dangling toolCalls 会导致每次请求确定性 400。发送前在此补齐。
    messages: ensureToolResultPairing(request.messages),
    tools: request.tools,
    executionMode: request.executionMode,
    // 前端代理模式下，systemPrompt 需要显式透传；后端 ChatProxyService 会把它 prepend 成 system 消息。
    // 不传递的话，pipeline 等依赖自定义系统提示词的场景会丢失关键指令（如 JSON 输出格式）。
    systemPrompt: request.systemPrompt,
    // 透传 maxTokens：此前 ChatRequest 没有该字段，前端值被静默丢弃，
    // 后端 KimiCodeProvider 固定 16384，长 thinking 场景下最终回答被截断。
    maxTokens: request.maxTokens,
    // 思考强度档位透传（2026-09-04，maxTokens 同款先例）
    effort: request.effort,
    // 内部 pipeline（如 compactSummaryPipeline）不应写入历史记录
    saveToHistory: request.saveToHistory ?? false,
  }
}

function getFriendlyErrorMessage(response: Response, text: string): string {
  let message = text
  try {
    const parsed = JSON.parse(text) as { error?: string; message?: string }
    message = parsed.error || parsed.message || text
  } catch {
    // 保留原始文本
  }
  return message || `对话代理失败: ${response.status}`
}

export function createBackendProxyModelClient(): ModelClient {
  return {
    providerId: BACKEND_PROXY_PROVIDER_ID,
    supportsTools: true,

    streamChat(request: ModelClientRequest, userCallbacks: ModelClientStreamCallbacks): () => void {
      const url = `${API_BASE}/api/chat/proxy`
      const chatRequest = buildChatRequest(request)

      // 与 anthropicModelClient/openaiModelClient 对齐的用量上报：
      // 代理路径此前完全不上报 usage，设置页与上下文水位统计恒为 0。
      const { callbacks } = createUsageTrackingCallbacks(request, userCallbacks)

      // 接入 retryingStream（2026-08-31 打断治理）：四个 client 此前唯独本通道裸
      // reader.read()——无 idle 看守、无重试，后端代理流悬挂时前端只能干等
      // （"打断后过几分钟才恢复"的另一半根因）。现在 90s 无 chunk 主动中断当前尝试：
      // 未发出任何 chunk → 按策略重试；已发出 → 上抛 StreamIdleError 由 loop 呈现，
      // 不重复内容（idle 阈值与 claude-code STREAM_IDLE_TIMEOUT_MS 同值 90s）。
      // 无非流式兜底：/api/chat/proxy 语义即 SSE 流代理，重试已覆盖挂起场景。
      const retryable = createRetryableStream({
        retryOptions: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 8000 },
        callbacks,
        start: (streamCallbacks) =>
          executeProxyStream({ url, chatRequest, callbacks: streamCallbacks }),
      })

      return retryable.abort
    },
  }
}

function executeProxyStream(options: {
  url: string
  chatRequest: ChatRequest
  callbacks: ModelClientStreamCallbacks
}): StreamAttempt {
  const { url, chatRequest, callbacks } = options
  const abortController = new AbortController()
  let aborted = false
  // 是否收到过任何实质内容（content/reasoning/tool_call）。
  // 用于"空流"检测：后端在 Key 缺失/上游异常时会只发 error chunk + [DONE]，
  // 若 error 再被吞掉，用户看到的就是"秒回已完成、没有任何回答"（2026-07-24 根因）。
  let receivedAnyPayload = false
  const openAIToolCallAccumulator = createProxyToolCallAccumulator()

  const abort = (): void => {
    aborted = true
    abortController.abort()
  }

  const handleEvent = (event: SSEEvent): boolean => {
        if (event.event === 'error') {
          const parsed = parseSSEData(event.data)
          const msg =
            parsed && typeof parsed === 'object'
              ? (parsed as { content?: string; message?: string }).content ||
                (parsed as { content?: string; message?: string }).message ||
                String(parsed)
              : String(event.data)
          callbacks.onError(new Error(msg))
          return true
        }

        const data = String(event.data).trim()
        if (data === '[DONE]' || event.event === 'done') {
          if (!aborted) {
            if (!receivedAnyPayload) {
              // 空流兜底：正常模型一定会产出至少一个 content/reasoning/tool_call chunk。
              // 一个都没有 = 上游出了问题但错误没传达到（例如旧后端版本不发 error chunk），
              // 必须显式报错，绝不能静默 onDone 伪装成"已完成"。
              callbacks.onError(
                new Error('模型未返回任何内容。可能是 API Key 未配置/已过期、模型名不正确，或后端代理异常——请检查设置页对应 Provider 的配置')
              )
            } else {
              callbacks.onDone()
            }
          }
          return true
        }

        // 代理流中所有非控制事件都尝试解析为 StreamChunk
        try {
          const parsed = parseSSEData(data) as Record<string, unknown> | null
          const chunk = parsed as unknown as StreamChunk
          if (chunk && typeof chunk === 'object' && 'type' in chunk) {
            // 关键修复：后端把业务错误（未配置 Key / 401 / 429 / 500）编码为
            // data:{"type":"error","content":"..."}（SSE 默认事件名，不是 event:error），
            // 此前会落进 onChunk，而 agenticLoop 的 switch 没有 'error' 分支 → 静默丢弃，
            // 随后 [DONE] 触发 onDone，表现为"问完直接已完成、无回答无报错"。
            if (chunk.type === 'error') {
              const msg =
                (chunk as { content?: string }).content ||
                (chunk as { message?: string }).message ||
                '后端代理返回了未知错误'
              callbacks.onError(new Error(msg))
              return true
            }
            if (
              chunk.type === 'content' ||
              chunk.type === 'reasoning' ||
              chunk.type === 'tool_call'
            ) {
              receivedAnyPayload = true
            }
            callbacks.onChunk(chunk)
          } else if (parsed && typeof parsed === 'object') {
            // /api/chat/proxy 对 OpenAI-compatible upstream 保持透明，
            // 因此前端在边界处将原始 choices.delta 归一为统一 StreamChunk。
            const normalized = parseOpenAiProxyChunk(parsed, openAIToolCallAccumulator)
            if (normalized) {
              if (normalized.type === 'error') {
                callbacks.onError(new Error(normalized.content || '模型代理返回错误'))
                return true
              }
              if (normalized.type === 'content' || normalized.type === 'reasoning' || normalized.type === 'tool_call') {
                receivedAnyPayload = true
              }
              callbacks.onChunk(normalized)
            }
          }
        } catch {
          // 忽略无法解析的片段
        }
        return false
      }

  const finished = (async () => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
        body: JSON.stringify(chatRequest),
        signal: abortController.signal,
        credentials: 'include',
      })

      if (!response.ok) {
        const text = await response.text()
        // HTTP 层失败上抛给重试层：5xx/429 按策略退避重试，4xx 不重试，
        // 最终 onError 文案与原实现一致（getFriendlyErrorMessage）
        throw new Error(getFriendlyErrorMessage(response, text))
      }

      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('Response body is null')
      }

      const decoder = new TextDecoder()
      const sseState = createSSEParserState()

      while (!aborted) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        const events = parseSSEBuffer(sseState, text)
        for (const event of events) {
          if (handleEvent(event)) return
        }
      }

      const remaining = flushSSEBuffer(sseState)
      for (const event of remaining) {
        if (handleEvent(event)) return
      }

      // 上游正常关闭但没有显式 [DONE]：同样套用空流兜底
      if (!aborted) {
        if (!receivedAnyPayload) {
          callbacks.onError(
            new Error('模型未返回任何内容。可能是 API Key 未配置/已过期、模型名不正确，或后端代理异常——请检查设置页对应 Provider 的配置')
          )
        } else {
          callbacks.onDone()
        }
      }
    } catch (err) {
      // 中断（用户停止 / idle 看守）与传输异常一律上抛：retryingStream 区分处置——
      // 外层 aborted（用户停止）静默；idle 超时转 StreamIdleError 按策略重试；
      // 不可重试错误经 run() 尾部 onError 呈现，文案与原实现一致。
      throw err
    }
  })()

  return { abort, finished }
}

/** 将透明代理返回的 OpenAI SSE data chunk 归一为前端统一流事件。 */
function parseOpenAiProxyChunk(
  data: Record<string, unknown>,
  accumulator: ReturnType<typeof createProxyToolCallAccumulator>
): StreamChunk | null {
  if (data.error) {
    const error = data.error as Record<string, unknown>
    return { type: 'error', content: String(error.message ?? data.error) }
  }
  const usage = data.usage as Record<string, unknown> | undefined
  if (usage) {
    return {
      type: 'usage',
      usage: {
        tokensIn: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
        tokensOut: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
        totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
        cacheReadTokens: typeof usage.prompt_cache_hit_tokens === 'number' ? usage.prompt_cache_hit_tokens : undefined,
      },
    }
  }
  const choices = data.choices as Array<Record<string, unknown>> | undefined
  const choice = choices?.[0]
  const delta = choice?.delta as Record<string, unknown> | undefined
  if (delta?.reasoning_content) return { type: 'reasoning', reasoning: String(delta.reasoning_content) }
  if (delta?.content) return { type: 'content', content: String(delta.content) }
  if (Array.isArray(delta?.tool_calls)) return accumulator.processDelta(delta)
  if (choice?.finish_reason) return { type: 'done', stopReason: String(choice.finish_reason) }
  return null
}

function createProxyToolCallAccumulator() {
  const calls = new Map<number, { id: string; name: string; args: string }>()
  const merge = (left: string, right: string) => {
    if (!left) return right
    if (!right || left.endsWith(right)) return left
    if (right.startsWith(left)) return right
    return left + right
  }
  return {
    processDelta(delta: Record<string, unknown>): StreamChunk | null {
      const deltas = delta.tool_calls as Array<Record<string, unknown>> | undefined
      if (!deltas?.length) return null
      for (const item of deltas) {
        const index = Number(item.index ?? 0)
        const existing = calls.get(index)
        const fn = item.function as Record<string, unknown> | undefined
        calls.set(index, {
          id: item.id ? String(item.id) : existing?.id || `tc-${Date.now()}-${index}`,
          name: fn?.name ? String(fn.name) : existing?.name || '',
          args: merge(existing?.args || '', typeof fn?.arguments === 'string' ? fn.arguments : ''),
        })
      }
      return {
        type: 'tool_call',
        toolCalls: normalizeToolCalls(Array.from(calls.entries()).sort((a, b) => a[0] - b[0]).map(([, call]) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.args },
        }))),
      }
    },
  }
}
