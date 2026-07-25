/**
 * turnProjector — 纯函数：折叠 RenderEvent[] → TurnState
 *
 * 这是渲染内核的核心决策层。输入事件日志，输出完整的 RenderNode 树 +
 * segFlowed 数组 + answer 状态。所有计算无副作用、无外部状态、可快照可单测。
 *
 * 设计依据：wonwork-render-kernel-design-v2.0.md §5.1
 */

import type {
  RenderNode,
  RenderNodeId,
  ThinkingNode,
  ToolNode,
  AttentionNode,
  ArtifactNode,
  AnswerNode,
  SupplementRecord,
  RoundState,
  RoundStats,
  TurnStats,
} from '@/types/chat'
import type { RenderEvent, NodeDoneMeta, ErrorInfo } from './renderEvent'

// ── TurnState ─────────────────────────────────────────────

export interface TurnState {
  turnId: string
  phase: 'active' | 'settled' | 'stopped' | 'failed'
  nodes: RenderNode[]
  /** segFlowed[i] 为 true 当 nodes[i-1] 已终态（done/error/cancelled） */
  segFlowed: boolean[]
  /** v4.0: 多轮摘要 answer 内容（保留旧字段兼容，取最后一轮的 answer） */
  answerContent: string
  answerStatus: 'idle' | 'streaming' | 'done' | 'error' | 'stopped'
  /** 过程中用户补充记录（§7 SupplementGateway） */
  supplements: SupplementRecord[]
  /** 内核统计——在 project() 末尾一次性算出，组件只读不算 */
  stats: TurnStats
  /** v4.0: 按轮次排列的投影状态 */
  rounds: RoundState[]
  /** v4.0: 所有轮次的 answer 文本（按序） */
  answers: string[]
}

// ── 内部投影状态 ──────────────────────────────────────────

interface ProjectionCtx {
  turnId: string
  nodes: RenderNode[]
  nodeMap: Map<RenderNodeId, RenderNode>
  toolIndex: Map<string, ToolNode>
  /** v4.0: 当前轮次索引 */
  currentRoundIndex: number
  /** v4.0: 每轮 answer 文本累积器 */
  roundAnswerText: Map<number, string>
  /** v4.0: 每轮节点 ID 集合 */
  roundNodeIds: Map<number, RenderNodeId[]>
  /** v4.0: 每轮 answer 节点 ID */
  roundAnswerNodeId: Map<number, RenderNodeId>
  /** v4.0: 每轮 phase */
  roundPhases: Map<number, RoundState['phase']>
  /** 扁平 answer 兼容（取最后一轮） */
  answerContent: string
  answerStatus: TurnState['answerStatus']
  phase: TurnState['phase']
  supplements: SupplementRecord[]
  stats: TurnStats
}

function emptyRoundStats(): RoundStats {
  return { thinkingCount: 0, thinkingMs: 0, toolCount: 0, toolDoneCount: 0, errorCount: 0, cancelledCount: 0, attentionCount: 0, artifactCount: 0, totalMs: 0, firstStartedAt: 0 }
}

function emptyStats(): TurnStats {
  return { ...emptyRoundStats() }
}

function createCtx(turnId: string): ProjectionCtx {
  return {
    turnId,
    nodes: [],
    nodeMap: new Map(),
    toolIndex: new Map(),
    currentRoundIndex: 0,
    roundAnswerText: new Map(),
    roundNodeIds: new Map(),
    roundAnswerNodeId: new Map(),
    roundPhases: new Map(),
    answerContent: '',
    answerStatus: 'idle',
    phase: 'active',
    supplements: [],
    stats: emptyStats(),
  }
}

// ── ID 生成（纯函数：同 turnId + kind + seq → 同 ID） ──

function makeNodeId(turnId: string, kind: string, seq: number, toolCallId?: string): RenderNodeId {
  if (toolCallId) return `${turnId}:${kind}:${toolCallId}:${seq}`
  return `${turnId}:${kind}:${seq}`
}

