import type { StreamChunk } from '@/types/mescli'

/**
 * Anthropic Messages API 流式事件解析层
 *
 * 职责：把 Anthropic SSE 中的单个 JSON 事件解析为 WonWork 内部统一的 StreamChunk。
 * 包含 tool_use 输入的 partial_json 累积器，调用方无需关心 Provider 差异。
 *
 * Anthropic 流事件 taxonomy（参考 claude-code/src/services/api/claude.ts）：
 * - message_start
 * - content_block_start   (text | tool_use | thinking | redacted_thinking)
 * - content_block_delta   (text_delta | input_json_delta | thinking_delta | signature_delta)
 * - content_block_stop
 * - message_delta
 * - message_stop
 *
 * 当前最小化支持：text、tool_use、thinking。后续可按相同模式扩展 redacted_thinking 等。
 */

export interface AnthropicStreamParserState {
  /** 按 tool_use_id 累积 partial_json */
  toolInputs: Map<string, string>
  /**
   * content_block index -> tool_use_id 映射。
   * Anthropic 的 content_block_delta 只带 index，需要通过 start 事件建立映射，
   * 否则 delta 会用 `tool-${index}` 临时 id，无法与 start 产生的真实 tool_use_id 合并。
   */
  indexToId: Map<number, string>
}

export function createAnthropicStreamParserState(): AnthropicStreamParserState {
  return { toolInputs: new Map(), indexToId: new Map() }
}

export function parseAnthropicStreamEvent(
  event: Record<string, unknown>,
  state: AnthropicStreamParserState
): StreamChunk | null {
  const type = event.type

  switch (type) {
    case 'message_start':
    case 'message_delta': {
      // 提取真实 token 用量
      const usage = extractUsage(event)
      if (usage) {
        const { stopReason, ...rest } = usage
        return { type: 'usage', usage: rest, stopReason }
      }
      return null
    }

    case 'content_block_start': {
      const block = event.content_block as Record<string, unknown> | undefined
      if (!block) return null

      if (block.type === 'text') {
        const text = block.text
        if (typeof text === 'string' && text.length > 0) {
          return { type: 'content', content: text }
        }
        return null
      }

      if (block.type === 'tool_use') {
        const index = Number(event.index ?? 0)
        const id = String(block.id || '') || `tool-${index}`
        const name = String(block.name || '')
        // tool_use 的初始 input 可能为空对象或已有部分字段。
        const input =
          typeof block.input === 'object' && block.input !== null
            ? JSON.stringify(block.input)
            : ''
        state.toolInputs.set(id, input)
        state.indexToId.set(index, id)
        return {
          type: 'tool_call',
          toolCalls: [
            {
              id,
              type: 'function',
              function: { name, arguments: input },
            },
          ],
        }
      }

      if (block.type === 'thinking') {
        const thinking = block.thinking
        if (typeof thinking === 'string' && thinking.length > 0) {
          return { type: 'reasoning', content: thinking }
        }
        return null
      }

      return null
    }

    case 'content_block_delta': {
      const delta = event.delta as Record<string, unknown> | undefined
      if (!delta) return null

      if (typeof delta.text === 'string') {
        return { type: 'content', content: delta.text }
      }

      if (typeof delta.thinking === 'string') {
        return { type: 'reasoning', content: delta.thinking }
      }

      if (typeof delta.partial_json === 'string') {
        const index = Number(event.index ?? 0)
        const id = state.indexToId.get(index) || `tool-${index}`
        return accumulateToolInput(id, delta.partial_json, state)
      }

      return null
    }

    case 'message_stop': {
      return { type: 'done' }
    }

    default: {
      return null
    }
  }
}

/**
 * 从 Anthropic message_start / message_delta 事件中提取 token 用量。
 */
