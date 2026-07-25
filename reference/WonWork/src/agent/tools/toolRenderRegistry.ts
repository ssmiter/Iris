import type { ReactNode } from 'react'
import type { ChatMessage } from '@/types/chat'

export type ToolThinkingStatus = 'planning' | 'coding' | 'running' | 'completed' | 'error'

export interface ToolResultRendererProps {
  /** role === 'tool' 的消息 */
  message: ChatMessage
  /** 对应的助手消息，用于获取 toolCall 参数 */
  assistantMessage?: ChatMessage
}

export interface ToolThinkingRendererProps {
  content: string
  executionLog: string
  status: ToolThinkingStatus
  initialExpanded?: boolean
  toolCallName?: string
}

export interface ToolRendererEntry {
  /** 渲染 tool 结果消息（role === 'tool'） */
  resultRenderer: (props: ToolResultRendererProps) => ReactNode
  /** 渲染 thinking / 执行过程面板，可选 */
  thinkingRenderer?: (props: ToolThinkingRendererProps) => ReactNode
  /** 在新版瀑布流中把结果提升到答案区，适用于需要持续交互的业务卡片。 */
  promoteResult?: boolean
}

const renderRegistry = new Map<string, ToolRendererEntry>()

/**
 * 为指定工具注册专属渲染器。
 * 未注册的工具将回退到通用 ToolCallCard / ThinkingProcess 逻辑。
 */
export function registerToolRenderer(
  toolName: string,
  entry: ToolRendererEntry
): void {
  renderRegistry.set(toolName, entry)
}

export function getToolRenderer(toolName: string): ToolRendererEntry | undefined {
  return renderRegistry.get(toolName)
}

export function getToolResultRenderer(
  toolName: string
): ((props: ToolResultRendererProps) => ReactNode) | undefined {
  return renderRegistry.get(toolName)?.resultRenderer
}

export function getToolThinkingRenderer(
  toolName: string
): ((props: ToolThinkingRendererProps) => ReactNode) | undefined {
  return renderRegistry.get(toolName)?.thinkingRenderer
}

export function unregisterToolRenderer(toolName: string): void {
  renderRegistry.delete(toolName)
}
