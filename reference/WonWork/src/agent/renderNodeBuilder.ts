/**
 * renderNodeBuilder — 连接 agenticLoop 内核事件与 RenderNode 渲染层
 *
 * 职责：
 * 1. 维护一个 turn 内的 RenderNode[] 有序列表
 * 2. 幂等创建/更新节点（同一 toolCallId → 同一 ToolNode）
 * 3. settle() 时把所有 running→done/error 的节点闭幕
 * 4. legacyToRenderNodes() 从旧 ChatMessage 字段反向合成 RenderNode
 *
 * 不负责：
 * - UI 渲染（由 WaterfallTurn / FlowNode 负责）
 * - 持久化（节点数组序列化在 ChatMessage.renderNodes 中，由 chatStore 负责）
 */

import type {
  RenderNode,
  RenderNodeId,
  ThinkingNode,
  ToolNode,
  AttentionNode,
  ArtifactNode,
  AnswerNode,
  ProcessNodeStatus,
  AttentionSubtype,
  ArtifactType,
} from '@/types/chat'
import type { ChatMessage } from '@/types/chat'
import type { ToolCall } from '@/types/mescli'

// ── helpers ──────────────────────────────────────────────

function now(): number {
  return Date.now()
}

// ── builder ──────────────────────────────────────────────

export interface RenderNodeBuilder {
  /** 当前 turn 的所有节点（有序） */
  readonly nodes: RenderNode[]

  // Thinking
  startThinking(): ThinkingNode
  appendThinking(text: string): void
  finishThinking(): void

  // Verify（ThinkingNode role='verify' 变体）
  startVerify(): ThinkingNode
  appendVerify(text: string): void
  finishVerify(): void

  // Tool
  startTool(toolCallId: string, toolName: string, args?: string): ToolNode
  /** 工具从 queued 转入 running */
  transitionToolToRunning(toolCallId: string): void
  appendToolLog(toolCallId: string, log: string): void
  finishTool(toolCallId: string, result: { success: boolean; summary: string; result?: unknown }): void
  errorTool(toolCallId: string, error: string): void
  cancelTool(toolCallId: string): void

  // Attention
  requestAttention(reason: string, subtype?: AttentionSubtype, toolName?: string, prompt?: string, options?: string[], toolCallId?: string): AttentionNode
  resolveAttention(resolved: boolean, _value?: string, _nodeId?: string): void

  // Artifact
  addArtifact(artifactType: ArtifactType, title: string, payload: unknown, sourceToolCallId?: string): ArtifactNode

  // Answer
  startAnswer(): AnswerNode
  appendAnswer(text: string): void
  finishAnswer(): void
  errorAnswer(errorMessage: string): void
  /** 用户主动停止生成 → answer status='stopped' */
  stopAnswer(): void

  // Lifecycle
  /** 闭幕所有 running 节点，计算 durationMs */
  settle(): void

  /** 获取当前正在运行的思考节点（如果有） */
  readonly thinkingNode: ThinkingNode | null
  /** 获取当前正在运行的答案节点（如果有） */
  readonly answerNode: AnswerNode | null
}