/** v4.0: 生成 answer 节点 ID（编码 roundIndex，保证每轮独立 AnswerNode） */
function makeAnswerNodeId(turnId: string, roundIndex: number): RenderNodeId {
  return `${turnId}:answer:r${roundIndex}`
}

// ── 节点投影 ──────────────────────────────────────────────

function project(log: readonly RenderEvent[]): TurnState {
  const ctx = createCtx(log.length > 0 ? log[0].turnId : '')

  for (const ev of log) {
    switch (ev.type) {
      case 'round.start':
        applyRoundStart(ctx, ev)
        break
      case 'round.settle':
        applyRoundSettle(ctx, ev)
        break
      case 'node.start':
        applyNodeStart(ctx, ev)
        break
      case 'node.delta':
        applyNodeDelta(ctx, ev)
        break
      case 'node.done':
        applyNodeDone(ctx, ev)
        break
      case 'node.error':
        applyNodeError(ctx, ev)
        break
      case 'artifact.present':
        applyArtifactPresent(ctx, ev)
        break
      case 'attention.request':
        applyAttentionRequest(ctx, ev)
        break
      case 'attention.resolve':
        applyAttentionResolve(ctx, ev)
        break
      case 'answer.delta':
        applyAnswerDelta(ctx, ev)
        break
      case 'answer.done':
        applyAnswerDone(ctx, ev)
        break
      case 'answer.error':
        applyAnswerError(ctx, ev)
        break
      case 'answer.abort':
        applyAnswerAbort(ctx, ev)
        break
      case 'turn.settle':
        applyTurnSettle(ctx)
        break
      case 'turn.abort':
        applyTurnAbort(ctx, ev)
        break
      case 'supplement':
        applySupplement(ctx, ev)
        break
    }
  }

  // v4.0: 构建 rounds 数组 + answers 数组
  const rounds = buildRounds(ctx)
  const answers = buildAnswers(ctx)

  // 计算 segFlowed：前序节点为终态 → 当前节点来路段"已流过"
  const segFlowed = computeSegFlowed(ctx.nodes)

  return {
    turnId: ctx.turnId,
    phase: ctx.phase,
    nodes: ctx.nodes,
    segFlowed,
    answerContent: ctx.answerContent,
    answerStatus: ctx.answerStatus,
    supplements: [...ctx.supplements],
    stats: computeTurnStats(rounds, ctx.phase),
    rounds,
    answers,
  }
}

/** v4.0: 从 ctx 构建 RoundState[] */
function buildRounds(ctx: ProjectionCtx): RoundState[] {
  const result: RoundState[] = []
  const allIndices = new Set<number>()
  for (const ri of ctx.roundNodeIds.keys()) allIndices.add(ri)
  for (const ri of ctx.roundAnswerNodeId.keys()) allIndices.add(ri)
  for (const ri of ctx.roundPhases.keys()) allIndices.add(ri)
  const sorted = [...allIndices].sort((a, b) => a - b)

  for (const ri of sorted) {
    const nodeIds = ctx.roundNodeIds.get(ri) || []
    const roundNodes = nodeIds.map(id => ctx.nodeMap.get(id)!).filter(Boolean)
    result.push({
      index: ri,
      nodeIds,
      answerNodeId: ctx.roundAnswerNodeId.get(ri),
      phase: ctx.roundPhases.get(ri) || 'active',
      stats: computeRoundStats(roundNodes, ctx.roundPhases.get(ri) || 'active'),
    })
  }
  return result
}

/** v4.0: 从 ctx 构建 answers 数组 */
function buildAnswers(ctx: ProjectionCtx): string[] {
  const allIndices = new Set<number>()
  for (const ri of ctx.roundAnswerText.keys()) allIndices.add(ri)
  const sorted = [...allIndices].sort((a, b) => a - b)
  return sorted.map(ri => ctx.roundAnswerText.get(ri) || '')
}

// ── 事件处理器 ────────────────────────────────────────────

