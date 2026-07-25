import { useChatStore } from '@/stores/chatStore'
import { useConversationStore } from '@/stores/conversationStore'
import type { ChatMessage, ThinkingProcessData } from '@/types/chat'
import { historyApi } from '@/api/client'
import { webBridgeClient } from '@/api/webbridgeClient'

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export type WorkflowRunType = 'dag' | 'webbridge'

interface StartWorkflowRunChatResult {
  conversationId: number
  assistantMessageId: string
  updateLog: (log: string) => void
  setStatus: (status: ThinkingProcessData['status']) => void
  finalize: (status: 'completed' | 'error', summary: string) => Promise<void>
}

function formatInputs(inputs: Record<string, unknown> | undefined): string {
  if (!inputs || Object.keys(inputs).length === 0) return '无'
  try {
    return Object.entries(inputs)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join('\n')
  } catch {
    return '（输入包含不可序列化数据）'
  }
}

export async function startWorkflowRunChatThread(
  workflowName: string,
  type: WorkflowRunType,
  inputs?: Record<string, unknown>
): Promise<StartWorkflowRunChatResult | null> {
  const conversationStore = useConversationStore.getState()
  let conversationId = conversationStore.currentConversationId
  if (!conversationId) {
    conversationId = await conversationStore.createConversation(`工作流运行：${workflowName}`)
    if (!conversationId) return null
  }

  const runTypeLabel = type === 'dag' ? 'DAG 工作流' : 'WebBridge 工作流'
  const userMessage: ChatMessage = {
    id: makeId(),
    role: 'user',
    content: `运行${runTypeLabel}「${workflowName}」\n\n输入：\n${formatInputs(inputs)}`,
    timestamp: Date.now(),
  }

  const assistantMessageId = makeId()
  const assistantMessage: ChatMessage = {
    id: assistantMessageId,
    role: 'assistant',
    content: `正在运行${runTypeLabel}「${workflowName}」，进度见下方思考过程。`,
    timestamp: Date.now(),
    thinkingProcess: {
      status: 'running',
      executionLog: `开始运行${runTypeLabel}「${workflowName}」...`,
      isExpanded: true,
    },
  }

  useChatStore.setState((s) => ({
    messages: [...s.messages, userMessage, assistantMessage],
  }))

  try {
    await historyApi.saveMessage(conversationId, userMessage)
  } catch (err) {
    console.error('保存工作流运行用户消息失败:', err)
  }

  return {
    conversationId,
    assistantMessageId,
    updateLog: (log: string) => {
      useChatStore.setState((s) => {
        const messages = [...s.messages]
        const idx = messages.findIndex((m) => m.id === assistantMessageId)
        if (idx !== -1 && messages[idx].thinkingProcess) {
          messages[idx] = {
            ...messages[idx],
            thinkingProcess: {
              ...messages[idx].thinkingProcess!,
              executionLog: messages[idx].thinkingProcess!.executionLog + '\n' + log,
            },
          }
        }
        return { messages }
      })
    },
    setStatus: (status: ThinkingProcessData['status']) => {
      useChatStore.setState((s) => {
        const messages = [...s.messages]
        const idx = messages.findIndex((m) => m.id === assistantMessageId)
        if (idx !== -1 && messages[idx].thinkingProcess) {
          messages[idx] = {
            ...messages[idx],
            thinkingProcess: {
              ...messages[idx].thinkingProcess!,
              status,
            },
          }
        }
        return { messages }
      })
    },
    finalize: async (status: 'completed' | 'error', summary: string) => {
      useChatStore.setState((s) => {
        const messages = [...s.messages]
        const idx = messages.findIndex((m) => m.id === assistantMessageId)
        if (idx !== -1) {
          messages[idx] = {
            ...messages[idx],
            content: summary,
            thinkingProcess: {
              ...(messages[idx].thinkingProcess || {
                executionLog: '',
                isExpanded: true,
                status: 'running',
              }),
              status,
              executionLog:
                (messages[idx].thinkingProcess?.executionLog || '') +
                `\n[${status === 'completed' ? '完成' : '失败'}] ${summary}`,
            },
          }
        }
        return { messages }
      })

      const finalMessage = useChatStore.getState().messages.find((m) => m.id === assistantMessageId)
      if (finalMessage) {
        try {
          await historyApi.saveMessage(conversationId, finalMessage)
        } catch (err) {
          console.error('保存工作流运行助手消息失败:', err)
        }
      }
    },
  }
}