export function createRenderNodeBuilder(turnId?: string): RenderNodeBuilder {
  // 将全局状态移入闭包，避免并发污染
  let seqCounter = 0
  const _turnId = turnId || ''

  function nextSeq(): number {
    seqCounter++
    return seqCounter
  }

  function makeId(type: RenderNode['type'], toolCallId?: string): RenderNodeId {
    const prefix = _turnId ? `${_turnId}:` : ''
    if (toolCallId) return `${prefix}${type}:${toolCallId}:${nextSeq()}`
    return `${prefix}${type}:${nextSeq()}`
  }

  function makeArtifactId(): string {
    const prefix = _turnId ? `${_turnId}:` : ''
    return `${prefix}artifact:${nextSeq()}`
  }

  const _nodes: RenderNode[] = []
  let _thinkingNode: ThinkingNode | null = null
  let _answerNode: AnswerNode | null = null
  let _attentionNode: AttentionNode | null = null

  // toolCallId → ToolNode 索引，保证幂等更新
  const _toolIndex = new Map<string, ToolNode>()

  function replaceNode(node: RenderNode): void {
    const idx = _nodes.findIndex((n) => n.id === node.id)
    if (idx >= 0) {
      _nodes[idx] = node
    }
  }

  const builder: RenderNodeBuilder = {
    get nodes(): RenderNode[] {
      return _nodes
    },

    get thinkingNode(): ThinkingNode | null {
      return _thinkingNode
    },

    get answerNode(): AnswerNode | null {
      return _answerNode
    },

    // ── Thinking ──────────────────────────────────

    startThinking(): ThinkingNode {
      if (_thinkingNode) return _thinkingNode
      const node: ThinkingNode = {
        id: makeId('thinking'),
        type: 'thinking',
        status: 'running',
        title: '思考中…',
        content: '',
        startedAt: now(),
      }
      _thinkingNode = node
      _nodes.push(node)
      return node
    },

    appendThinking(text: string): void {
      if (!_thinkingNode) {
        this.startThinking()
      }
      if (_thinkingNode) {
        _thinkingNode.content += text
      }
    },

    finishThinking(): void {
      if (!_thinkingNode) return
      _thinkingNode.status = 'done'
      _thinkingNode.title = '思考'
      _thinkingNode.durationMs = now() - _thinkingNode.startedAt
      replaceNode(_thinkingNode)
      _thinkingNode = null
    },

    // ── Tool ──────────────────────────────────────

    startTool(toolCallId: string, toolName: string, args?: string): ToolNode {
      // 幂等：已存在则返回已有节点
      const existing = _toolIndex.get(toolCallId)
      if (existing) return existing

      const node: ToolNode = {
        id: makeId('tool', toolCallId),
        type: 'tool',
        status: 'queued',
        toolName,
        args,
        summary: '',
        startedAt: now(),
      }
      _toolIndex.set(toolCallId, node)
      _nodes.push(node)
      return node
    },

    transitionToolToRunning(toolCallId: string): void {
      const node = _toolIndex.get(toolCallId)
      if (!node || node.status !== 'queued') return
      node.status = 'running'
      replaceNode(node)
    },

    appendToolLog(toolCallId: string, log: string): void {
      const node = _toolIndex.get(toolCallId)
      if (!node) return
      node.executionLog = (node.executionLog || '') + log
    },

    finishTool(
      toolCallId: string,
      result: { success: boolean; summary: string; result?: unknown }
    ): void {
      const node = _toolIndex.get(toolCallId)
      if (!node) return
      node.status = result.success ? 'done' : 'error'
      node.summary = result.summary
      if (result.result !== undefined) {
        node.result = result.result
      }
      node.durationMs = now() - node.startedAt
      replaceNode(node)
    },

    errorTool(toolCallId: string, error: string): void {
      const node = _toolIndex.get(toolCallId)
      if (!node) return
      node.status = 'error'
      node.summary = error
      node.durationMs = now() - node.startedAt
      replaceNode(node)
    },

    cancelTool(toolCallId: string): void {
      const node = _toolIndex.get(toolCallId)
      if (!node) return
      node.status = 'cancelled'
      node.summary = '用户已中断'
      node.durationMs = now() - node.startedAt
      replaceNode(node)
    },

    // ── Attention ─────────────────────────────────

    requestAttention(reason: string, subtype?: AttentionSubtype, toolName?: string, prompt?: string, options?: string[], toolCallId?: string): AttentionNode {
      // 如果已有 attention 节点未解决，先关闭旧的
      if (_attentionNode && _attentionNode.status === 'waiting') {
        _attentionNode.status = 'skipped'
        replaceNode(_attentionNode)
      }

      const node: AttentionNode = {
        id: makeId('attention'),
        type: 'attention',
        status: 'waiting',
        subtype,
        reason,
        toolName,
        prompt,
        options,
        toolCallId,
        startedAt: now(),
      }
      _attentionNode = node
      _nodes.push(node)
      return node
    },

    resolveAttention(resolved: boolean, _value?: string, _nodeId?: string): void {
      if (!_attentionNode) return
      _attentionNode.status = resolved ? 'resolved' : 'skipped'
      _attentionNode.durationMs = now() - _attentionNode.startedAt
      replaceNode(_attentionNode)
      _attentionNode = null
    },

    // ── Artifact ──────────────────────────────────

    addArtifact(artifactType: ArtifactType, title: string, payload: unknown, sourceToolCallId?: string): ArtifactNode {
      const node: ArtifactNode = {
        id: makeId('artifact'),
        type: 'artifact',
        artifactType,
        title,
        artifactId: makeArtifactId(),
        sourceToolCallId,
        payload,
        startedAt: now(),
      }
      _nodes.push(node)
      return node
    },

    // ── Answer ────────────────────────────────────

    startAnswer(): AnswerNode {
      if (_answerNode) return _answerNode
      const node: AnswerNode = {
        id: makeId('answer'),
        type: 'answer',
        status: 'streaming',
        content: '',
        startedAt: now(),
      }
      _answerNode = node
      _nodes.push(node)
      return node
    },

    appendAnswer(text: string): void {
      if (!_answerNode) {
        this.startAnswer()
      }
      if (_answerNode) {
        _answerNode.content += text
      }
    },

    finishAnswer(): void {
      if (!_answerNode) return
      _answerNode.status = 'done'
      replaceNode(_answerNode)
    },

    errorAnswer(errorMessage: string): void {
      // 错误可能先于任何 answerDelta 到达（如代理层配置错误）——兜底创建 answer 节点承载错误文本
      if (!_answerNode) {
        this.startAnswer()
      }
      if (_answerNode) {
        _answerNode.status = 'error'
        _answerNode.content += _answerNode.content ? `\n\n[错误] ${errorMessage}` : `[错误] ${errorMessage}`
        replaceNode(_answerNode)
      }
    },

    stopAnswer(): void {
      if (_answerNode && _answerNode.status === 'streaming') {
        _answerNode.status = 'stopped'
        replaceNode(_answerNode)
      }
    },

    // ── Verify（思考的变体，role='verify'） ──────

    startVerify(): ThinkingNode {
      const node: ThinkingNode = {
        id: makeId('thinking'),
        type: 'thinking',
        status: 'running',
        role: 'verify',
        title: '验证中…',
        content: '',
        startedAt: now(),
      }
      _nodes.push(node)
      return node
    },

    appendVerify(text: string): void {
      // verify 内容追加到最近的 verify 节点或新建
      const lastVerify = [..._nodes].reverse().find(
        (n): n is ThinkingNode => n.type === 'thinking' && n.role === 'verify'
      )
      if (lastVerify && lastVerify.status === 'running') {
        lastVerify.content += text
        replaceNode(lastVerify)
      } else {
        const node = this.startVerify()
        node.content = text
        replaceNode(node)
      }
    },

    finishVerify(): void {
      const verifyNode = [..._nodes].reverse().find(
        (n): n is ThinkingNode => n.type === 'thinking' && n.role === 'verify' && n.status === 'running'
      )
      if (verifyNode) {
        verifyNode.status = 'done'
        verifyNode.title = '验证'
        verifyNode.durationMs = now() - verifyNode.startedAt
        replaceNode(verifyNode)
      }
    },

    // ── Settle ────────────────────────────────────

    settle(): void {
      const settledAt = now()
      for (let i = 0; i < _nodes.length; i++) {
        const node = _nodes[i]
        if (node.type === 'answer') {
          if (node.status === 'streaming') {
            node.status = 'done'
            _nodes[i] = node
          }
          // stopped 保持 stopped，不覆盖
        }
        if (node.type === 'thinking' || node.type === 'tool') {
          if (node.status === 'running' || node.status === 'queued') {
            node.status = 'done'
            node.durationMs = settledAt - node.startedAt
            _nodes[i] = node
          }
        }
      }
    },
  }

  return builder
}

