import type { ChatMessage } from '@/types/chat'
import { safeStringify } from '@/utils/safeSerialize'

function formatTimestamp(ts?: number): string {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString('zh-CN')
  } catch {
    return String(ts)
  }
}

function formatRole(role: string): string {
  switch (role) {
    case 'user':
      return '用户'
    case 'assistant':
      return '助手'
    case 'tool':
      return '工具结果'
    case 'system':
      return '系统'
    default:
      return role
  }
}

function escapeMarkdownCodeBlock(content: string): string {
  // 避免内容中的 ``` 破坏代码块
  return content.replace(/```/g, '\\`\\`\\`')
}

function formatStructuredData(data: unknown): string {
  if (data === undefined || data === null) return ''
  const text = typeof data === 'string' ? data : safeStringify(data, 2000)
  return `\n\`\`\`json\n${escapeMarkdownCodeBlock(text)}\n\`\`\`\n`
}

function formatMessage(message: ChatMessage, index: number): string {
  const lines: string[] = []
  const header = `### ${index + 1}. ${formatRole(message.role)}`
  lines.push(header)

  if (message.timestamp) {
    lines.push(`> 时间：${formatTimestamp(message.timestamp)}`)
  }

  if (message.status && message.status !== 'done') {
    lines.push(`> 状态：${message.status}`)
  }

  lines.push('')

  if (message.content) {
    lines.push(message.content)
    lines.push('')
  }

  if (message.reasoningContent) {
    lines.push('**思考过程**')
    lines.push('')
    lines.push(message.reasoningContent)
    lines.push('')
  }

  if (message.toolCalls && message.toolCalls.length > 0) {
    lines.push('**工具调用**')
    for (const tc of message.toolCalls) {
      const name = tc.function?.name || 'unknown'
      const args = typeof tc.function?.arguments === 'string'
        ? tc.function.arguments
        : safeStringify(tc.function?.arguments, 1000)
      lines.push(`- \`${name}\``)
      lines.push(`\`\`\`json\n${escapeMarkdownCodeBlock(args)}\n\`\`\``)
    }
    lines.push('')
  }

  if (message.toolCallName) {
    lines.push(`> 工具名：\`${message.toolCallName}\``)
  }

  if (message.structuredData !== undefined) {
    lines.push('**结构化数据**')
    lines.push(formatStructuredData(message.structuredData))
    lines.push('')
  }

  if (message.attachments && message.attachments.length > 0) {
    lines.push('**附件**')
    for (const att of message.attachments) {
      lines.push(`- ${att.name} (${att.type})`)
    }
    lines.push('')
  }

  if (message.errorMessage) {
    lines.push('**错误信息**')
    lines.push(`> ${message.errorMessage}`)
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  return lines.join('\n')
}

export function exportConversationToMarkdown(
  messages: ChatMessage[],
  title?: string
): string {
  const safeTitle = title?.trim() || 'Iris 对话记录'
  const now = new Date().toLocaleString('zh-CN')
  const header = [
    `# ${safeTitle}`,
    '',
    `- 导出时间：${now}`,
    `- 消息数：${messages.length}`,
    '',
    '---',
    '',
  ].join('\n')

  const body = messages
    .filter((m) => m.role !== 'system')
    .map((m, idx) => formatMessage(m, idx))
    .join('\n')

  return header + body
}

export function downloadTextFile(filename: string, content: string, type = 'text/markdown'): void {
  const blob = new Blob([content], { type: `${type};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function exportConversation(
  messages: ChatMessage[],
  title?: string
): void {
  const md = exportConversationToMarkdown(messages, title)
  const date = new Date().toISOString().slice(0, 10)
  const safeTitle = (title || 'conversation').replace(/[^\w一-龥\-]/g, '_')
  const filename = `${safeTitle}_${date}.md`
  downloadTextFile(filename, md)
}

// ─────────────────────── JSON 导出（测评集采集原料） ───────────────────────
//
// 用途：记忆系统测评集（learn/04/workshop/记忆测评集/）的原始数据采集。
// Markdown 是给人读的；JSON 是给脚本/测评 harness 用的——结构化字段、
// ISO 时间戳、显式 index（顺序即展示顺序，与落盘乱序修复 2026-07-30 互为保障）。

interface ExportMessageJson {
  index: number
  id: string
  role: string
  content: string
  timestamp: string | null
  isSupplement?: boolean
  toolCallName?: string
  toolCalls?: Array<{ name: string; arguments: string }>
  attachments?: string[]
  errorMessage?: string
}

interface ExportConversationJson {
  format: 'wonwork-conversation-export'
  version: 1
  exportedAt: string
  conversation: { id: number | null; title: string }
  messageCount: number
  messages: ExportMessageJson[]
}

export function exportConversationToJson(
  messages: ChatMessage[],
  title?: string,
  conversationId?: number | null
): string {
  const visible = messages.filter((m) => m.role !== 'system')
  const payload: ExportConversationJson = {
    format: 'wonwork-conversation-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    conversation: { id: conversationId ?? null, title: title?.trim() || 'Iris 对话记录' },
    messageCount: visible.length,
    messages: visible.map((m, index) => {
      const item: ExportMessageJson = {
        index,
        id: m.id,
        role: m.role,
        content: m.content || '',
        timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : null,
      }
      if (m.isSupplement) item.isSupplement = true
      if (m.toolCallName) item.toolCallName = m.toolCallName
      if (m.toolCalls && m.toolCalls.length > 0) {
        item.toolCalls = m.toolCalls.map((tc) => ({
          name: tc.function?.name || 'unknown',
          arguments:
            typeof tc.function?.arguments === 'string'
              ? tc.function.arguments
              : safeStringify(tc.function?.arguments, 4000),
        }))
      }
      if (m.attachments && m.attachments.length > 0) {
        item.attachments = m.attachments.map((a) => a.name)
      }
      if (m.errorMessage) item.errorMessage = m.errorMessage
      return item
    }),
  }
  return JSON.stringify(payload, null, 2)
}

export function exportConversationJson(
  messages: ChatMessage[],
  title?: string,
  conversationId?: number | null
): void {
  const json = exportConversationToJson(messages, title, conversationId)
  const date = new Date().toISOString().slice(0, 10)
  const safeTitle = (title || 'conversation').replace(/[^\w一-龥\-]/g, '_')
  downloadTextFile(`${safeTitle}_${date}.json`, json, 'application/json')
}