function upsertNode(ctx: ProjectionCtx, node: RenderNode): void {
  const existing = ctx.nodeMap.get(node.id)
  if (existing) {
    Object.assign(existing, node)
  } else {
    ctx.nodes.push(node)
    ctx.nodeMap.set(node.id, node)
    // v4.0: 新节点注册到当前 round
    if (ctx.currentRoundIndex > 0) {
      const ids = ctx.roundNodeIds.get(ctx.currentRoundIndex) || []
      ids.push(node.id)
      ctx.roundNodeIds.set(ctx.currentRoundIndex, ids)
    }
  }
}

/** v4.0: 确保当前 round 的上下文已初始化（首次写入时懒创建） */
function ensureRoundCtx(ctx: ProjectionCtx): void {
  if (ctx.currentRoundIndex <= 0) return
  if (!ctx.roundNodeIds.has(ctx.currentRoundIndex)) {
    ctx.roundNodeIds.set(ctx.currentRoundIndex, [])
  }
  if (!ctx.roundPhases.has(ctx.currentRoundIndex)) {
    ctx.roundPhases.set(ctx.currentRoundIndex, 'active')
  }
  if (!ctx.roundAnswerText.has(ctx.currentRoundIndex)) {
    ctx.roundAnswerText.set(ctx.currentRoundIndex, '')
  }
}

// ── v4.0 round 生命周期 ──

function applyRoundStart(ctx: ProjectionCtx, ev: RenderEvent & { type: 'round.start' }): void {
  ctx.currentRoundIndex = ev.roundIndex
  ensureRoundCtx(ctx)
  ctx.roundPhases.set(ev.roundIndex, 'active')
}

function applyRoundSettle(ctx: ProjectionCtx, ev: RenderEvent & { type: 'round.settle' }): void {
  const ri = ev.roundIndex
  ensureRoundCtx(ctx)
  // 如果 answer 仍在 streaming，完成它
  const ansId = ctx.roundAnswerNodeId.get(ri)
  if (ansId) {
    const ansNode = ctx.nodeMap.get(ansId)
    if (ansNode && ansNode.type === 'answer' && ansNode.status === 'streaming') {
      ansNode.status = 'done'
    }
  }
  ctx.roundPhases.set(ri, 'settled')
  // 更新扁平 answerStatus（最后一轮）
  if (ri >= ctx.currentRoundIndex) {
    ctx.answerStatus = 'done'
  }
}

function applyNodeStart(ctx: ProjectionCtx, ev: RenderEvent & { type: 'node.start' }): void {
  const { node: env } = ev
  ensureRoundCtx(ctx)

  switch (env.kind) {
    case 'thinking':
    case 'verify': {
      const id = env.id || makeNodeId(ctx.turnId, 'thinking', ev.seq)
      const thinkingNode: ThinkingNode = {
        id,
        type: 'thinking',
        status: 'running',
        title: env.kind === 'verify' ? '验证中…' : '思考中…',
        role: env.kind === 'verify' ? 'verify' : 'think',
        content: '',
        startedAt: ev.ts,
      }
      upsertNode(ctx, thinkingNode)
      break
    }

    case 'tool': {
      if (!env.toolCallId) break
      if (ctx.toolIndex.has(env.toolCallId)) break
      const id = env.id || makeNodeId(ctx.turnId, 'tool', ev.seq, env.toolCallId)
      const toolNode: ToolNode = {
        id,
        type: 'tool',
        status: 'running',
        toolName: env.toolName || env.label || '未知工具',
        args: env.args,
        summary: '',
        startedAt: ev.ts,
        groupId: env.groupId,
      }
      upsertNode(ctx, toolNode)
      ctx.toolIndex.set(env.toolCallId, toolNode)
      break
    }

    case 'attention': {
      const id = env.id || makeNodeId(ctx.turnId, 'attention', ev.seq)
      const attnNode: AttentionNode = {
        id,
        type: 'attention',
        status: 'waiting',
        reason: env.label || '',
        startedAt: ev.ts,
      }
      upsertNode(ctx, attnNode)
      break
    }

    case 'answer': {
      // v4.0: answer 节点改由 answer.delta 事件创建（带 roundIndex）
      // node.start answer 作为兜底：没有 roundIndex 时按旧逻辑创建
      break
    }
  }
}

