import type { Message, ToolCall } from '@/types/mescli'
import type { ModelClientRequest } from './modelClient'
import {
  normalizeMessagesForAnthropic,
  type AnthropicMessageParam,
} from '@/api/standalone/anthropicMessages'
import { safeStringify } from '@/utils/safeSerialize'

/**
 * ModelClient 统一消息规范化层
 *
 * 把 WonWork 内部 Message[] 转换为各 Provider 需要的请求体消息格式。
 * - OpenAI 兼容协议：保留 system/user/assistant/tool 角色，展开 toolCalls/toolCallId
 * - Anthropic 兼容协议：system 提到请求体顶层，消息转为 content blocks
 * - 本地模型（Ollama / LM Studio）：与 OpenAI 兼容格式一致
 *
 * 设计目标：
 * 1. 消除 OpenAI ModelClient 与 Local ModelClient 的消息构造重复。
 * 2. 把 systemPrompt / skillPrompts 注入收敛到一处。
 * 3. 提供防御性转换，降低 API 400 与对话上下文损坏概率。
 * 4. 为后续上下文压缩提供统一 hook 点。
 */

export interface OpenAICompatibleMessage {
  role: string
  content: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

/**
 * 对内部 Message[] 做防御性归一化。
 *
 * 处理项：
 * 1. 合并连续同角色消息（system/user/assistant）。
 * 2. 合并连续的 system 消息（含首尾）。
 * 3. 确保 tool_use / tool_result 配对：
 *    - 删除没有对应 tool_use 的 orphan tool_result；
 *    - 为没有对应 tool_result 的 tool_use 注入 synthetic tool_result。
 * 4. 把 toolCalls.function.arguments 统一为 JSON 字符串。
 */
export function normalizeInternalMessages(messages: Message[]): Message[] {
  const merged = mergeConsecutiveMessages(messages)
  const paired = ensureToolResultPairing(merged)
  return normalizeToolArguments(paired)
}

/**
 * 合并连续同角色消息。
 *
 * 规则：
 * - system/user/assistant 可合并（内容用换行拼接）。
 * - tool 消息不合并，因为每条 tool 对应不同 tool_call_id。
 * - assistant 合并时，toolCalls 也合并。
 */
function mergeConsecutiveMessages(messages: Message[]): Message[] {
  const result: Message[] = []

  for (const message of messages) {
    const last = result[result.length - 1]

    if (
      last &&
      last.role === message.role &&
      message.role !== 'tool' &&
      !last.toolCallId &&
      !message.toolCallId
    ) {
      last.content = `${last.content}\n\n${message.content}`.trim()
      if (message.toolCalls?.length) {
        last.toolCalls = [...(last.toolCalls || []), ...message.toolCalls]
      }
    } else {
      result.push({ ...message })
    }
  }

  return result
}

/**
 * 确保 tool_use 与 tool_result 配对。
 *
 * OpenAI/Anthropic API 都要求：assistant 消息里的每个 tool_calls
 * 必须在后续消息中有对应的 tool 结果消息。
 *
 * synthetic tool_result 必须**紧跟其 assistant 消息插入**——OpenAI 要求 tool 消息
 * 紧跟带 tool_calls 的 assistant；Anthropic 要求 tool_result 在紧随的 user 消息块内。
 * 追加到数组末尾（历史 BUG）会违反两个协议族的顺序约束，导致确定性 400。
 */
export function ensureToolResultPairing(messages: Message[]): Message[] {
  // 第一次遍历：收集已存在的 tool_use / tool_result id，并标记 orphan tool_result
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()
  const orphanToolResults = new Map<string, Message>()

  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) {
        if (tc.id) toolUseIds.add(tc.id)
      }
    }
    if (m.role === 'tool' && m.toolCallId) {
      toolResultIds.add(m.toolCallId)
      if (!toolUseIds.has(m.toolCallId)) {
        orphanToolResults.set(m.toolCallId, m)
      }
    }
  }

  // 兼容性修复：后端 SSE 回退路径曾未把 toolCalls 写回 assistant 消息，
  // 导致重载时 tool 结果变成 orphan 被删除。若 orphan tool_result 带有
  // toolCallName，则向前找到最近的 assistant 消息，补一个 synthetic tool_use。
  // 这仅影响 WonWork 前端加载历史，不改变后端 API 行为。
  if (orphanToolResults.size > 0) {
    const reconstructedMessages = messages.map((m) => ({ ...m }))
    for (let i = 0; i < reconstructedMessages.length; i++) {
      const m = reconstructedMessages[i]
      if (m.role !== 'tool' || !m.toolCallId) continue
      if (!orphanToolResults.has(m.toolCallId)) continue
      if (!m.toolCallName) continue

      // 向前找最近的 assistant 消息
      let targetAssistantIndex = -1
      for (let j = i - 1; j >= 0; j--) {
        if (reconstructedMessages[j].role === 'assistant') {
          targetAssistantIndex = j
          break
        }
      }
      if (targetAssistantIndex < 0) continue

      const assistant = reconstructedMessages[targetAssistantIndex]
      const existingIds = new Set((assistant.toolCalls || []).map((tc) => tc.id).filter(Boolean))
      if (existingIds.has(m.toolCallId)) continue

      const syntheticToolCall: ToolCall = {
        id: m.toolCallId,
        type: 'function',
        function: {
          name: m.toolCallName,
          arguments: m.structuredData ? safeStringify(m.structuredData) || '{}' : '{}',
        },
      }
      assistant.toolCalls = [...(assistant.toolCalls || []), syntheticToolCall]
      toolUseIds.add(m.toolCallId)
    }
    messages = reconstructedMessages
  }

  const missingIds = new Set<string>()
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) missingIds.add(id)
  }

  const result: Message[] = []

  for (const m of messages) {
    // 删除没有对应 tool_use 的 orphan tool_result（ reconstruction 后仍无配对的）
    if (m.role === 'tool' && m.toolCallId && !toolUseIds.has(m.toolCallId)) {
      continue
    }
    result.push(m)

    // 紧跟 assistant 消息补齐缺失的 synthetic tool_result
    if (m.role === 'assistant' && m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        if (tc.id && missingIds.has(tc.id)) {
          result.push({
            role: 'tool',
            content: '（工具执行结果缺失：未收到该 tool_call 的执行结果）',
            toolCallId: tc.id,
          })
        }
      }
    }
  }

  return result
}

