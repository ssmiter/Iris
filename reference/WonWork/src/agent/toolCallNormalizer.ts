/**
 * 统一的 ToolCall 归一化器
 *
 * 职责：把 OpenAI / Anthropic / 本地模型等不同 Provider 的 tool_call 流式输出
 * 归一化为内部稳定的 ToolCall 状态，解决以下问题：
 * - 同一 tool_call 分多次 delta 到达，需要累积 arguments
 * - 不同 Provider 的 id 格式不一致（OpenAI 用 index、Anthropic 用 tool_use_id）
 * - 部分 Provider 发送的是累积值而非增量
 * - 参数解析失败时给出明确错误，而不是静默回退为 {}
 *
 * 设计原则：
 * - 不感知 UI、不感知网络、不感知具体工具语义
 * - 只负责把"不稳定的流式 tool_call 事件"变成"稳定的 tool_call 列表"
 * - 输出与 WonWork 内部 ToolCall 类型一致，可直接进入 toolExecutor
 */

import type { ToolCall } from '@/types/mescli'

export interface NormalizedToolCall extends ToolCall {
  /** 是否已经收到过任何参数片段 */
  hasReceivedArgs: boolean
  /** 最后一次更新时间戳 */
  updatedAt: number
}

export interface ToolCallNormalizerState {
  /** 按真实 tool_call id 累积的调用 */
  calls: Map<string, NormalizedToolCall>
  /**
   * Anthropic 专用：content block index -> tool_use_id 映射。
   * Anthropic 的 content_block_delta 只带 index，需要通过 start 事件建立映射。
   */
  anthropicIndexToId: Map<number, string>
  /**
   * OpenAI 兼容专用：chunk index -> tool_call id 映射。
   * OpenAI 的 delta 用 index，第一个 chunk 通常带 id。
   */
  openaiIndexToId: Map<number, string>
}

export function createToolCallNormalizerState(): ToolCallNormalizerState {
  return {
    calls: new Map(),
    anthropicIndexToId: new Map(),
    openaiIndexToId: new Map(),
  }
}

function now(): number {
  return Date.now()
}