export function appendWorkflowRunLog(assistantMessageId: string, log: string): void {
  useChatStore.setState((s) => {
    const messages = [...s.messages]
    const idx = messages.findIndex((m) => m.id === assistantMessageId)
    if (idx !== -1 && messages[idx].thinkingProcess) {
      messages[idx] = {
        ...messages[idx],
        thinkingProcess: {
          ...messages[idx].thinkingProcess!,
          executionLog: messages[idx].thinkingProcess!.executionLog + '\n' + log,
        },
      }
    }
    return { messages }
  })
}

export function finalizeWorkflowRunChatThread(
  assistantMessageId: string,
  status: 'completed' | 'error',
  summary: string
): void {
  useChatStore.setState((s) => {
    const messages = [...s.messages]
    const idx = messages.findIndex((m) => m.id === assistantMessageId)
    if (idx !== -1) {
      messages[idx] = {
        ...messages[idx],
        content: summary,
        thinkingProcess: {
          ...(messages[idx].thinkingProcess || {
            executionLog: '',
            isExpanded: true,
            status: 'running',
          }),
          status,
          executionLog:
            (messages[idx].thinkingProcess?.executionLog || '') +
            `\n[${status === 'completed' ? '完成' : '失败'}] ${summary}`,
        },
      }
    }
    return { messages }
  })
}

// ==================== 工作流输出格式化 ====================

export interface FileDownloadResult {
  downloadUrl: string
  fileName?: string
  expiresIn?: string
}

function isFileDownloadResult(value: unknown): value is FileDownloadResult {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return typeof obj.downloadUrl === 'string'
}

function isArrayOfObjects(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => v && typeof v === 'object')
}

function extractRows(value: unknown): Record<string, unknown>[] | null {
  if (isArrayOfObjects(value)) return value
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  if (isArrayOfObjects(obj.rows)) return obj.rows
  if (isArrayOfObjects(obj.data)) return obj.data
  return null
}

function escapeMarkdownCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function formatRowsToMarkdownTable(rows: Record<string, unknown>[], maxRows = 20): string {
  // 2026-07-24 审计修复：空数组 rows[0] 会解引用 undefined 抛 TypeError。
  if (rows.length === 0) return '（无数据）'
  const columns = Object.keys(rows[0])
  if (columns.length === 0) return '（无列）'

  const header = `| ${columns.map((c) => escapeMarkdownCell(c)).join(' | ')} |`
  const separator = `| ${columns.map(() => '---').join(' | ')} |`
  const dataRows = rows.slice(0, maxRows).map((row) => {
    const cells = columns.map((col) => {
      const val = row[col]
      const text = val === null || val === undefined ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val)
      return escapeMarkdownCell(text)
    })
    return `| ${cells.join(' | ')} |`
  })

  const lines = [header, separator, ...dataRows]
  if (rows.length > maxRows) {
    lines.push(`\n*共 ${rows.length} 行，仅显示前 ${maxRows} 行。*`)
  }
  return lines.join('\n')
}