function applyNodeDelta(ctx: ProjectionCtx, ev: RenderEvent & { type: 'node.delta' }): void {
  const node = ctx.nodeMap.get(ev.id)
  if (!node) return

  if (node.type === 'thinking' && ev.text != null) {
    node.content += ev.text
  }
  if (node.type === 'tool') {
    if (ev.log != null) {
      node.executionLog = (node.executionLog || '') + ev.log
    }
    // BUG-08: 流式工具参数更新——args 在 node.delta 中传递
    if (ev.args != null) {
      node.args = ev.args
    }
    // 并行组 ID 后补（agenticLoop 在 handleStreamDone 时统一写入）
    if (ev.groupId != null && !node.groupId) {
      node.groupId = ev.groupId
    }
    // 状态转换通道（queued→running）
    if (ev.status != null && (node.status === 'queued' || node.status === 'running')) {
      node.status = ev.status
    }
  }
}

function applyNodeDone(ctx: ProjectionCtx, ev: RenderEvent & { type: 'node.done' }): void {
  const node = ctx.nodeMap.get(ev.id)
  if (!node) return

  const meta = ev.meta

  // 通用终态字段
  if (node.type === 'thinking' || node.type === 'tool') {
    node.status = meta.cancelled ? 'cancelled'
      : meta.success === false ? 'error'
      : 'done'
  }
  if (node.type === 'attention') {
    return // attention 通过 attention.resolve 处理
  }

  if (meta.durationMs != null && 'durationMs' in node) {
    node.durationMs = meta.durationMs
  }
  if (meta.summary != null && 'summary' in node) {
    ;(node as ToolNode).summary = meta.summary
  }
  // 注意：不能用 'result' in node 判断——ToolNode 创建时不带 result 键，
  // 该守卫会让 result 永远赋不上（present_artifact 卡片不渲染的根因）
  if (meta.result !== undefined && (node.type === 'tool' || 'result' in node)) {
    ;(node as ToolNode).result = meta.result
  }

  // 标题定型
  if (node.type === 'thinking') {
    node.title = node.role === 'verify' ? '验证' : '思考'
  }
}

function applyNodeError(ctx: ProjectionCtx, ev: RenderEvent & { type: 'node.error' }): void {
  const node = ctx.nodeMap.get(ev.id)
  if (!node) return

  if (node.type === 'thinking' || node.type === 'tool') {
    node.status = 'error'
  }
  if (node.type === 'answer') {
    node.status = 'error'
    ctx.answerStatus = 'error'
  }
  if ('summary' in node) {
    ;(node as ToolNode).summary = ev.error.message
  }
}

function applyArtifactPresent(ctx: ProjectionCtx, ev: RenderEvent & { type: 'artifact.present' }): void {
  const { artifact, roundIndex } = ev
  // BUG-24: 按 sourceToolCallId + title 去重，避免重连/重发产生双卡
  const exists = ctx.nodes.some(
    (n) =>
      n.type === 'artifact' &&
      n.sourceToolCallId === artifact.sourceToolCallId &&
      n.title === artifact.title
  )
  if (exists) return

  const id = makeNodeId(ctx.turnId, 'artifact', ev.seq)
  const node: ArtifactNode = {
    id,
    type: 'artifact',
    artifactType: artifact.artifactType,
    title: artifact.title,
    artifactId: `${ctx.turnId}:artifact:${ev.seq}`,
    sourceToolCallId: artifact.sourceToolCallId,
    payload: artifact.payload,
    startedAt: ev.ts,
  }
  ctx.nodes.push(node)
  ctx.nodeMap.set(node.id, node)

  // v4.0: 将 artifact 注册到所属 round
  if (roundIndex > 0) {
    if (!ctx.roundNodeIds.has(roundIndex)) {
      ctx.roundNodeIds.set(roundIndex, [])
    }
    ctx.roundNodeIds.get(roundIndex)!.push(node.id)
  }
}