function generateFallbackId(): string {
  return `tc-${now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 合并 arguments 增量。
 *
 * 不同 Provider 行为不一致：
 * - OpenAI 规范：每个 delta 是片段，需要拼接
 * - 部分国产模型 / Moonshot / Kimi Code：每个 delta 是截至当前的全部参数（累积）
 * - Anthropic 规范：partial_json 是增量
 *
 * 这里使用稳定策略：
 * 1. 如果 newArgs 以 existing 开头 → newArgs 是累积值，取 newArgs
 * 2. 如果 existing 以 newArgs 开头 → newArgs 是重复前缀，保留 existing
 * 3. 否则尝试拼接，并清理重复前缀
 */
export function mergeToolArguments(existing: string, delta: string): string {
  if (!existing) return delta
  if (!delta) return existing
  if (delta.startsWith(existing)) return delta
  if (existing.startsWith(delta)) return existing

  // Anthropic/Kimi Code 等可能把 partial_json 以"完整累积 JSON"形式发送，
  // 而不是增量片段。此时应直接取新的完整 JSON，避免与 existing（如 `{}`）
  // 按字符重叠拼接成 `{}{"path":...}`。
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

  // 尝试找 existing 后缀与 delta 前缀的最长重叠
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

/**
 * 从可能重复/嵌套/残缺的参数串中抢救出最长合法 JSON 对象/数组。
 */
export function extractBestJson(text: string): string | undefined {
  if (!text) return undefined
  let best: string | undefined
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{' && text[i] !== '[') continue
    const open = text[i]
    const close = open === '{' ? '}' : ']'
    let depth = 1
    let j = i + 1
    for (; j < text.length; j++) {
      if (text[j] === open) depth++
      else if (text[j] === close) {
        depth--
        if (depth === 0) break
      }
    }
    if (depth !== 0) continue
    const candidate = text.slice(i, j + 1)
    try {
      JSON.parse(candidate)
      if (!best || candidate.length > best.length) {
        best = candidate
      }
    } catch {
      // ignore
    }
  }
  return best
}

/**
 * 解析并校验 arguments 字符串。
 * 失败时返回错误信息，不静默回退为 {}。
 */
export function parseToolArguments(
  raw: string | undefined,
  inputSchema?: unknown
): {
  args: Record<string, unknown>
  parseError?: string
  rawUsed: string
} {
  if (!raw || raw.trim() === '') {
    const schemaObj =
      inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)
        ? (inputSchema as Record<string, unknown>)
        : undefined
    const required = Array.isArray(schemaObj?.required) ? (schemaObj.required as unknown[]) : []
    if (required.length > 0) {
      return {
        args: {},
        parseError: `缺少必填参数: ${required.join(', ')}。模型未提供任何参数。`,
        rawUsed: raw || '',
      }
    }
    return { args: {}, rawUsed: raw || '' }
  }

  // 1. 直接解析
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown>, rawUsed: raw }
    }
    return {
      args: {},
      parseError: `工具参数必须是 JSON 对象，但收到 ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
      rawUsed: raw,
    }
  } catch (directErr) {
    // 2. 尝试抢救最长合法 JSON
    const salvaged = extractBestJson(raw)
    if (salvaged && salvaged !== raw) {
      try {
        const parsed = JSON.parse(salvaged)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { args: parsed as Record<string, unknown>, rawUsed: salvaged }
        }
      } catch {
        // fall through
      }
    }

    // 3. 返回明确错误
    const errMsg = directErr instanceof Error ? directErr.message : String(directErr)
    return {
      args: {},
      parseError: `参数解析失败: ${errMsg}。原始参数: ${raw.slice(0, 500)}`,
      rawUsed: raw,
    }
  }
}

/**
 * 处理 OpenAI 兼容风格的 tool_call delta。
 */
export function feedOpenAIToolCallDelta(
  state: ToolCallNormalizerState,
  deltas: Array<{
    index?: number
    id?: string
    type?: string
    function?: {
      name?: string
      arguments?: string
    }
  }>
): ToolCall[] {
  const updatedIds = new Set<string>()

  for (const delta of deltas) {
    const index = typeof delta.index === 'number' ? delta.index : 0
    const existing = state.calls.get(state.openaiIndexToId.get(index) || '')

    let id = delta.id || existing?.id
    if (!id) {
      id = generateFallbackId()
    }
    state.openaiIndexToId.set(index, id)

    const name = delta.function?.name || existing?.function.name || ''
    const argsDelta = delta.function?.arguments || ''
    const accumulatedArgs = mergeToolArguments(existing?.function.arguments || '', argsDelta)

    const normalized: NormalizedToolCall = {
      id,
      type: 'function',
      function: {
        name,
        arguments: accumulatedArgs,
      },
      hasReceivedArgs: existing?.hasReceivedArgs || argsDelta.length > 0,
      updatedAt: now(),
    }

    state.calls.set(id, normalized)
    updatedIds.add(id)
  }

  return Array.from(updatedIds)
    .map((id) => state.calls.get(id))
    .filter(Boolean)
    .sort((a, b) => a!.updatedAt - b!.updatedAt)
    .map((call) => ({
      id: call!.id,
      type: call!.type,
      function: call!.function,
    }))
}

/**
 * 处理 Anthropic 风格的 tool_use 事件。
 */
