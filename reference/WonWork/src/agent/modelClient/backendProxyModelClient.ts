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

import type { ModelClient, ModelClientRequest, ModelClientStreamCallbacks } from './modelClient'
import type { ChatRequest, StreamChunk } from '@/types/mescli'
import { API_BASE, getAuthHeaders } from '@/api/client'
import { ensureToolResultPairing } from './messageNormalizer'
import {
  createSSEParserState,
  parseSSEBuffer,
  flushSSEBuffer,
  parseSSEData,
} from '@/utils/sseParser'
import type { SSEEvent } from '@/utils/sseParser'
import { createUsageTrackingCallbacks } from './anthropicModelClient'

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
    provider: request.provider,
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
      const abortController = new AbortController()
      let aborted = false
      // 是否收到过任何实质内容（content/reasoning/tool_call）。
      // 用于"空流"检测：后端在 Key 缺失/上游异常时会只发 error chunk + [DONE]，
      // 若 error 再被吞掉，用户看到的就是"秒回已完成、没有任何回答"（2026-07-24 根因）。
      let receivedAnyPayload = false

      // 与 anthropicModelClient/openaiModelClient 对齐的用量上报：
      // 代理路径此前完全不上报 usage，设置页与上下文水位统计恒为 0。
      const { callbacks } = createUsageTrackingCallbacks(request, userCallbacks)

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
          const chunk = parseSSEData(data) as StreamChunk
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
          }
        } catch {
          // 忽略无法解析的片段
        }
        return false
      }

      ;(async () => {
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
          if (!aborted && (err as Error).name !== 'AbortError') {
            callbacks.onError(err instanceof Error ? err : new Error(String(err)))
          }
        }
      })()

      return abort
    },
  }
}