function applyAttentionRequest(ctx: ProjectionCtx, ev: RenderEvent & { type: 'attention.request' }): void {
  // 多 attention 并存：不再自动关闭上一个 waiting attention
  // 关闭由 resolveAttention/超时/turn settle 显式驱动

  const attn = ev.attention
  const id = attn.id || makeNodeId(ctx.turnId, 'attention', ev.seq)
  const node: AttentionNode = {
    id,
    type: 'attention',
    status: 'waiting',
    subtype: attn.subtype,
    reason: attn.reason,
    toolName: attn.toolName,
    prompt: attn.prompt,
    options: attn.options,
    toolCallId: attn.toolCallId,
    startedAt: ev.ts,
  }
  ctx.nodes.push(node)
  ctx.nodeMap.set(node.id, node)
}

function applyAttentionResolve(ctx: ProjectionCtx, ev: RenderEvent & { type: 'attention.resolve' }): void {
  const node = ctx.nodeMap.get(ev.id)
  if (!node || node.type !== 'attention') return
  node.status = ev.result
  node.durationMs = ev.ts - node.startedAt
}

function applyAnswerDelta(ctx: ProjectionCtx, ev: RenderEvent & { type: 'answer.delta' }): void {
  const ri = ev.roundIndex
  // 累积该轮 answer 文本
  const prev = ctx.roundAnswerText.get(ri) || ''
  ctx.roundAnswerText.set(ri, prev + ev.text)
  // 扁平兼容：取最新轮次的内容
  if (ri >= (ctx.currentRoundIndex || ri)) {
    ctx.answerContent = ctx.roundAnswerText.get(ri) || ''
  }

  ensureRoundCtx(ctx)

  // 查找或创建该轮的 AnswerNode
  const ansId = ctx.roundAnswerNodeId.get(ri)
    || makeAnswerNodeId(ctx.turnId, ri)
  let answerNode = ansId ? ctx.nodeMap.get(ansId) : undefined
  if (!answerNode || answerNode.type !== 'answer') {
    const id = ansId || makeAnswerNodeId(ctx.turnId, ri)
    answerNode = {
      id,
      type: 'answer',
      status: 'streaming',
      content: '',
      startedAt: ev.ts,
    } as AnswerNode
    ctx.nodes.push(answerNode)
    ctx.nodeMap.set(answerNode.id, answerNode)
    ctx.roundAnswerNodeId.set(ri, answerNode.id)
    // 注册到当前 round
    if (!ctx.roundNodeIds.has(ri)) ctx.roundNodeIds.set(ri, [])
    ctx.roundNodeIds.get(ri)!.push(answerNode.id)
  }
  answerNode.content = ctx.roundAnswerText.get(ri) || ''
  ctx.answerStatus = 'streaming'
}

function applyAnswerDone(ctx: ProjectionCtx, ev: RenderEvent & { type: 'answer.done' }): void {
  const ri = ev.roundIndex
  ctx.answerStatus = 'done'
  // 关闭该轮的 answer 节点
  const ansId = ctx.roundAnswerNodeId.get(ri)
  if (ansId) {
    const ansNode = ctx.nodeMap.get(ansId)
    if (ansNode && ansNode.type === 'answer' && ansNode.status === 'streaming') {
      ansNode.status = 'done'
    }
  }
}

function applyAnswerError(ctx: ProjectionCtx, ev: RenderEvent & { type: 'answer.error' }): void {
  const ri = ev.roundIndex
  ctx.answerStatus = 'error'
  let ansId = ctx.roundAnswerNodeId.get(ri)
  // 错误可能是该轮的第一个事件（如代理层"未配置 API Key"在首 token 前失败）——
  // 此前没有 answerDelta 就没有 AnswerNode，错误文本会被静默丢弃（用户看到空轮次秒结束）。
  // 此处兜底创建 AnswerNode 承载错误文本，保证任何错误都可见。
  if (!ansId) {
    ensureRoundCtx(ctx)
    ansId = makeAnswerNodeId(ctx.turnId, ri)
    const created: AnswerNode = {
      id: ansId,
      type: 'answer',
      status: 'error',
      content: `[错误] ${ev.error.message}`,
      startedAt: ev.ts,
    }
    ctx.nodes.push(created)
    ctx.nodeMap.set(created.id, created)
    ctx.roundAnswerNodeId.set(ri, created.id)
    if (!ctx.roundNodeIds.has(ri)) ctx.roundNodeIds.set(ri, [])
    ctx.roundNodeIds.get(ri)!.push(created.id)
    return
  }
  const ansNode = ctx.nodeMap.get(ansId)
  if (ansNode && ansNode.type === 'answer') {
    ansNode.status = 'error'
    ansNode.content += `\n\n[错误] ${ev.error.message}`
  }
}