// ── Legacy fallback ───────────────────────────────────────

/**
 * 从旧版 ChatMessage 字段反向合成 RenderNode[]。
 * 用于没有 renderNodes 的历史消息，保证瀑布 UI 仍能渲染。
 */
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
      title: '思考',
      content: message.reasoningContent,
      startedAt: baseTime,
      durationMs: message.thinkingDuration,
    } satisfies ThinkingNode)
  } else if (message.thinkingProcess && message.thinkingProcess.executionLog) {
    nodes.push({
      id: id('thinking'),
      type: 'thinking',
      status:
        message.thinkingProcess.status === 'error'
          ? 'done'
          : 'done',
      title: '思考',
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

  // 3. 结构化数据中的可视化产物 → ArtifactNode
  // v4.0: 暂停自动产物分类，仅通过 present_artifact 工具显式呈现
  // if (message.structuredData) {
  //   const artifactType = classifyArtifactType(message.structuredData)
  //   if (artifactType && message.toolCallName !== 'present_artifact') {
  //     nodes.push({
  //       id: id('artifact'),
  //       type: 'artifact',
  //       artifactType,
  //       artifactId: `legacy:artifact:${seq}`,
  //       title: message.toolCallName || '数据产物',
  //       payload: message.structuredData,
  //       startedAt: baseTime,
  //     } satisfies ArtifactNode)
  //   }
  // }

  // 4. 答案内容 → AnswerNode
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

// v4.0: 暂停自动产物分类，仅通过 present_artifact 工具显式呈现
// /** 判断结构化数据是否适合提升为产物卡。 */
// function classifyArtifactType(data: unknown): ArtifactType | null {
//   if (!data || typeof data !== 'object') return null
//   const obj = data as Record<string, unknown>
//   if (obj.chartType || obj.type === 'chart') return 'chart'
//   return null
// }
