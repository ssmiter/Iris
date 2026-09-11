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
  /** 尾随 meta 注入（记忆索引等动态状态）：追加在当前用户消息正文之后，
   *  不进 system 前缀——前缀保持静态以保缓存，动态状态挂轨迹末尾获得注意力权重。
   *  与 Claude Code 的 system-reminder 附身用户消息同一模式，全 provider 兼容。 */
  trailingMeta?: string
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
  /** P0-5b（2026-07-28 归档决策冻结）：4.1/4.2 每次实际折叠 tool 结果时回调，
   *  由调用方把折叠文本一次性写回 store+IndexedDB——一条消息只折一次，
   *  之后每次装配读到的都是已折叠内容，历史字节永久稳定（前缀缓存命中前提）。 */
  onArchiveDecisions?: (decisions: Array<{ toolCallId: string; content: string }>) => void
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

/**
 * P0-5a（2026-07-28 历史保真）：带 sentTurns 的 assistant 展开为实际发送序列。
 * 存储形态是"单条合并 assistant + tool 消息紧随其后"，而实际发送是"每轮 assistant +
 * 该轮 tool 结果交错"。不展开时跨 turn 重装配字节与上轮实际发送不同（前缀缓存全 miss），
 * 且早轮 tool 消息对不上 toolCalls 会被 normalizer 重构出假 tool_use（arguments 塞结果）。
 * 旧消息无 sentTurns 时原样通过（按合并单条兜底）。
 */
function expandSentTurns(items: ChatMessage[]): ChatMessage[] {
  const expanded: ChatMessage[] = []
  for (let i = 0; i < items.length; i++) {
    const m = items[i]
    if (m.role !== 'assistant' || !m.sentTurns || m.sentTurns.length === 0) {
      expanded.push(m)
      continue
    }
    // 收集紧随其后的 tool 消息（直到下一条非 tool），按 toolCallId 归位到各轮
    const followingTools = new Map<string, ChatMessage>()
    let end = i + 1
    while (end < items.length && items[end].role === 'tool') {
      const tm = items[end]
      if (tm.toolCallId) followingTools.set(tm.toolCallId, tm)
      end++
    }
    const consumed = new Set<string>()
    for (const t of m.sentTurns) {
      // Fix6（2026-08-01）：该轮 wire 上先插过合成 user（max_tokens 续写）时补插回去，
      // 保持重放字节=实发字节；否则相邻 assistant 被 normalizer 合并，前缀缓存发散。
      if (t.precededByUserNote) {
        expanded.push({
          id: `${m.id}-wire-note`,
          role: 'user',
          content: t.precededByUserNote,
          timestamp: m.timestamp,
        })
      }
      // reasoningContent 用逐轮值覆盖展开：m 上的是全消息累计值，逐轮铺开会让
      // 每轮都带全量（重复且与实发字节不符）；旧数据无逐轮值则省略（=修复前行为）。
      expanded.push({ ...m, content: t.content, reasoningContent: t.reasoningContent, toolCalls: t.toolCalls, sentTurns: undefined })
      for (const tc of t.toolCalls ?? []) {
        const tm = followingTools.get(tc.id)
        if (tm && !consumed.has(tc.id)) {
          expanded.push(tm)
          consumed.add(tc.id)
        }
      }
    }
    // 未被任何轮次认领的 tool 消息（异常/旧数据）按原位保留，normalizer 兜底
    for (const [id, tm] of followingTools) {
      if (!consumed.has(id)) expanded.push(tm)
    }
    i = end - 1
  }
  return expanded
}

/** 剥掉历史消息里冻结的旧记忆索引快照（2026-09-03）：
 *  索引每轮附在当条用户消息尾部并冻结进 wireContent；重放时只保留当前消息的
 *  最新一份，历史快照在此剥除，避免 N 条消息堆 N 份索引。 */