export function feedAnthropicToolUseEvent(
  state: ToolCallNormalizerState,
  event: {
    type: 'start' | 'delta'
    index?: number
    id?: string
    name?: string
    partialJson?: string
    initialInput?: Record<string, unknown> | string
  }
): ToolCall[] {
  const index = typeof event.index === 'number' ? event.index : 0

  if (event.type === 'start') {
    const id = event.id || generateFallbackId()
    state.anthropicIndexToId.set(index, id)

    let initialArgs = ''
    if (typeof event.initialInput === 'string') {
      initialArgs = event.initialInput
    } else if (event.initialInput && typeof event.initialInput === 'object') {
      initialArgs = JSON.stringify(event.initialInput)
    }

    const normalized: NormalizedToolCall = {
      id,
      type: 'function',
      function: {
        name: event.name || '',
        arguments: initialArgs,
      },
      hasReceivedArgs: initialArgs.length > 0,
      updatedAt: now(),
    }

    state.calls.set(id, normalized)
    return [{ id, type: 'function', function: normalized.function }]
  }

  // delta
  const id = state.anthropicIndexToId.get(index)
  if (!id) {
    const fallbackId = `anthropic-index-${index}`
    state.anthropicIndexToId.set(index, fallbackId)
    state.calls.set(fallbackId, {
      id: fallbackId,
      type: 'function',
      function: { name: '', arguments: event.partialJson || '' },
      hasReceivedArgs: Boolean(event.partialJson),
      updatedAt: now(),
    })
    return [
      {
        id: fallbackId,
        type: 'function',
        function: { name: '', arguments: event.partialJson || '' },
      },
    ]
  }

  const existing = state.calls.get(id)
  const partialJson = event.partialJson || ''

  let accumulatedArgs = existing?.function.arguments || ''
  if (partialJson) {
    const maybeFullJson = extractBestJson(partialJson)
    if (
      maybeFullJson &&
      maybeFullJson.length >= accumulatedArgs.length &&
      maybeFullJson.startsWith(accumulatedArgs.trim())
    ) {
      accumulatedArgs = maybeFullJson
    } else {
      accumulatedArgs = mergeToolArguments(accumulatedArgs, partialJson)
    }
  }

  const normalized: NormalizedToolCall = {
    id,
    type: 'function',
    function: {
      name: existing?.function.name || '',
      arguments: accumulatedArgs,
    },
    hasReceivedArgs: existing?.hasReceivedArgs || partialJson.length > 0,
    updatedAt: now(),
  }

  state.calls.set(id, normalized)
  return [{ id, type: 'function', function: normalized.function }]
}

/**
 * 处理一次性到达的完整 tool_calls（如 Ollama / 本地模型 / 某些后端）。
 */
export function feedCompleteToolCalls(
  state: ToolCallNormalizerState,
  calls: Array<{
    id?: string
    type?: string
    function?: {
      name?: string
      arguments?: string | Record<string, unknown>
    }
  }>
): ToolCall[] {
  const result: ToolCall[] = []
  for (const call of calls) {
    const id = call.id || generateFallbackId()
    let args = ''
    if (typeof call.function?.arguments === 'string') {
      args = call.function.arguments
    } else if (call.function?.arguments && typeof call.function.arguments === 'object') {
      args = JSON.stringify(call.function.arguments)
    }

    state.calls.set(id, {
      id,
      type: 'function',
      function: {
        name: call.function?.name || '',
        arguments: args,
      },
      hasReceivedArgs: args.length > 0,
      updatedAt: now(),
    })

    result.push({
      id,
      type: 'function',
      function: { name: call.function?.name || '', arguments: args },
    })
  }
  return result
}

/**
 * 获取当前已归一化的所有 tool_calls（按更新时间排序）。
 */
export function getNormalizedToolCalls(state: ToolCallNormalizerState): ToolCall[] {
  return Array.from(state.calls.values())
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .map((call) => ({
      id: call.id,
      type: call.type,
      function: call.function,
    }))
}

/**
 * 清理状态。通常在一轮模型调用结束时调用。
 */
export function resetToolCallNormalizer(state: ToolCallNormalizerState): void {
  state.calls.clear()
  state.anthropicIndexToId.clear()
  state.openaiIndexToId.clear()
}