function formatObjectToMarkdown(obj: Record<string, unknown>, depth = 0): string {
  const indent = '  '.repeat(depth)
  const lines: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      lines.push(`${indent}- **${key}**: （空）`)
    } else if (typeof value === 'object') {
      const rows = extractRows(value)
      if (rows) {
        lines.push(`${indent}- **${key}**:`)
        lines.push(formatRowsToMarkdownTable(rows))
      } else {
        lines.push(`${indent}- **${key}**:`)
        lines.push(formatObjectToMarkdown(value as Record<string, unknown>, depth + 1))
      }
    } else {
      lines.push(`${indent}- **${key}**: ${String(value)}`)
    }
  }
  return lines.join('\n')
}

function formatSingleOutput(key: string, value: unknown): string {
  const title = `### ${key}`

  // 后端 tool 常见包装：{ success, data, error }
  let inner = value
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.success === 'boolean' && 'data' in obj) {
      if (obj.success && obj.data !== null && obj.data !== undefined) {
        inner = obj.data
      } else if (!obj.success && typeof obj.error === 'string') {
        return `${title}\n\n❌ 失败：${obj.error}`
      }
    }
  }

  if (isFileDownloadResult(inner)) {
    const fileName = inner.fileName || inner.downloadUrl.split('/').pop() || '文件'
    const lines = [title, '', `📎 [${fileName}](${inner.downloadUrl})`]
    if (inner.expiresIn) {
      lines.push(`\n有效期：${inner.expiresIn}`)
    }
    return lines.join('\n')
  }

  const rows = extractRows(inner)
  if (rows) {
    return `${title}\n\n${formatRowsToMarkdownTable(rows)}`
  }

  if (inner && typeof inner === 'object') {
    return `${title}\n\n${formatObjectToMarkdown(inner as Record<string, unknown>)}`
  }

  return `${title}\n\n${typeof inner === 'string' ? inner : JSON.stringify(inner)}`
}

/**
 * 将 DAG 工作流输出对象格式化为适合在对话中展示的 Markdown。
 */
export function formatWorkflowOutputsToMarkdown(outputs: Record<string, unknown>): string {
  const sections = Object.entries(outputs).map(([key, value]) => formatSingleOutput(key, value))
  return sections.join('\n\n---\n\n')
}

/**
 * 从 workflow 输出中提取文件下载结果，供同步到工作区。
 */
export function extractFileDownloadResults(outputs: Record<string, unknown>): FileDownloadResult[] {
  const results: FileDownloadResult[] = []
  for (const value of Object.values(outputs)) {
    if (!value || typeof value !== 'object') continue
    const obj = value as Record<string, unknown>
    const target =
      typeof obj.success === 'boolean' && 'data' in obj && obj.data && typeof obj.data === 'object'
        ? (obj.data as Record<string, unknown>)
        : obj
    if (isFileDownloadResult(target)) {
      results.push(target)
    }
  }
  return results
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const dataUrl = reader.result as string
      resolve(dataUrl.split(',')[1] || '')
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

/**
 * 将工作流产生的后端文件同步到 WebBridge 工作区（best effort）。
 */
export async function syncWorkflowFilesToWorkspace(outputs: Record<string, unknown>): Promise<void> {
  if (!webBridgeClient.isConnected) {
    console.log('[WorkflowOutput] WebBridge 未连接，跳过文件同步到工作区')
    return
  }

  const files = extractFileDownloadResults(outputs)
  for (const file of files) {
    try {
      const response = await fetch(file.downloadUrl)
      if (!response.ok) {
        console.warn(`[WorkflowOutput] 下载文件失败: ${file.downloadUrl}, 状态: ${response.status}`)
        continue
      }
      const blob = await response.blob()
      const base64 = await blobToBase64(blob)
      const fileName = file.fileName || file.downloadUrl.split('/').pop() || 'download'
      const relativePath = `downloads/${fileName}`
      await webBridgeClient.writeWorkspaceFile(relativePath, base64)
      console.log(`[WorkflowOutput] 已同步文件到工作区: ${relativePath}`)
    } catch (err) {
      console.warn('[WorkflowOutput] 同步工作流文件到工作区失败:', err)
    }
  }
}
