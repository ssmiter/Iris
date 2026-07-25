/**
 * 上下文压缩服务
 *
 * 当对话历史超过上下文窗口预算时，用一次独立的模型调用把早期对话压缩成摘要。
 * 这是 Claude Code autoCompact 的简化版：
 * - 只压缩非结构化的对话历史，不碰 system prompt 和当前用户消息。
 * - 保留关键事实、用户意图、文件路径、工具调用结论。
 * - 输出一条 assistant 风格的 summary message，可替代被压缩的早期消息注入上下文。
 */

import type { LocalModelProvider, Message, ProviderConfig } from '@/types/mescli'
import type { StreamChunk } from '@/api/client'
import { chatApi } from '@/api/client'
import { standaloneChatApi } from '@/api/standaloneApi'
import { localModelApi } from '@/api/localModelApi'
import { useLocalModelStore } from '@/stores/localModelStore'
import { isLocalRuntime } from '@/utils/runtimeMode'

export interface CompressionOptions {
  /** 要被压缩的早期消息 */
  messages: Message[]
  /** 当前使用的 LLM 提供商 */
  provider: ProviderConfig
  /** API Key（Standalone 模式下需要） */
  apiKey?: string
  /** 自定义 baseUrl */
  baseUrl?: string
  /** 压缩后摘要的最大 token（粗略控制长度） */
  maxSummaryTokens?: number
  /** 超时时间 */
  timeoutMs?: number
}

export interface CompressionResult {
  summary: string
  /** 被压缩的消息数量 */
  compressedCount: number
  /** 是否成功 */
  success: boolean
  /** 失败原因 */
  error?: string
}

const COMPRESSION_SYSTEM_PROMPT = `你是一位对话上下文压缩专家。你的任务是把一段历史对话压缩成简短但信息密集的摘要，供另一个 AI 助手继续处理任务时使用。

要求：
1. 用第三人称客观叙述，不要复制原文。
2. 保留以下关键信息：
   - 用户的核心请求和目标
   - 已经执行过的关键工具调用及其结果（特别是文件路径、成功/失败状态、关键数值）
   - 用户明确表达过的偏好、约束或要求
   - 任何尚未完成的中间状态
3. 不要添加对话中没有的信息。
4. 不要包含寒暄、道歉、解释等冗余内容。
5. 摘要应控制在 300-500 个汉字以内，除非内容特别复杂。
6. 如果历史对话主要是工具调用和结果，优先列出：工具名、参数、结果摘要。`

function buildCompressionPrompt(messages: Message[]): string {
  const lines: string[] = ['请压缩以下对话历史：\n']
  for (const m of messages) {
    if (m.role === 'system') {
      lines.push(`[系统] ${m.content}`)
    } else if (m.role === 'user') {
      lines.push(`[用户] ${m.content}`)
    } else if (m.role === 'assistant') {
      lines.push(`[助手] ${m.content}`)
      if (m.toolCalls && m.toolCalls.length > 0) {
        for (const tc of m.toolCalls) {
          lines.push(`  [工具调用] ${tc.function?.name || ''}(${tc.function?.arguments || ''})`)
        }
      }
    } else if (m.role === 'tool') {
      lines.push(`[工具结果] ${m.content}`)
    }
  }
  lines.push('\n请输出压缩后的摘要：')
  return lines.join('\n')
}

function isLocalModelProvider(provider: string): provider is LocalModelProvider {
  return provider === 'ollama' || provider === 'lmstudio' || provider === 'webllm'
}

export async function compressMessages(options: CompressionOptions): Promise<CompressionResult> {
  const {
    messages,
    provider,
    apiKey,
    baseUrl,
    maxSummaryTokens = 500,
    timeoutMs = 30000,
  } = options

  if (messages.length === 0) {
    return { summary: '', compressedCount: 0, success: true }
  }

  const requestMessages: Message[] = [
    { role: 'system', content: COMPRESSION_SYSTEM_PROMPT },
    { role: 'user', content: buildCompressionPrompt(messages) },
  ]

  return new Promise((resolve) => {
    let summary = ''
    let settled = false

    const onChunk = (chunk: StreamChunk) => {
      if (chunk.type === 'content') {
        summary += chunk.content || ''
      } else if (chunk.type === 'error') {
        if (!settled) {
          settled = true
          resolve({
            summary: '',
            compressedCount: 0,
            success: false,
            error: chunk.content || '压缩请求失败',
          })
        }
      }
    }

    const onError = (error: Error) => {
      if (!settled) {
        settled = true
        resolve({
          summary: '',
          compressedCount: 0,
          success: false,
          error: error.message,
        })
      }
    }

    const onDone = () => {
      if (!settled) {
        settled = true
        // 去掉模型常见的包装性文字
        const cleaned = summary
          .replace(/^```\w*\n?/, '')
          .replace(/\n?```$/, '')
          .trim()
        resolve({
          summary: cleaned || summary,
          compressedCount: messages.length,
          success: true,
        })
      }
    }

    // MESCLI Local / Standalone 模式下应直接调用 Provider，避免后端 SSE 因模型配置不一致而误报"模型不可用"。
    let abort: () => void
    if (isLocalModelProvider(provider.provider)) {
      const localConfig = useLocalModelStore.getState().config
      abort = localModelApi.streamChat(
        {
          ...localConfig,
          model: provider.model || localConfig.model,
        },
        requestMessages,
        onChunk,
        onError,
        onDone
      )
    } else if (isLocalRuntime()) {
      abort = standaloneChatApi.streamChat(
        {
          provider: provider.provider,
          model: provider.model,
          apiKey,
          baseUrl,
          messages: requestMessages,
        },
        onChunk,
        onError,
        onDone
      )
    } else {
      abort = chatApi.streamChat(
        {
          provider: provider.provider,
          model: provider.model,
          apiKey,
          baseUrl,
          messages: requestMessages,
          saveToHistory: false,
        },
        onChunk,
        onError,
        onDone
      )
    }

    setTimeout(() => {
      if (!settled) {
        settled = true
        abort()
        resolve({
          summary: summary || '',
          compressedCount: summary ? messages.length : 0,
          success: !!summary,
          error: summary ? undefined : '压缩请求超时',
        })
      }
    }, timeoutMs)
  })
}