const STALE_MEMORY_INDEX_RE = /\n*<memory_index dir="[^"]*">[\s\S]*?<\/memory_index>/g
function stripStaleMemoryIndex(content: string): string {
  return content.includes('<memory_index') ? content.replace(STALE_MEMORY_INDEX_RE, '') : content
}

export function buildUserMessageContent(userMessage: ChatMessage): string {  const textParts: string[] = [userMessage.content || '']

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
    trailingMeta,
    contextWindow,
    reserveTokens = DEFAULT_RESERVE_TOKENS,
    useFrontendContextBudget = true,
    maxToolResultChars = DEFAULT_MAX_TOOL_RESULT_CHARS,
    totalToolResultBudget = DEFAULT_TOTAL_TOOL_RESULT_BUDGET,
    onArchiveDecisions,
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
  const filteredHistoryItems = history.filter((m) => {
    if (!m.id) return false
    // 记忆便签是纯 UI 产物（role=assistant 但 content 为空）——进 wire 会被严格
    // provider 拒（空 assistant 消息 400），它也不是说给模型听的话
    if (m.memoryNote) return false
    if (m.role === 'tool') return true
    if (m.role === 'user' || m.role === 'assistant') return true
    return false
  })

  // 3.5 P0-5a：带 sentTurns 的 assistant 展开为实际发送序列（历史=实际发送字节）
  const preservedHistoryItems = expandSentTurns(filteredHistoryItems)

  // 4. 对 tool result 做分层处理：先单条摘要，再按聚合预算归档
  const archivedToolResults: string[] = []
  const archiveDecisions: Array<{ toolCallId: string; content: string }> = []
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
          archiveDecisions.push({ toolCallId: m.toolCallId, content: summarized })
        }
        preservedHistoryItems[index] = { ...m, content: summarized }
        totalToolChars -= m.content.length - summarized.length
      }
    }
  })

  // 4.2 聚合预算归档：从最旧的 tool result 开始折叠。
  // 批量摊销（2026-08-01 Fix7）：稳态下 tool 总量缓慢爬过 budget，旧逻辑每轮只折一条
  // 最旧 tool——折叠点在最前，身后前缀每轮全 miss。改为超 25% 才触发、一次折回 budget
  // 以内，折叠事件从"每轮一次"摊薄为"积累 25% 才一次"。
  if (totalToolChars > totalToolResultBudget * 1.25) {
    for (const index of toolMessageIndices) {
      const m = preservedHistoryItems[index]
      if (m.role === 'tool' && m.content && !m.content.startsWith('[结果已归档')) {
        const summarized = summarizeToolContent(m.content, Math.min(maxToolResultChars, 500), m.toolCallId)
        if (m.toolCallId && !archivedToolResults.includes(m.toolCallId)) {
          archivedToolResults.push(m.toolCallId)
        }
        // 决策冻结：即使是同一条的二次折叠（4.1 折过 4.2 再折），也以最后一次文本写回
        if (m.toolCallId) {
          const existing = archiveDecisions.findIndex((d) => d.toolCallId === m.toolCallId)
          if (existing !== -1) archiveDecisions[existing] = { toolCallId: m.toolCallId, content: summarized }
          else archiveDecisions.push({ toolCallId: m.toolCallId, content: summarized })
        }
        preservedHistoryItems[index] = { ...m, content: summarized }
        totalToolChars -= m.content.length - summarized.length
        if (totalToolChars <= totalToolResultBudget) break
      }
    }
  }

  // P0-5b：归档决策一次性写回（调用方负责 store+IndexedDB），此后该消息字节永久稳定
  if (archiveDecisions.length > 0) {
    try {
      onArchiveDecisions?.(archiveDecisions)
    } catch (err) {
      console.warn('[contextAssembler] 归档决策写回回调失败:', err)
    }
  }

  const preservedHistory: Message[] = preservedHistoryItems.map((m) => {
    const msg: Message = {
      role: m.role,
      // Fix4（2026-08-01 前缀缓存保真）：user 消息优先用发送时冻结的 wireContent
      // （含 trailingMeta 记忆索引/最近文件注记），重放字节=实发字节；
      // 旧消息无此字段时回退裸 content（重载冷缓存，defer P2）。
      // 2026-09-03：历史消息尾部的旧记忆索引快照剥离——旧索引的价值只在发送当时，
      // 上下文只留最新一份（附在当前用户消息上）。剥离是确定性的，早期消息字节
      // 逐轮稳定（前缀缓存更友好），且消除"N 条用户消息堆 N 份索引"的膨胀。
      content: stripStaleMemoryIndex(m.wireContent ?? m.content),
    }
    if (m.toolCalls && m.toolCalls.length > 0) {
      msg.toolCalls = m.toolCalls
    }
    if (m.toolCallId) {
      msg.toolCallId = m.toolCallId
    }
    return msg
  })

  // 5. 当前用户消息永远保留；trailingMeta（记忆索引等动态状态）附在正文之后，
  // 随消息一同参与 token 估算与截断保护（用户消息永不丢，meta 因此也永不丢）。
  // Fix4：发送方（chatStore）已把含 trailingMeta 的完整 wire 文本冻结进 wireContent，
  // 这里原样取用；无冻结快照时（旧路径/单测）现场拼装兜底。
  const currentUserMessage: Message = {
    role: 'user',
    content:
      userMessage.wireContent ??
      buildUserMessageContent(userMessage) +
        (trailingMeta ? `\n\n${trailingMeta}` : ''),
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
  // 消息 → 原始位置索引（墓碑消息是新对象，恢复顺序时靠它找到原位）
  const orderIndex = new Map<Message, number>(preservedHistory.map((m, i) => [m, i]))
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
      // 工具结果不整条丢弃：原地留"已执行、结果被移除"的墓碑，保住 tool_use/tool_result 配对。
      // 否则发送前 messageNormalizer 会补「（工具执行结果缺失…）」——长对话里模型会误读为
      // "该调用当时没执行/我当时编造了数据"，进而否定自己基于真实返回得出的历史结论
      //（2026-08-14 长对话过度思考的根因定位）。
      if (item.message.role === 'tool') {
        const tombstone: Message = {
          ...item.message,
          content:
            '（该调用当时已执行完成；原始结果为释放上下文空间被移除。你当时基于真实返回得出的结论仍然有效；确需原始数据时，用当前可用工具重新查询即可。）',
        }
        keptHistory.push(tombstone)
        orderIndex.set(tombstone, item.index)
        const tombstoneTokens = estimateMessageTokens(tombstone)
        remainingTokens = Math.max(0, remainingTokens - tombstoneTokens)
        historyTokens += tombstoneTokens
      }
      droppedMessages.push({
        id: item.original.id,
        role: item.original.role,
        reason:
          item.message.role === 'tool'
            ? `结果超出预算，原地留墓碑（优先级 ${item.priority}，原 ${item.tokens} tokens）`
            : `超出 token 预算（优先级 ${item.priority}，需要 ${item.tokens} tokens，剩余 ${remainingTokens}）`,
      })
    }
  }

  // 恢复原始顺序（墓碑消息不在 preservedHistory 里，经 orderIndex 找原位）
  keptHistory.sort((a, b) => {
    const idxA = orderIndex.get(a) ?? -1
    const idxB = orderIndex.get(b) ?? -1
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

  // 10. 旧装配期压缩已于 2026-07-31 退役：摘要不持久化（每次发送重新压缩浪费 token）、
  // unshift 到 identity 之前破坏 system 前缀缓存、且压缩结果无任何下游消费。
  // 现役路径 = compactSummaryPipeline（autoCompact 减半重试 + 三次熔断），见 agenticLoop。

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
  }
}

function sortSectionsByPriority(sections: SystemPromptSection[]): SystemPromptSection[] {
  return [...sections].sort((a, b) => a.priority - b.priority)
}

/** 估算单个文本的 token（用于外部快速检查） */
export { estimateTextTokens }