function extractUsage(event: Record<string, unknown>): {
  tokensIn?: number
  tokensOut?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  stopReason?: string
} | null {
  const usage = event.usage as Record<string, unknown> | undefined
  const delta = event.delta as Record<string, unknown> | undefined
  const stopReason = delta?.stop_reason ? String(delta.stop_reason) : undefined

  if (!usage) {
    // message_start 的 usage 嵌在 message 字段下
    const message = event.message as Record<string, unknown> | undefined
    const nestedUsage = message?.usage as Record<string, unknown> | undefined
    if (!nestedUsage) return null
    return {
      tokensIn: typeof nestedUsage.input_tokens === 'number' ? nestedUsage.input_tokens : undefined,
      tokensOut: typeof nestedUsage.output_tokens === 'number' ? nestedUsage.output_tokens : undefined,
      cacheReadTokens:
        typeof nestedUsage.cache_read_input_tokens === 'number'
          ? nestedUsage.cache_read_input_tokens
          : undefined,
      cacheCreationTokens:
        typeof nestedUsage.cache_creation_input_tokens === 'number'
          ? nestedUsage.cache_creation_input_tokens
          : undefined,
      stopReason,
    }
  }

  return {
    tokensIn: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
    tokensOut: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
    cacheReadTokens:
      typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined,
    cacheCreationTokens:
      typeof usage.cache_creation_input_tokens === 'number'
        ? usage.cache_creation_input_tokens
        : undefined,
    stopReason,
  }
}

/**
 * 累积 tool_use 的 partial_json。
 *
 * Anthropic 通过 input_json_delta.partial_json 分片发送工具参数。
 * 这里按真实 tool_use_id 累积；由上层 agenticLoop 的 pendingToolCalls 做去重/合并。
 *
 * 为了输出稳定的 tool_call chunk，这里返回包含完整累积 arguments 的 chunk。
 */
function accumulateToolInput(
  id: string,
  partialJson: string,
  state: AnthropicStreamParserState
): StreamChunk | null {
  const existing = state.toolInputs.get(id) || ''
  const merged = mergePartialJson(existing, partialJson)
  state.toolInputs.set(id, merged)

  return {
    type: 'tool_call',
    toolCalls: [
      {
        id,
        type: 'function',
        function: { name: '', arguments: merged },
      },
    ],
  }
}

/**
 * 合并 partial_json 片段。
 *
 * Anthropic 的 partial_json 规范是标准增量：每个 delta 追加到当前 JSON 字符串末尾。
 * 但部分兼容 Provider（如 Kimi Code）可能发送累积值或完整 JSON。
 *
 * 策略：
 * 1. 如果 new 以 existing 开头 → new 是累积值，直接取 new
 * 2. 如果 existing 以 new 开头 → new 是重复前缀，保留 existing
 * 3. 否则尝试找重叠边界后拼接
 * 4. 如果 new 本身已是完整合法 JSON 且比 existing 长，优先取 new（兼容一次性发送完整参数）
 */
function mergePartialJson(existing: string, delta: string): string {
  if (!existing) return delta
  if (!delta) return existing
  if (delta.startsWith(existing)) return delta
  if (existing.startsWith(delta)) return existing

  // 兼容 Kimi Code：如果 delta 是完整合法 JSON 且比现有累积长，说明是累积值/完整值
  const deltaTrimmed = delta.trim()
  if (
    deltaTrimmed.length > existing.length &&
    (deltaTrimmed.startsWith('{') || deltaTrimmed.startsWith('['))
  ) {
    try {
      JSON.parse(deltaTrimmed)
      return deltaTrimmed
    } catch {
      // 不是完整 JSON，继续走增量拼接
    }
  }

  // 尝试找最长公共后缀/前缀，避免重复拼接
  let overlap = 0
  const minLen = Math.min(existing.length, delta.length)
  for (let i = 1; i <= minLen; i++) {
    if (existing.slice(existing.length - i) === delta.slice(0, i)) {
      overlap = i
    }
  }
  if (overlap > 0) {
    return existing + delta.slice(overlap)
  }

  return existing + delta
}
