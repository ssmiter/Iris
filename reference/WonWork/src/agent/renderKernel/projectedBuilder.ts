/**
 * projectedBuilder — 事件驱动 RenderNodeBuilder
 *
 * 实现与 createRenderNodeBuilder() 完全相同的 RenderNodeBuilder 接口，
 * 但内部所有节点变更都通过 EventLog.append() 记录事件，
 * nodes 通过 TurnProjector.project() 纯函数投影得到。
 *
 * 这是 Phase 1 的兼容层——agenticLoop.ts 只需切换 builder 工厂即可获得
 * 事件溯源能力，其他代码零改动。
 *
 * 设计依据：wonwork-waterfall-final-state-plan-2026-07-18.md §四 Phase 1
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
import type { RenderNodeBuilder } from '@/agent/renderNodeBuilder'
import { EventLog } from './eventLog'
import { eventFactory, type RenderEvent } from './renderEvent'
import { project, type TurnState } from './turnProjector'
import { plan, applyOps, type RenderOp } from './batchPlanner'

// ── helpers ──────────────────────────────────────────────

function now(): number {
  return Date.now()
}

// ── projected builder ────────────────────────────────────

export type ProjectedBuilder = RenderNodeBuilder & {
  eventLog: EventLog
  drainNewEvents(): RenderEvent[]
  drainOps(prevNodes: RenderNode[]): { ops: RenderOp[]; nodes: RenderNode[] }
  /** R1: 回滚到 checkpoint + 同步内部消费状态（_drainMarker / 索引 / 标志位） */
  rewindTo(checkpoint: number): RenderNode[]
  /** 暴露完整 TurnState 供 agenticLoop 写入 ChatMessage */
  getState(): TurnState
  /** 后补并行组 ID */
  setToolGroupId(toolCallId: string, groupId: string): void
  /** v4.0: 开始新轮次 */
  startRound(roundIndex: number): void
  /** v4.0: 结束当前轮次 */
  settleRound(): void
}