/**
 * 把 toolCalls.function.arguments 统一规范化为 JSON 字符串。
 *
 * 部分 Provider 或历史数据可能把 arguments 存为对象，
 * 发送给 OpenAI/Anthropic API 前必须转为字符串。
 */
function normalizeToolArguments(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (!m.toolCalls || m.toolCalls.length === 0) return m

    const normalizedToolCalls: ToolCall[] = m.toolCalls.map((tc) => {
      const args = tc.function.arguments
      let stringified: string
      if (typeof args === 'string') {
        stringified = args
      } else {
        stringified = safeStringify(args) || '{}'
      }
      return {
        ...tc,
        function: {
          ...tc.function,
          arguments: stringified,
        },
      }
    })

    return {
      ...m,
      toolCalls: normalizedToolCalls,
    }
  })
}

/**
 * 构建 OpenAI 兼容消息列表。
 *
 * 注意：
 * - 如果 request.systemPrompt / skillPrompts 已存在，会作为独立 system 消息前置。
 * - 内部 Message[] 会先经过 normalizeInternalMessages 防御性转换。
 * - toolCalls / toolCallId 按 OpenAI Chat Completions 协议展开。
 */
export function buildOpenAICompatibleMessages(
  request: ModelClientRequest
): OpenAICompatibleMessage[] {
  const normalized = normalizeInternalMessages(request.messages)

  const systemMessages: OpenAICompatibleMessage[] = []

  if (request.systemPrompt) {
    systemMessages.push({ role: 'system', content: request.systemPrompt })
  }

  if (request.skillPrompts && request.skillPrompts.length > 0) {
    for (const prompt of request.skillPrompts) {
      systemMessages.push({ role: 'system', content: prompt })
    }
  }

  const conversationMessages = normalized.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.toolCalls && m.toolCalls.length > 0 ? { tool_calls: m.toolCalls } : {}),
    ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
  }))

  return [...systemMessages, ...conversationMessages]
}

/**
 * 构建 Anthropic Messages API 请求体所需的消息格式。
 *
 * 返回：
 * - system: 顶层 system 字段（由 systemPrompt + skillPrompts + 内部 system 消息拼接）
 * - messages: 归一化后的 Anthropic message params
 */
export function buildAnthropicMessages(
  request: ModelClientRequest
): { system: string; messages: AnthropicMessageParam[] } {
  const normalized = normalizeInternalMessages(request.messages)

  const internalSystemParts: string[] = []
  const nonSystemMessages: Message[] = []

  for (const m of normalized) {
    if (m.role === 'system') {
      internalSystemParts.push(m.content)
    } else {
      nonSystemMessages.push(m)
    }
  }

  const systemParts = [
    request.systemPrompt,
    ...(request.skillPrompts || []),
    ...internalSystemParts,
  ].filter(Boolean)

  return {
    system: systemParts.join('\n\n'),
    messages: normalizeMessagesForAnthropic(nonSystemMessages),
  }
}

/**
 * 构建本地模型请求体消息列表。
 *
 * Ollama 与 LM Studio / OpenAI 兼容本地模型均使用 OpenAI 兼容消息格式，
 * 因此直接复用 buildOpenAICompatibleMessages。
 */
export function buildLocalModelMessages(
  request: ModelClientRequest,
  _isOllama: boolean
): OpenAICompatibleMessage[] {
  return buildOpenAICompatibleMessages(request)
}
