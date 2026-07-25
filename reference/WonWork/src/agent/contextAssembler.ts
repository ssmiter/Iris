/**
 * 上下文装配器（Agentic 内核层）
 *
 * 负责将 system prompt sections、历史消息、当前用户消息、skill prompts、memory prompt
 * 装配成最终发给模型的 Message[]，并在接近 context window 时按优先级截断。
 *
 * Phase 1 重构目标：借鉴 Claude Code 的分层压缩思想，实现 Context 生命周期管理：
 * 1. system sections 按 priority 排序，整体优先保留。
 * 2. 当前用户消息（含附件文本）永远保留。
 * 3. 工具结果先做单条截断，再按聚合预算归档旧结果。
 * 4. 历史消息按优先级保留：最近 tool-call 往返 > 近期对话 > 旧 tool result > 旧 user/assistant。
 * 5. 超出预算时从低优先级消息开始丢弃，返回详细的截断统计供上层观测/决策。
 *
 * 注意：前端 token 估算是启发式的，与后端真实 tokenizer 有误差。保留开关 `useFrontendContextBudget`
 * 供后端不配合时关闭。
 */

import type { Message, FileAttachmentDto } from '@/types/mescli'
import type { ChatMessage } from '@/types/chat'
import type { SystemPromptSection } from '@/utils/systemPromptBuilder'
import { estimateMessageTokens, estimateTextTokens } from '@/utils/tokenEstimator'

export interface AssembleContextOptions {
  systemSections: SystemPromptSection[]
  history: ChatMessage[]
  userMessage: ChatMessage
  skillPrompts?: string[]
  memoryPrompt?: string
  contextWindow: number
  /** 给模型输出留出的 token 预算，默认 4096 */
  reserveTokens?: number
  /** 是否启用前端截断；后端自己做强兜底时可关闭 */
  useFrontendContextBudget?: boolean
  /** 单条 tool result 最大字符数，默认 50000 */
  maxToolResultChars?: number
  /** 工具结果总字符预算，默认 200000 */
  totalToolResultBudget?: number
  /** 历史消息保留的优先级策略；默认 'claude-code-style' */
  truncationStrategy?: 'claude-code-style' | 'recent-only'
  /** 可选的压缩器：当截断严重时，用模型压缩被丢弃的早期对话 */
  compressor?: (messages: Message[]) => Promise<{ summary: string; compressedCount: number }>
  /** 强制压缩：即使 droppedCount < 2，也尝试压缩被丢弃的消息（用于 prompt_too_long 重试） */
  forceCompress?: boolean
}

export interface AssembleContextResult {
  messages: Message[]
  usedTokens: number
  droppedCount: number
  systemTokens: number
  /** 历史消息实际使用的 token（不含 system 和当前 user） */
  historyTokens: number
  /** 当前用户消息使用的 token */
  userTokens: number
  /** 被归档替换的 toolCallId 列表 */
  archivedToolResults: string[]
  /** 保留的 tool result 条数 */
  keptToolResults: number
  /** 是否发生了截断 */
  isTruncated: boolean
  /** 截断原因摘要 */
  truncationReason?: string
  /** 上下文预算明细 */
  budget: {
    contextWindow: number
    reserveTokens: number
    availableTokens: number
  }
  /** 被丢弃消息明细（用于调试/可观测性） */
  droppedMessages?: Array<{ id?: string; role: string; reason: string }>
  /** 压缩信息 */
  compression?: {
    summary: string
    compressedCount: number
  }
}

const DEFAULT_RESERVE_TOKENS = 4096
const DEFAULT_MAX_TOOL_RESULT_CHARS = 50000
const DEFAULT_TOTAL_TOOL_RESULT_BUDGET = 200000

/** 判断消息是否属于 tool-call/tool-result 往返的一部分 */
function isToolMessage(m: ChatMessage): boolean {
  if (m.role === 'tool') return true
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) return true
  return false
}

/** 判断是否为带 toolCalls 的 assistant 消息 */
function isToolCallingAssistant(m: ChatMessage): boolean {
  return m.role === 'assistant' && !!m.toolCalls && m.toolCalls.length > 0
}