export function createProjectedBuilder(turnId?: string): ProjectedBuilder {
  const _turnId = turnId || ''
  const eventLog = new EventLog(_turnId)

  // 节点 ID 生成计数器
  let _nextId = 0
  function nextId(): number {
    _nextId++
    return _nextId
  }

  // 内部状态（事件无法表达的实时状态）
  let _thinkingActive = false
  let _thinkingNodeId: RenderNodeId | null = null
  let _verifyActive = false
  let _verifyNodeId: RenderNodeId | null = null
  const _toolNodeIds = new Map<string, RenderNodeId>() // toolCallId → nodeId
  const _toolStatus = new Map<string, ProcessNodeStatus>() // toolCallId → status
  let _attentionNodeId: RenderNodeId | null = null
  let _attentionWaiting = false
  // 多 attention 并存：按 toolCallId 索引 attention 节点 ID
  const _attentionByToolCallId = new Map<string, RenderNodeId>()
  let _answerStarted = false
  let _answerDone = false
  let _answerError = false
  let _answerStopped = false
  /** v4.0: 当前轮次索引（由 startRound 设置） */
  let _currentRoundIndex = 0

  // Phase 2：增量 drain marker（已消费的事件数）
  let _drainMarker = 0

  // R4: 投影缓存——EventLog 仅追加（除 rewind），缓存上次投影结果避免 O(N²) 重放
  let _projectedCache: { length: number; state: TurnState } | null = null

  // ── 投影辅助 ──

  function projected(): TurnState {
    const len = eventLog.length
    if (_projectedCache && _projectedCache.length === len) {
      return _projectedCache.state
    }
    const state = project(eventLog.events)
    _projectedCache = { length: len, state }
    return state
  }

  function findNode<T extends RenderNode>(predicate: (n: RenderNode) => n is T): T | null {
    const state = projected()
    return state.nodes.find(predicate) as T | null
  }

  function findThinking(): ThinkingNode | null {
    return findNode((n): n is ThinkingNode => n.type === 'thinking') ?? null
  }

  function findAnswer(): AnswerNode | null {
    // v4.0: 多轮每轮独立 AnswerNode——取最后一个（当前活跃轮次）
    const state = projected()
    for (let i = state.nodes.length - 1; i >= 0; i--) {
      if (state.nodes[i].type === 'answer') return state.nodes[i] as AnswerNode
    }
    return null
  }

  // 工具节点通过 toolCallId 查找（投影结果中 toolCallId 在 id 字段内）
  function findToolByCallId(toolCallId: string): ToolNode | null {
    return findNode(
      (n): n is ToolNode => n.type === 'tool' && n.id.includes(`:${toolCallId}:`)
    ) ?? null
  }

  function findAttention(): AttentionNode | null {
    return findNode((n): n is AttentionNode => n.type === 'attention') ?? null
  }

  // ── builder ──────────────────────────────────────────────

  const builder: ProjectedBuilder = {
    eventLog,

    /** 返回自上次 drain 后新增的事件（Phase 2 增量渲染） */
    drainNewEvents(): RenderEvent[] {
      const all = eventLog.events
      const newEvents = all.slice(_drainMarker)
      _drainMarker = all.length
      return [...newEvents]
    },

    /** 增量入口：drain 新事件 → plan → applyOps → 返回 {ops, 新节点数组}（Phase 2） */
    drainOps(prevNodes: RenderNode[]): { ops: RenderOp[]; nodes: RenderNode[] } {
      const newEvents = this.drainNewEvents()
      if (newEvents.length === 0) return { ops: [], nodes: [...prevNodes] }
      const fullNodes = projected().nodes  // R4: 走投影缓存
      const ops = plan(newEvents, prevNodes, fullNodes)
      const nodes = applyOps(prevNodes, ops)
      return { ops, nodes }
    },

    get nodes(): RenderNode[] {
      return projected().nodes  // R4: 走投影缓存
    },

    /** 暴露完整 TurnState 供 agenticLoop 写入 ChatMessage（终态统计） */
    getState(): TurnState {
      return projected()
    },

    get thinkingNode(): ThinkingNode | null {
      if (!_thinkingActive) return null
      return findThinking()
    },

    get answerNode(): AnswerNode | null {
      if (!_answerStarted || _answerDone || _answerError || _answerStopped) return null
      return findAnswer()
    },

    // ── Thinking ──────────────────────────────────

    startThinking(): ThinkingNode {
      if (_thinkingActive) {
        return findThinking()!
      }
      _thinkingActive = true
      const id = `${_turnId}:thinking:${nextId()}`
      _thinkingNodeId = id
      eventLog.append(eventFactory.nodeStart({ kind: 'thinking', id }))
      return findThinking()!
    },

    appendThinking(text: string): void {
      if (!_thinkingActive || !_thinkingNodeId) {
        this.startThinking()
      }
      if (_thinkingNodeId) {
        eventLog.append(eventFactory.nodeDelta(_thinkingNodeId, { text }))
      }
    },

    finishThinking(): void {
      if (!_thinkingActive) return
      // BUG-09: 按 _thinkingNodeId 查找而非取第一个 thinking 节点（多轮思考时防错配）
      const state = projected()
      const node = _thinkingNodeId
        ? (state.nodes.find((n) => n.id === _thinkingNodeId) as ThinkingNode | undefined)
        : findThinking()
      const startedAt = node?.startedAt ?? 0
      const durationMs = startedAt ? now() - startedAt : undefined
      if (_thinkingNodeId) {
        eventLog.append(eventFactory.nodeDone(_thinkingNodeId, { durationMs }))
      }
      _thinkingActive = false
      _thinkingNodeId = null
    },

    // ── Verify ────────────────────────────────────

    startVerify(): ThinkingNode {
      if (_verifyActive) {
        return findNode((n): n is ThinkingNode => n.type === 'thinking' && n.role === 'verify')!
      }
      _verifyActive = true
      const id = `${_turnId}:thinking:${nextId()}`
      _verifyNodeId = id
      eventLog.append(eventFactory.nodeStart({ kind: 'verify', id }))
      return findNode((n): n is ThinkingNode => n.type === 'thinking' && n.role === 'verify')!
    },

    appendVerify(text: string): void {
      if (!_verifyActive || !_verifyNodeId) {
        this.startVerify()
      }
      if (_verifyNodeId) {
        eventLog.append(eventFactory.nodeDelta(_verifyNodeId, { text }))
      }
    },

    finishVerify(): void {
      if (!_verifyActive) return
      // BUG-09: 按 _verifyNodeId 查找而非取第一个 verify 节点
      const state = projected()
      const node = _verifyNodeId
        ? (state.nodes.find((n) => n.id === _verifyNodeId) as ThinkingNode | undefined)
        : findNode((n): n is ThinkingNode => n.type === 'thinking' && n.role === 'verify')
      const startedAt = node?.startedAt ?? 0
      const durationMs = startedAt ? now() - startedAt : undefined
      if (_verifyNodeId) {
        eventLog.append(eventFactory.nodeDone(_verifyNodeId, { durationMs }))
      }
      _verifyActive = false
      _verifyNodeId = null
    },

    // ── Tool ──────────────────────────────────────

    startTool(toolCallId: string, toolName: string, args?: string, groupId?: string): ToolNode {
      const existingId = _toolNodeIds.get(toolCallId)
      if (existingId) {
        // BUG-08: 流式工具参数更新——同一 toolCallId 再次调用时更新 args
        const existing = findToolByCallId(toolCallId)
        if (existing && args !== undefined && args !== (existing as ToolNode).args) {
          eventLog.append(eventFactory.nodeDelta(existingId, { args }))
        }
        return existing!
      }
      const id = `${_turnId}:tool:${toolCallId}:${nextId()}`
      _toolNodeIds.set(toolCallId, id)
      _toolStatus.set(toolCallId, 'running')
      eventLog.append(
        eventFactory.nodeStart({
          kind: 'tool',
          id,
          toolName,
          toolCallId,
          args,
          label: toolName,
          groupId,
        })
      )
      return findToolByCallId(toolCallId)!
    },

    /** 后补并行组 ID（agenticLoop 在 handleStreamDone 时对已启动工具统一写入） */
    setToolGroupId(toolCallId: string, groupId: string): void {
      const nodeId = _toolNodeIds.get(toolCallId)
      if (!nodeId) return
      eventLog.append(eventFactory.nodeDelta(nodeId, { groupId }))
    },

    transitionToolToRunning(_toolCallId: string): void {
      // Projected model: tools are created as 'running' directly (skip queued).
      // No event needed — the projector handles this implicitly.
    },

    appendToolLog(toolCallId: string, log: string): void {
      const nodeId = _toolNodeIds.get(toolCallId)
      if (!nodeId) return
      eventLog.append(eventFactory.nodeDelta(nodeId, { log }))
    },

    finishTool(
      toolCallId: string,
      result: { success: boolean; summary: string; result?: unknown }
    ): void {
      const nodeId = _toolNodeIds.get(toolCallId)
      if (!nodeId) return
      const node = findToolByCallId(toolCallId)
      const startedAt = node?.startedAt ?? 0
      const durationMs = startedAt ? now() - startedAt : undefined
      eventLog.append(
        eventFactory.nodeDone(nodeId, {
          success: result.success,
          summary: result.summary,
          result: result.result,
          durationMs,
        })
      )
      _toolStatus.set(toolCallId, result.success ? 'done' : 'error')
    },

    errorTool(toolCallId: string, error: string): void {
      const nodeId = _toolNodeIds.get(toolCallId)
      if (!nodeId) return
      eventLog.append(eventFactory.nodeError(nodeId, { message: error }))
      _toolStatus.set(toolCallId, 'error')
    },

    cancelTool(toolCallId: string): void {
      const nodeId = _toolNodeIds.get(toolCallId)
      if (!nodeId) return
      // BUG-21: cancelled: true 确保 projector 映射为 'cancelled' 而非 'done'
      eventLog.append(
        eventFactory.nodeDone(nodeId, {
          summary: '用户已中断',
          cancelled: true,
        })
      )
      _toolStatus.set(toolCallId, 'cancelled')
    },

    // ── Attention ─────────────────────────────────

    requestAttention(
      reason: string,
      subtype?: AttentionSubtype,
      toolName?: string,
      prompt?: string,
      options?: string[],
      toolCallId?: string
    ): AttentionNode {
      // 多 attention 并存：不再自动关闭上一个 waiting attention
      const id = `${_turnId}:attention:${nextId()}`
      _attentionNodeId = id
      _attentionWaiting = true
      if (toolCallId) {
        _attentionByToolCallId.set(toolCallId, id)
      }
      eventLog.append(
        eventFactory.attentionRequest({
          id,
          subtype,
          reason,
          toolName,
          prompt,
          options,
          toolCallId,
        })
      )
      // 返回刚创建的节点（而非 findAttention 取到的第一个 waiting）
      const state = projected()
      return (state.nodes.find((n) => n.id === id) as AttentionNode | undefined) ?? findAttention()!
    },

    resolveAttention(resolved: boolean, value?: string, nodeId?: string): void {
      // 三阶段寻址：nodeId > toolCallId > 最新 waiting
      let targetId: RenderNodeId | undefined = nodeId
      if (!targetId) {
        targetId = _attentionNodeId ?? undefined
      }
      if (!targetId) return

      // nodeId 可能传的是 toolCallId（后端 approval_result 路径）：先按 nodeId 找 attention，
      // 找不到再按 toolCallId 映射到 attention nodeId
      const state = projected()
      const isAttentionNodeId = state.nodes.some(
        (n) => n.id === targetId && n.type === 'attention'
      )
      if (!isAttentionNodeId) {
        const mapped = _attentionByToolCallId.get(targetId)
        if (mapped) {
          targetId = mapped
        }
      }

      eventLog.append(
        eventFactory.attentionResolve(
          targetId,
          resolved ? 'resolved' : 'skipped',
          value
        )
      )
      // 清理对应索引
      for (const [tcId, attnId] of _attentionByToolCallId) {
        if (attnId === targetId) {
          _attentionByToolCallId.delete(tcId)
          break
        }
      }
      if (targetId === _attentionNodeId) {
        _attentionWaiting = false
      }
    },

    // ── Artifact ──────────────────────────────────

    addArtifact(
      artifactType: ArtifactType,
      title: string,
      payload: unknown,
      sourceToolCallId?: string
    ): ArtifactNode {
      eventLog.append(
        eventFactory.artifactPresent(
          {
            artifactType,
            title,
            payload,
            sourceToolCallId,
          },
          _currentRoundIndex
        )
      )
      return findNode((n): n is ArtifactNode => n.type === 'artifact')!
    },

    // ── Answer（v4.0: 每轮独立 AnswerNode，roundIndex 由 builder 维护） ──

    startAnswer(): AnswerNode {
      if (_answerStarted) return findAnswer()!
      _answerStarted = true
      // v4.0: answer 节点由 projector 在首条 answer.delta 时懒创建，
      // node.start answer 事件为 no-op（projector 忽略），此处保留以兼容旧逻辑
      eventLog.append(eventFactory.nodeStart({ kind: 'answer' }))
      return findAnswer()!
    },

    appendAnswer(text: string): void {
      // v4.0: 直接发 answerDelta 带 roundIndex，projector 按 roundIndex 定位/创建 AnswerNode
      eventLog.append(eventFactory.answerDelta(_currentRoundIndex, text))
      _answerStarted = true
    },

    finishAnswer(): void {
      _answerDone = true
      eventLog.append(eventFactory.answerDone(_currentRoundIndex))
    },

    errorAnswer(errorMessage: string): void {
      _answerError = true
      eventLog.append(eventFactory.answerError(_currentRoundIndex, { message: errorMessage }))
    },

    stopAnswer(): void {
      _answerStopped = true
      // 仅停止当前 answer，不取消整个 turn
      eventLog.append(eventFactory.answerAbort(_currentRoundIndex))
    },

    // ── v4.0 Round 生命周期 ──

    /** 开始新轮次：发 round.start 事件，重置 per-round 标志 */
    startRound(roundIndex: number): void {
      _currentRoundIndex = roundIndex
      eventLog.append(eventFactory.roundStart(roundIndex))
      // 重置 per-round answer 标志（新 round = 新 answer 段）
      _answerStarted = false
      _answerDone = false
      _answerError = false
      _answerStopped = false
    },

    /** 结束当前轮次：发 round.settle 事件，关闭该轮 answer（如仍 streaming） */
    settleRound(): void {
      if (_currentRoundIndex <= 0) return
      if (_answerStarted && !_answerDone && !_answerError && !_answerStopped) {
        eventLog.append(eventFactory.answerDone(_currentRoundIndex))
        _answerDone = true
      }
      eventLog.append(eventFactory.roundSettle(_currentRoundIndex))
    },

    // ── Lifecycle ─────────────────────────────────

    /** R1 (N-01): 回滚到 checkpoint，同步 _drainMarker + 内部索引，返回 checkpoint 节点数组 */
    rewindTo(checkpoint: number): RenderNode[] {
      eventLog.rewindTo(checkpoint)
      _drainMarker = eventLog.length
      _projectedCache = null  // R4: 重放后使投影缓存失效
      // 从 checkpoint 全量投影，重建内部状态
      const state = project(eventLog.events)
      // 重建工具索引
      _toolNodeIds.clear()
      _toolStatus.clear()
      for (const n of state.nodes) {
        if (n.type === 'tool') {
          // 从 id 中提取 toolCallId（格式：turnId:tool:toolCallId:seq）
          const parts = n.id.split(':')
          const tcId = parts.length >= 3 ? parts[parts.length - 2] : ''
          if (tcId) {
            _toolNodeIds.set(tcId, n.id)
            _toolStatus.set(tcId, n.status as ProcessNodeStatus)
          }
        }
      }
      // 重建 attention 状态
      _attentionWaiting = state.nodes.some(
        (n) => n.type === 'attention' && n.status === 'waiting'
      )
      if (_attentionWaiting) {
        const attn = state.nodes.find(
          (n): n is AttentionNode => n.type === 'attention' && n.status === 'waiting'
        )
        _attentionNodeId = attn?.id ?? null
      }
      // 重建 answer 状态
      _answerStarted = state.nodes.some((n) => n.type === 'answer')
      _answerDone = state.answerStatus === 'done'
      _answerError = state.answerStatus === 'error'
      _answerStopped = state.answerStatus === 'stopped'
      // v4.0: 从 rounds 重建当前轮次索引
      _currentRoundIndex = state.rounds.length > 0 ? state.rounds[state.rounds.length - 1].index : 0
      // 重建 thinking 状态（checkpoint 后通常没有活跃 thinking）
      _thinkingActive = false
      _thinkingNodeId = null
      _verifyActive = false
      _verifyNodeId = null
      return [...state.nodes]
    },

    settle(): void {
      // v4.0: 先闭幕当前轮次
      this.settleRound()
      // 闭幕前先完成可能仍在运行的 thinking/answer
      if (_thinkingActive && _thinkingNodeId) {
        // BUG-09: 按 ID 查找节点
        const state = projected()
        const node = state.nodes.find((n) => n.id === _thinkingNodeId) as ThinkingNode | undefined
        const startedAt = node?.startedAt ?? 0
        const durationMs = startedAt ? now() - startedAt : undefined
        eventLog.append(eventFactory.nodeDone(_thinkingNodeId, { durationMs }))
        _thinkingActive = false
        _thinkingNodeId = null
      }
      if (_verifyActive && _verifyNodeId) {
        // BUG-09: 按 ID 查找节点
        const state = projected()
        const node = state.nodes.find((n) => n.id === _verifyNodeId) as ThinkingNode | undefined
        const startedAt = node?.startedAt ?? 0
        const durationMs = startedAt ? now() - startedAt : undefined
        eventLog.append(eventFactory.nodeDone(_verifyNodeId, { durationMs }))
        _verifyActive = false
        _verifyNodeId = null
      }
      // BUG-07: 闭幕前关闭未解决的 attention（轮次结束未处理）
      if (_attentionWaiting && _attentionNodeId) {
        eventLog.append(eventFactory.attentionResolve(_attentionNodeId, 'skipped'))
        _attentionWaiting = false
      }
      // v4.0: answer 已在 settleRound() 中关闭，此处不再重复
      eventLog.append(eventFactory.turnSettle())
    },
  }

  return builder
}