function applyAnswerAbort(ctx: ProjectionCtx, ev: RenderEvent & { type: 'answer.abort' }): void {
  const ri = ev.roundIndex
  // 仅停止当前 answer，不影响其他节点
  const ansId = ctx.roundAnswerNodeId.get(ri)
  if (ansId) {
    const ansNode = ctx.nodeMap.get(ansId)
    if (ansNode && ansNode.type === 'answer' && ansNode.status === 'streaming') {
      ansNode.status = 'stopped'
    }
  }
  // 更新 answerStatus 但不改变 phase
  if (ctx.answerStatus === 'streaming') {
    ctx.answerStatus = 'stopped'
  }
}

/** v4.0: 关闭所有 open round 的 running 节点 */
function settleAllRunning(ctx: ProjectionCtx, settledAt?: number): void {
  for (let i = 0; i < ctx.nodes.length; i++) {
    const node = ctx.nodes[i]
    if (node.type === 'thinking' && node.status === 'running') {
      node.status = 'done'
      if (settledAt != null) node.durationMs = settledAt - node.startedAt
    }
    if (node.type === 'tool' && (node.status === 'running' || node.status === 'queued')) {
      node.status = 'done'
      if (settledAt != null) node.durationMs = settledAt - node.startedAt
    }
    if (node.type === 'answer' && node.status === 'streaming') {
      node.status = 'done'
    }
    if (node.type === 'attention' && node.status === 'waiting') {
      node.status = 'skipped'
      node.durationMs = (settledAt ?? Date.now()) - node.startedAt
    }
  }
}

function applyTurnSettle(ctx: ProjectionCtx): void {
  if (ctx.phase === 'stopped' || ctx.phase === 'failed') return

  settleAllRunning(ctx)
  // v4.0: 关闭所有仍在 active 的 round
  for (const [ri, phase] of ctx.roundPhases) {
    if (phase === 'active') {
      ctx.roundPhases.set(ri, 'settled')
    }
  }
  ctx.phase = 'settled'
  ctx.answerStatus = 'done'
}

function applyTurnAbort(ctx: ProjectionCtx, ev: RenderEvent & { type: 'turn.abort' }): void {
  for (const node of ctx.nodes) {
    if (node.type === 'thinking' && node.status === 'running') {
      node.status = 'done'
    }
    if (node.type === 'tool' && (node.status === 'running' || node.status === 'queued')) {
      node.status = 'cancelled'
      node.summary = '用户已中断'
    }
    if (node.type === 'answer' && node.status === 'streaming') {
      node.status = 'stopped'
    }
    if (node.type === 'attention' && node.status === 'waiting') {
      node.status = 'cancelled'
    }
  }

  if (ev.reason === 'error' || ev.reason === 'disconnect') {
    ctx.phase = 'failed'
    ctx.answerStatus = 'error'
    // v4.0: 标记当前 round
    for (const [ri, phase] of ctx.roundPhases) {
      if (phase === 'active') ctx.roundPhases.set(ri, 'failed')
    }
  } else {
    ctx.phase = 'stopped'
    ctx.answerStatus = 'stopped'
    for (const [ri, phase] of ctx.roundPhases) {
      if (phase === 'active') ctx.roundPhases.set(ri, 'stopped')
    }
  }
}

/** supplement 事件：记录补充到 TurnState.supplements（§7 SupplementGateway 契约①）。
 * 事件仅在真正注入模型上下文时产生（agenticLoop.applyPendingSupplements），故 injected 恒为 true */
