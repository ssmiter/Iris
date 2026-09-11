import type { ReactNode } from 'react'
import type { ChatMessage } from '@/types/chat'

export type ToolThinkingStatus = 'planning' | 'coding' | 'running' | 'completed' | 'error'

export interface ToolResultRendererProps {
  /** role === 'tool' 的消息 */
  message: ChatMessage
  /** 对应的助手消息，用于获取 toolCall 参数 */
  assistantMessage?: ChatMessage
  /** 工具参数原文（JSON 字符串，ToolNode.args 透传）。
   *  写工具 diff 留痕靠它重建 old/new——结果对象刻意不回传文件内容（防上下文膨胀） */
  argsText?: string
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
  /** 按结果内容条件提升（2026-09-02）：如 agent 工具只对 as_task 派遣回执提升到正文区，
   *  普通后台/同步结果仍留在过程区。与 promoteResult 任一命中即提升。 */
  promoteResultWhen?: (result: unknown) => boolean
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

/** 结果是否应提升到正文区（promoteResult 恒真 / promoteResultWhen 按结果内容判定） */
export function isResultPromoted(toolName: string, result: unknown): boolean {
  const entry = renderRegistry.get(toolName)
  if (!entry) return false
  if (entry.promoteResult === true) return true
  return entry.promoteResultWhen?.(result) === true
}

export function getToolThinkingRenderer(
  toolName: string
): ((props: ToolThinkingRendererProps) => ReactNode) | undefined {
  return renderRegistry.get(toolName)?.thinkingRenderer
}

export function unregisterToolRenderer(toolName: string): void {
  renderRegistry.delete(toolName)
}