/** 提取工具结果中的关键预览信息，用于归档替换 */
function summarizeToolContent(content: string, maxChars: number, toolCallId?: string): string {
  if (content.length <= maxChars) return content

  // 尝试提取 JSON 结果中的关键字段
  let preview = content.slice(0, maxChars)
  try {
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === 'object') {
      const keys = Object.keys(parsed)
      const summaryKeys = keys.filter((k) =>
        ['success', 'path', 'count', 'total', 'error', 'files', 'matches'].includes(k)
      )
      if (summaryKeys.length > 0) {
        const summary: Record<string, unknown> = {}
        for (const key of summaryKeys) {
          summary[key] = (parsed as Record<string, unknown>)[key]
        }
        const summaryText = JSON.stringify(summary)
        if (summaryText.length <= maxChars) {
          preview = summaryText
        }
      }
    }
  } catch {
    // 非 JSON，保持文本前缀
  }

  return `[结果已归档，原始长度 ${content.length} 字符${toolCallId ? `，toolCallId: ${toolCallId}` : ''}]\n预览：${preview}`
}

function buildUserMessageContent(userMessage: ChatMessage): string {
  const textParts: string[] = [userMessage.content || '']

  if (userMessage.attachments && userMessage.attachments.length > 0) {
    textParts.push('\n\n--- 附件 ---')
    for (const att of userMessage.attachments) {
      if (att.isWorkspaceUpload) {
        // Workspace 文件由后端注入文件卡片；前端上下文里只保留路径引用，避免重复大段内容
        if (att.type === 'image') {
          textParts.push(`[图片: ${att.name}]\n${att.data}`)
        } else {
          textParts.push(`[工作区文件: ${att.name}]\n路径：${att.workspacePath}`)
        }
      } else if (att.type === 'image') {
        textParts.push(`[图片: ${att.name}]\n${att.data}`)
      } else if (att.type === 'text' || att.type === 'document') {
        const snippet = att.data || ''
        textParts.push(`[文件: ${att.name}]\n${snippet}`)
      } else {
        textParts.push(`[文件: ${att.name}]\n${att.data || ''}`)
      }
    }
  }

  return textParts.join('\n\n')
}

/** 计算消息优先级：数字越小越优先保留 */
function computeMessagePriority(
  m: ChatMessage,
  index: number,
  total: number,
  latestToolCallTurnIndex: number
): number {
  const distanceFromEnd = total - 1 - index

  // 最近一轮完整的 tool-call 往返：最高优先级
  if (index >= latestToolCallTurnIndex) {
    if (isToolMessage(m)) return 0
  }

  // 最近的 2 轮普通对话
  if (distanceFromEnd <= 3) return 1

  // 旧的带 toolCalls 的 assistant 消息
  if (isToolCallingAssistant(m)) return 2

  // 旧的 tool result 消息
  if (m.role === 'tool') return 3

  // 旧的 assistant 消息
  if (m.role === 'assistant') return 4

  // 旧的 user 消息
  return 5
}

/** 找到最近一轮 tool-call 往返的起始索引 */
function findLatestToolCallTurnStart(history: ChatMessage[]): number {
  // 从后往前找最后一个带 toolCalls 的 assistant，然后包含它后面的 tool 消息
  let startIndex = history.length
  for (let i = history.length - 1; i >= 0; i--) {
    if (isToolCallingAssistant(history[i])) {
      startIndex = i
      break
    }
  }
  return startIndex
}

