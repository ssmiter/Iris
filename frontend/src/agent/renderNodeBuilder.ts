/**
 * legacyToRenderNodes — 从旧版 ChatMessage 字段反向合成 RenderNode[]
 *
 * 2026-07-31 单轨化：原 createRenderNodeBuilder 闭包实现已退役（双轨开关
 * USE_PROJECTED_BUILDER 硬编码 true，false 分支永不可达），builder 接口的
 * 唯一定义点移至 renderKernel/projectedBuilder.ts。本文件只保留历史消息
 * 兜底合成，用于没有 renderNodes 的旧消息仍能在瀑布 UI 渲染。
 */

import type {
  RenderNode,
  RenderNodeId,
  ThinkingNode,
  ToolNode,
  AnswerNode,
  ProcessNodeStatus,
} from '@/types/chat'
import type { ChatMessage } from '@/types/chat'
import i18n from '@/i18n'

export function legacyToRenderNodes(message: ChatMessage): RenderNode[] {
  const nodes: RenderNode[] = []
  const baseTime = message.timestamp || 0
  let seq = 0

  function id(type: RenderNode['type']): RenderNodeId {
    seq++
    return `legacy:${type}:${seq}`
  }

  // 1. 思考过程 → ThinkingNode
  if (message.reasoningContent) {
    nodes.push({
      id: id('thinking'),
      type: 'thinking',
      status: 'done',
      title: i18n.t('chat.flowNode.kindThinking'),
      content: message.reasoningContent,
      startedAt: baseTime,
      durationMs: message.thinkingDuration,
    } satisfies ThinkingNode)
  } else if (message.thinkingProcess && message.thinkingProcess.executionLog) {
    nodes.push({
      id: id('thinking'),
      type: 'thinking',
      status: 'done',
      title: i18n.t('chat.flowNode.kindThinking'),
      content: message.thinkingProcess.executionLog,
      startedAt: baseTime,
    } satisfies ThinkingNode)
  }

  // 2. 工具调用 → ToolNode[]
  if (message.toolCalls && message.toolCalls.length > 0) {
    for (const tc of message.toolCalls) {
      const status: ProcessNodeStatus =
        message.toolCallStatus === 'calling'
          ? 'running'
          : message.toolCallStatus === 'error'
            ? 'error'
            : message.toolCallStatus === 'cancelled'
              ? 'cancelled'
              : 'done'

      nodes.push({
        id: id('tool'),
        type: 'tool',
        status,
        toolName: tc.function?.name || message.toolCallName || '未知工具',
        args:
          typeof tc.function?.arguments === 'string'
            ? tc.function.arguments
            : undefined,
        summary: message.content?.slice(0, 120) || '',
        startedAt: baseTime,
        result: message.structuredData,
      } satisfies ToolNode)
    }
  }

  // 3. 答案内容 → AnswerNode
  if (message.content && message.role === 'assistant') {
    const status: AnswerNode['status'] =
      message.status === 'error'
        ? 'error'
        : message.status === 'done'
          ? 'done'
          : message.isStreaming
            ? 'streaming'
            : 'done'

    nodes.push({
      id: id('answer'),
      type: 'answer',
      status,
      content: message.content,
      startedAt: baseTime,
    } satisfies AnswerNode)
  }

  return nodes
}
