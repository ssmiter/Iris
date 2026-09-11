import type { Message, ToolDefinition } from '@/types/mescli'

/**
 * Anthropic Messages API 协议层
 *
 * 职责：把 WonWork 内部统一的 OpenAI 风格请求（Message[] / ToolDefinition[]）
 * 转换为 Anthropic Messages API 请求体。不处理 SSE 解析，不感知 Standalone/MESCLI 模式。
 *
 * 参考实现：claude-code/src/services/api/claude.ts、src/utils/api.ts、src/utils/messages.ts
 */

/**
 * Anthropic tool schema：与 OpenAI 的 parameters 同构，仅字段名不同。
 */
export interface AnthropicTool {
  name: string
  description: string
  input_schema: unknown
  /** Anthropic defer_loading beta flag */
  defer_loading?: boolean
  /** OpenAI/Anthropic structured-output strict mode */
  strict?: boolean
}

/**
 * Anthropic content block 基础类型。
 */
export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'thinking'; thinking: string }

/**
 * Anthropic message 参数。
 */
export interface AnthropicMessageParam {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

/**
 * Anthropic tool_choice 参数。
 */
export type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string }

/**
 * 剥离 baseUrl 末尾多余斜杠与 /v1，再拼接 Anthropic 固定的 /v1/messages。
 * Anthropic SDK 行为：以 baseUrl 为根追加 /v1/messages。
 */
export function buildAnthropicMessagesUrl(baseUrl: string): string {
  let normalized = baseUrl.replace(/\/+$/, '')
  if (normalized.endsWith('/v1')) {
    normalized = normalized.slice(0, -3)
  }
  return `${normalized}/v1/messages`
}

/**
 * 把 OpenAI 风格的 ToolDefinition 转为 Anthropic tool schema。
 * Anthropic 的 input_schema 与 OpenAI 的 parameters 在 JSON Schema 层面等价，但要求：
 * - 必须是合法 JSON Schema
 * - 必须包含 type: 'object'
 * - 最好包含 properties 和 required
 *
 * 本函数会校验并修复常见缺失，避免模型收到空 schema 后生成空参数。
 */
export function openaiToolToAnthropic(tool: ToolDefinition): AnthropicTool {
  const rawParameters = tool.function.parameters
  let inputSchema: Record<string, unknown>

  if (
    rawParameters &&
    typeof rawParameters === 'object' &&
    !Array.isArray(rawParameters)
  ) {
    // 保留原 schema（properties/required/description 等），仅补齐 Anthropic
    // 强制要求的顶层 type: 'object'。
    //
    // 历史 BUG（2026-07-24 修复）：此前只有在 type === 'object' 时才保留原 schema，
    // 否则整体回退为 { type: 'object', properties: {} }——properties/required 全丢，
    // 模型收到空 schema 自然只能产出空参数 {}，表现为"工具调用参数为空"。
    inputSchema = { ...(rawParameters as Record<string, unknown>) }
    if (inputSchema.type !== 'object') {
      if (import.meta.env.DEV) {
        console.warn(
          `[anthropicMessages] 工具 ${tool.function.name} 的 parameters 缺少 type: 'object'，已补齐（原 schema 保留）。`,
          rawParameters
        )
      }
      inputSchema.type = 'object'
    }
  } else {
    // parameters 完全缺失/非对象：回退到最小合法 object schema
    if (import.meta.env.DEV) {
      console.warn(
        `[anthropicMessages] 工具 ${tool.function.name} 的 parameters 不是对象，已回退为空 schema。`,
        rawParameters
      )
    }
    inputSchema = { type: 'object', properties: {} }
  }

  // 确保 properties 字段存在
  if (!('properties' in inputSchema)) {
    inputSchema.properties = {}
  }

  // required 字段透传；如果缺失但不代表无 required，保留原状
  const result: AnthropicTool = {
    name: tool.function.name,
    description: tool.function.description || `调用 ${tool.function.name}`,
    input_schema: inputSchema,
  }

  if (tool.function.defer_loading) {
    result.defer_loading = true
  }
  if (tool.function.strict) {
    result.strict = true
  }

  return result
}

/**
 * 把 WonWork 内部 Message[] 转换为 Anthropic Messages API 的消息格式。
 *
 * 处理要点（对齐 Anthropic Messages API 规范）：
 * - system 角色消息被忽略，由调用方放到请求体顶层 system 字段。
 * - assistant 的 toolCalls 展开为 content blocks 中的 tool_use。
 * - tool 结果转换为 user 消息的 tool_result content block。
 * - 连续 tool_result 合并到同一个 user message，减少消息数。
 * - tool_use 的 input 必须是一个对象；参数解析失败时回退为 {}，避免请求 400。
 */
export function normalizeMessagesForAnthropic(messages: Message[]): AnthropicMessageParam[] {
  const result: AnthropicMessageParam[] = []

  let pendingToolResults: AnthropicContentBlock[] = []

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return
    result.push({
      role: 'user',
      content: pendingToolResults,
    })
    pendingToolResults = []
  }

  for (const message of messages) {
    switch (message.role) {
      case 'system': {
        // system prompt 由调用方通过顶层 system 字段传入，不在 messages 数组中重复。
        break
      }

      case 'user': {
        flushToolResults()
        if (message.toolCallId) {
          // 这是 tool result，包装为 tool_result block。
          pendingToolResults.push({
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: message.content,
          })
        } else {
          result.push({
            role: 'user',
            content: message.content,
          })
        }
        break
      }

      case 'assistant': {
        flushToolResults()
        const blocks: AnthropicContentBlock[] = []
        if (message.content) {
          blocks.push({ type: 'text', text: message.content })
        }
        if (message.toolCalls && message.toolCalls.length > 0) {
          for (const toolCall of message.toolCalls) {
            blocks.push({
              type: 'tool_use',
              id: toolCall.id,
              name: toolCall.function.name,
              input: parseToolArguments(toolCall.function.arguments),
            })
          }
        }
        if (blocks.length > 0) {
          result.push({
            role: 'assistant',
            content: blocks,
          })
        }
        break
      }

      case 'tool': {
        // tool 角色在 WonWork 内部表示工具执行结果，转换为 tool_result block。
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: message.toolCallId || '',
          content: message.content,
        })
        break
      }
    }
  }

  flushToolResults()
  return result
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn(
        `[anthropicMessages] tool_use input 解析失败，回退为 {}。原始值: ${raw.slice(0, 200)}，错误: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }
  return {}
}