export async function assembleRequestMessages(options: AssembleContextOptions): Promise<AssembleContextResult> {
  const {
    systemSections,
    history,
    userMessage,
    skillPrompts = [],
    memoryPrompt,
    contextWindow,
    reserveTokens = DEFAULT_RESERVE_TOKENS,
    useFrontendContextBudget = true,
    maxToolResultChars = DEFAULT_MAX_TOOL_RESULT_CHARS,
    totalToolResultBudget = DEFAULT_TOTAL_TOOL_RESULT_BUDGET,
    compressor,
  } = options

  // 1. 准备所有 system sections（含 memory / skill）
  const allSystemSections: SystemPromptSection[] = sortSectionsByPriority([
    ...systemSections,
    ...(memoryPrompt
      ? [
          {
            role: 'system' as const,
            content: memoryPrompt,
            section: 'memory' as const,
            priority: 4,
          },
        ]
      : []),
    ...skillPrompts.map(
      (content): SystemPromptSection => ({
        role: 'system',
        content,
        section: 'skill',
        priority: 5,
      })
    ),
  ])

  const systemMessages = allSystemSections.map((s) => ({
    role: s.role,
    content: s.content,
  }))

  // 2. 计算 system messages 占用的 token
  let systemTokens = systemMessages.reduce(
    (sum, m) => sum + estimateMessageTokens(m as Message & { attachments?: FileAttachmentDto[] }),
    0
  )

  // 3. 准备历史消息
  const preservedHistoryItems = history.filter((m) => {
    if (!m.id) return false
    if (m.role === 'tool') return true
    if (m.role === 'user' || m.role === 'assistant') return true
    return false
  })

  // 4. 对 tool result 做分层处理：先单条摘要，再按聚合预算归档
  const archivedToolResults: string[] = []
  let totalToolChars = 0
  const toolMessageIndices: number[] = []

  // 4.1 单条超长摘要
  preservedHistoryItems.forEach((m, index) => {
    if (m.role === 'tool' && m.content) {
      totalToolChars += m.content.length
      toolMessageIndices.push(index)
      if (m.content.length > maxToolResultChars) {
        const summarized = summarizeToolContent(m.content, maxToolResultChars, m.toolCallId)
        if (m.toolCallId && !archivedToolResults.includes(m.toolCallId)) {
          archivedToolResults.push(m.toolCallId)
        }
        preservedHistoryItems[index] = { ...m, content: summarized }
        totalToolChars -= m.content.length - summarized.length
      }
    }
  })

  // 4.2 聚合预算归档：从最旧的 tool result 开始折叠
  if (totalToolChars > totalToolResultBudget) {
    for (const index of toolMessageIndices) {
      const m = preservedHistoryItems[index]
      if (m.role === 'tool' && m.content && !m.content.startsWith('[结果已归档')) {
        const summarized = summarizeToolContent(m.content, Math.min(maxToolResultChars, 500), m.toolCallId)
        if (m.toolCallId && !archivedToolResults.includes(m.toolCallId)) {
          archivedToolResults.push(m.toolCallId)
        }
        preservedHistoryItems[index] = { ...m, content: summarized }
        totalToolChars -= m.content.length - summarized.length
        if (totalToolChars <= totalToolResultBudget) break
      }
    }
  }

  const preservedHistory: Message[] = preservedHistoryItems.map((m) => {
    const msg: Message = {
      role: m.role,
      content: m.content,
    }
    if (m.toolCalls && m.toolCalls.length > 0) {
      msg.toolCalls = m.toolCalls
    }
    if (m.toolCallId) {
      msg.toolCallId = m.toolCallId
    }
    return msg
  })

  // 5. 当前用户消息永远保留
  const currentUserMessage: Message = {
    role: 'user',
    content: buildUserMessageContent(userMessage),
    structuredData: userMessage.structuredData,
  }

  // 6. 如果不启用前端截断，直接返回完整消息
  if (!useFrontendContextBudget) {
    const messages = [...systemMessages, ...preservedHistory, currentUserMessage]
    const usedTokens =
      systemTokens +
      preservedHistory.reduce(
        (sum, m) =>
          sum + estimateMessageTokens(m as Message & { attachments?: FileAttachmentDto[] }),
        0
      ) +
      estimateMessageTokens(currentUserMessage as Message & { attachments?: FileAttachmentDto[] })
    return {
      messages,
      usedTokens,
      droppedCount: 0,
      systemTokens,
      historyTokens: usedTokens - systemTokens - estimateMessageTokens(currentUserMessage as Message & { attachments?: FileAttachmentDto[] }),
      userTokens: estimateMessageTokens(currentUserMessage as Message & { attachments?: FileAttachmentDto[] }),
      archivedToolResults,
      keptToolResults: toolMessageIndices.length,
      isTruncated: false,
      budget: {
        contextWindow,
        reserveTokens,
        availableTokens: Math.max(0, contextWindow - reserveTokens - systemTokens),
      },
      droppedMessages: [],
    }
  }

  // 7. 计算预算
  const availableTokens = Math.max(0, contextWindow - reserveTokens - systemTokens)
  const currentUserTokens = estimateMessageTokens(
    currentUserMessage as Message & { attachments?: FileAttachmentDto[] }
  )
  let remainingTokens = Math.max(0, availableTokens - currentUserTokens)

  // 8. 按优先级截断历史消息
  const latestToolCallTurnStart = findLatestToolCallTurnStart(preservedHistoryItems)
  const historyWithPriority = preservedHistoryItems.map((m, index) => ({
    message: preservedHistory[index],
    original: m,
    index,
    tokens: estimateMessageTokens(preservedHistory[index] as Message & { attachments?: FileAttachmentDto[] }),
    priority: computeMessagePriority(m, index, preservedHistoryItems.length, latestToolCallTurnStart),
  }))

  // 按优先级排序（同优先级保持原顺序）
  historyWithPriority.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    return a.index - b.index
  })

  const keptHistory: Message[] = []
  const droppedMessages: Array<{ id?: string; role: string; reason: string }> = []
  let historyTokens = 0
  let droppedCount = 0

  for (const item of historyWithPriority) {
    // 即使是高优先级消息（最近一轮 tool-call 往返 / 最近 2 轮对话）
    // 也必须受 token 预算约束，否则长工具结果或长对话会撑爆上下文。
    if (item.tokens <= remainingTokens) {
      keptHistory.push(item.message)
      remainingTokens -= item.tokens
      historyTokens += item.tokens
    } else {
      droppedCount++
      droppedMessages.push({
        id: item.original.id,
        role: item.original.role,
        reason: `超出 token 预算（优先级 ${item.priority}，需要 ${item.tokens} tokens，剩余 ${remainingTokens}）`,
      })
    }
  }

  // 恢复原始顺序
  keptHistory.sort((a, b) => {
    const idxA = preservedHistory.indexOf(a)
    const idxB = preservedHistory.indexOf(b)
    return idxA - idxB
  })

  // 9. 组装最终消息
  const messages = [...systemMessages, ...keptHistory, currentUserMessage]
  let usedTokens = systemTokens + historyTokens + currentUserTokens
  const isTruncated = droppedCount > 0 || archivedToolResults.length > 0

  let truncationReason: string | undefined
  if (droppedCount > 0 && archivedToolResults.length > 0) {
    truncationReason = `已丢弃 ${droppedCount} 条旧消息，并归档 ${archivedToolResults.length} 条 tool result`
  } else if (droppedCount > 0) {
    truncationReason = `已丢弃 ${droppedCount} 条旧消息以控制上下文长度`
  } else if (archivedToolResults.length > 0) {
    truncationReason = `已归档 ${archivedToolResults.length} 条超长 tool result`
  }

  // 10. 如果截断严重且提供了压缩器，用模型压缩被丢弃的早期对话
  let compression: { summary: string; compressedCount: number } | undefined
  const shouldCompress = compressor && (droppedCount >= 2 || options.forceCompress)
  if (shouldCompress) {
    const droppedForCompression = historyWithPriority
      .filter((item) => !keptHistory.includes(item.message))
      .sort((a, b) => a.index - b.index)
      .map((item) => item.message)

    if (droppedForCompression.length >= 2) {
      try {
        const result = await compressor(droppedForCompression)
        if (result.summary) {
          compression = {
            summary: result.summary,
            compressedCount: result.compressedCount || droppedForCompression.length,
          }
          const summaryMessage: Message = {
            role: 'system',
            content: `[早期对话摘要]\n${result.summary}`,
          }
          messages.unshift(summaryMessage)
          const summaryTokens = estimateMessageTokens(summaryMessage as Message & { attachments?: FileAttachmentDto[] })
          usedTokens += summaryTokens
          systemTokens += summaryTokens
        }
      } catch (err) {
        console.warn('[contextAssembler] 压缩历史消息失败:', err)
      }
    }
  }

  return {
    messages,
    usedTokens,
    droppedCount,
    systemTokens,
    historyTokens,
    userTokens: currentUserTokens,
    archivedToolResults,
    keptToolResults: toolMessageIndices.length - archivedToolResults.length,
    isTruncated,
    truncationReason,
    budget: {
      contextWindow,
      reserveTokens,
      availableTokens,
    },
    droppedMessages,
    compression,
  }
}

function sortSectionsByPriority(sections: SystemPromptSection[]): SystemPromptSection[] {
  return [...sections].sort((a, b) => a.priority - b.priority)
}

/** 估算单个文本的 token（用于外部快速检查） */
export { estimateTextTokens }