function applySupplement(ctx: ProjectionCtx, ev: RenderEvent & { type: 'supplement' }): void {
  ctx.supplements.push({
    msgId: ev.msgId,
    text: ev.text,
    ts: ev.ts,
    injected: true,
    // v9.2：记录注入时轮次——渲染时气泡插到该轮（阶段结论）之后，还原"中途进入"的位置
    roundIndex: ctx.currentRoundIndex,
  })
}

// ── segFlowed 计算 ────────────────────────────────────────

/** v4.0: 从单轮节点计算 RoundStats */
function computeRoundStats(nodes: readonly RenderNode[], phase: RoundState['phase']): RoundStats {
  const stats = emptyRoundStats()
  let firstTs = Infinity
  let lastTs = 0
  for (const n of nodes) {
    if (n.startedAt && n.startedAt < firstTs) firstTs = n.startedAt
    const r = n as unknown as Record<string, unknown>
    const endTs = r.durationMs != null ? n.startedAt + (r.durationMs as number) : 0
    if (endTs > lastTs) lastTs = endTs
    switch (n.type) {
      case 'tool': {
        stats.toolCount++
        if (n.status === 'done') stats.toolDoneCount++
        else if (n.status === 'error') stats.errorCount++
        else if (n.status === 'cancelled') stats.cancelledCount++
        break
      }
      case 'attention': stats.attentionCount++; break
      case 'artifact': stats.artifactCount++; break
      case 'thinking': {
        stats.thinkingCount++
        if (n.durationMs != null) stats.thinkingMs += n.durationMs
        break
      }
    }
  }
  if (firstTs !== Infinity) stats.firstStartedAt = firstTs
  if (phase !== 'active' && lastTs > firstTs) {
    stats.totalMs = lastTs - firstTs
  } else if (phase === 'active' && firstTs !== Infinity) {
    stats.totalMs = Date.now() - firstTs
  }
  return stats
}

/** v4.0: 从 rounds 聚合 TurnStats */
function computeTurnStats(rounds: RoundState[], phase: TurnState['phase']): TurnStats {
  const stats = emptyStats()
  for (const r of rounds) {
    stats.toolCount += r.stats.toolCount
    stats.toolDoneCount += r.stats.toolDoneCount
    stats.errorCount += r.stats.errorCount
    stats.cancelledCount += r.stats.cancelledCount
    stats.attentionCount += r.stats.attentionCount
    stats.artifactCount += r.stats.artifactCount
    stats.thinkingCount += r.stats.thinkingCount
    stats.thinkingMs += r.stats.thinkingMs
  }
  stats.roundCount = rounds.length
  if (rounds.length > 0) {
    const first = rounds.reduce((min, r) => Math.min(min, r.stats.firstStartedAt || Infinity), Infinity)
    stats.firstStartedAt = first !== Infinity ? first : 0
    if (phase !== 'active') {
      const lastEnd = rounds.reduce((max, r) => {
        const end = (r.stats.firstStartedAt || 0) + r.stats.totalMs
        return end > max ? end : max
      }, 0)
      if (lastEnd > (stats.firstStartedAt || 0)) stats.totalMs = lastEnd - (stats.firstStartedAt || 0)
    } else {
      stats.totalMs = Date.now() - (stats.firstStartedAt || Date.now())
    }
  }
  return stats
}

function isSettled(node: RenderNode): boolean {
  if (node.type === 'tool') return node.status === 'done' || node.status === 'error' || node.status === 'cancelled'
  if (node.type === 'thinking') return node.status === 'done'
  if (node.type === 'answer') return node.status === 'done' || node.status === 'stopped' || node.status === 'error'
  if (node.type === 'attention') return node.status === 'resolved' || node.status === 'skipped' || node.status === 'timeout' || node.status === 'cancelled'
  return true
}

function computeSegFlowed(nodes: RenderNode[]): boolean[] {
  const result: boolean[] = new Array(nodes.length).fill(false)
  for (let i = 1; i < nodes.length; i++) {
    result[i] = isSettled(nodes[i - 1])
  }
  return result
}

// ── 导出 ──────────────────────────────────────────────────

export { project, isSettled, computeSegFlowed }
