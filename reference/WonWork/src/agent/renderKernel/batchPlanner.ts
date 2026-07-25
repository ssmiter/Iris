/**
 * batchPlanner — 纯函数：增量 RenderEvent[] + 当前 RenderNode[] → RenderOp[]
 *
 * 这是消除瀑布流"反复开合"的核心决策层。8 条规则全部收敛到此模块，
 * 每条可单测。输入事件日志的一个增量片段和当前节点树，输出一批渲染操作。
 *
 * 设计依据：wonwork-render-kernel-design-v2.0.md §5.2
 */

import type { RenderNode, RenderNodeId, ArtifactNode, AttentionNode, AnswerNode } from '@/types/chat'
import type { RenderEvent, NodeDoneMeta, ErrorInfo } from './renderEvent'

// ── RenderOp ──────────────────────────────────────────────

export type RenderOp =
  | { op: 'insert'; node: RenderNode; mode: 'active' | 'settled' }
  | { op: 'update'; id: RenderNodeId; patch: Partial<RenderNode> }
  | { op: 'remove'; id: RenderNodeId }
  | { op: 'promote'; artifact: ArtifactNode; sourceId: RenderNodeId }
  | { op: 'settle' }
  | { op: 'abort'; reason: 'user' | 'error' | 'disconnect' }

// ── 内部事件分组 ──────────────────────────────────────────

interface NodeEventGroup {
  id: RenderNodeId
  startEvent: (RenderEvent & { type: 'node.start' }) | null
  deltaEvents: (RenderEvent & { type: 'node.delta' })[]
  doneEvent: (RenderEvent & { type: 'node.done' }) | null
  errorEvent: (RenderEvent & { type: 'node.error' }) | null
}

// ── planner ───────────────────────────────────────────────

/**
 * 计划一批渲染操作。
 *
 * @param newEvents 自上次 drain 后的增量事件（已追加到 EventLog）
 * @param prevNodes 当前渲染的节点树（来自上一次 TurnProjector.project()）
 * @param fullState 完整事件日志投影后的 TurnState（包含所有节点）
 * @returns 渲染操作数组，由调用方消费（当前 syncRenderNodes 直接应用）
 */
export function plan(
  newEvents: readonly RenderEvent[],
  prevNodes: readonly RenderNode[],
  fullNodes: readonly RenderNode[]
): RenderOp[] {
  const ops: RenderOp[] = []
  const prevNodeMap = new Map<RenderNodeId, RenderNode>()
  const fullNodeMap = new Map<RenderNodeId, RenderNode>()
  for (const n of prevNodes) prevNodeMap.set(n.id, n)
  for (const n of fullNodes) fullNodeMap.set(n.id, n)

  // 声明在此处以便 answer/attention/artifact 的分支也能写入
  const errorOps: RenderOp[] = []
  const insertOps: RenderOp[] = []
  const updateOps: RenderOp[] = []

  // ── 1. 按节点 ID 分组事件 ──
  const groups = new Map<RenderNodeId, NodeEventGroup>()

  function ensureGroup(id: RenderNodeId): NodeEventGroup {
    let g = groups.get(id)
    if (!g) {
      g = { id, startEvent: null, deltaEvents: [], doneEvent: null, errorEvent: null }
      groups.set(id, g)
    }
    return g
  }

  for (const ev of newEvents) {
    switch (ev.type) {
      case 'node.start': {
        // 用 node kind + seq 推导 ID（与 TurnProjector 的 ID 生成同步）
        // ProjectedBuilder 通过 node.toolCallId 为 tool 节点生成 ID
        // 但由于 ID 生成在 builder 内部，这里从 fullNodes 中匹配
        const node = findNodeForStartEvent(ev, fullNodes)
        if (!node) break
        ensureGroup(node.id).startEvent = ev
        break
      }
      case 'node.delta': {
        ensureGroup(ev.id).deltaEvents.push(ev)
        break
      }
      case 'node.done': {
        ensureGroup(ev.id).doneEvent = ev
        break
      }
      case 'node.error': {
        ensureGroup(ev.id).errorEvent = ev
        break
      }
      case 'artifact.present': {
        // BUG-04: artifact.present → insert + promote ops
        // 按 sourceToolCallId + title 查找（避免 payload 引用相等失效）
        const artifactNode = fullNodes.find(
          (n): n is ArtifactNode =>
            n.type === 'artifact' &&
            (ev.artifact.sourceToolCallId
              ? n.sourceToolCallId === ev.artifact.sourceToolCallId
              : n.title === ev.artifact.title)
        )
        if (artifactNode) {
          // 如果产物节点尚未在渲染数组中，生成 insert op
          if (!prevNodeMap.has(artifactNode.id)) {
            insertOps.push({ op: 'insert', node: artifactNode, mode: 'active' })
          }
          // 查找触发 artifact 的源 tool 节点（用显式 sourceToolCallId 字段）
          const sourceId = ev.artifact.sourceToolCallId
            ? fullNodes.find((n) => n.type === 'tool' && n.id.includes(`:${ev.artifact.sourceToolCallId}:`))?.id
            : undefined
          ops.push({
            op: 'promote',
            artifact: artifactNode,
            sourceId: sourceId || '',
          })
        }
        break
      }
      case 'attention.request': {
        // BUG-02: attention.request → insert op（attention 节点出生即 active）
        const attnNode = fullNodes.find(
          (n): n is AttentionNode =>
            n.type === 'attention' &&
            (ev.attention.id ? n.id === ev.attention.id : true)
        )
        if (attnNode && !prevNodeMap.has(attnNode.id)) {
          insertOps.push({ op: 'insert', node: attnNode, mode: 'active' })
        }
        break
      }
      case 'attention.resolve': {
        // BUG-02: attention.resolve → update op
        const attnNode = fullNodes.find(
          (n): n is AttentionNode =>
            n.type === 'attention' && n.id === ev.id
        )
        const prevAttn = prevNodeMap.get(ev.id)
        if (attnNode && prevAttn) {
          const patch = computePatch(prevAttn, attnNode)
          if (Object.keys(patch).length > 0) {
            updateOps.push({ op: 'update', id: ev.id, patch })
          }
        }
        break
      }
      case 'answer.delta':
      case 'answer.done':
      case 'answer.error': {
        // v4.0: 按 roundIndex 定位该轮 AnswerNode
        const ri = (ev as { roundIndex: number }).roundIndex
        const answerNode = fullNodes.find(
          (n): n is AnswerNode => n.type === 'answer' && n.id.endsWith(`:r${ri}`)
        )
        if (!answerNode) break
        const prevAnswer = prevNodes.find(
          (n): n is AnswerNode => n.type === 'answer' && n.id.endsWith(`:r${ri}`)
        )
        if (prevAnswer) {
          const patch = computePatch(prevAnswer, answerNode)
          if (Object.keys(patch).length > 0) {
            updateOps.push({ op: 'update', id: answerNode.id, patch })
          }
        } else {
          // answer 节点首次出现（answer.delta 触发生成）
          insertOps.push({ op: 'insert', node: answerNode, mode: 'active' })
        }
        break
      }
      case 'turn.settle': {
        ops.push({ op: 'settle' })
        break
      }
      case 'turn.abort': {
        ops.push({ op: 'abort', reason: ev.reason })
        break
      }
      case 'supplement': {
        // R6：补充注入点——不在事件分组中产生 RenderOp，supplement 记录
        // 已通过 TurnProjector 写入 TurnState.supplements，由上层消费
        break
      }
    }
  }

  // ── 2. 对每个 group 生成 op ──

  for (const [, group] of groups) {
    const prevNode = prevNodeMap.get(group.id)
    const fullNode = fullNodeMap.get(group.id)
    const isNew = !prevNode
    const hasDone = group.doneEvent !== null
    const hasError = group.errorEvent !== null

    if (hasError && fullNode) {
      // R7: 异常优先 — error ops 排到数组最前面
      const patch = buildErrorPatch(fullNode, group.errorEvent!.error)
      errorOps.push({ op: 'update', id: group.id, patch })
    } else if (isNew && fullNode) {
      if (hasDone) {
        // R1: 终态前置 — start + done 同批 → 出生即 settled
        const node = applyDoneMeta(fullNode, group.doneEvent!.meta)
        insertOps.push({ op: 'insert', node, mode: 'settled' })
      } else {
        // R2: 活跃保鲜 — 只有 start 没有 done → 出生即 active
        insertOps.push({ op: 'insert', node: fullNode, mode: 'active' })
      }
    } else if (!isNew && fullNode) {
      // R3: 合并帧 — 已有节点的更新（retire）与新节点 insert 在同一数组
      const patch = computePatch(prevNode!, fullNode)
      if (Object.keys(patch).length > 0) {
        updateOps.push({ op: 'update', id: group.id, patch })
      }
    }
  }

  // R7: error 优先 → insert → update（settle/abort 已在开始处追加）
  ops.unshift(...errorOps)
  ops.push(...insertOps)
  ops.push(...updateOps)

  return ops
}

// ── helpers ───────────────────────────────────────────────

/** 从 fullNodes 中查找匹配 node.start 事件的目标节点 */
function findNodeForStartEvent(
  ev: RenderEvent & { type: 'node.start' },
  fullNodes: readonly RenderNode[]
): RenderNode | undefined {
  const { node: env } = ev
  // 优先使用 builder 提供的稳定 ID（与 TurnProjector 保持一致）
  if (env.id) {
    return fullNodes.find((n) => n.id === env.id)
  }
  // 按 kind + toolCallId 匹配（向后兼容无 id 的事件）
  if (env.kind === 'tool' && env.toolCallId) {
    return fullNodes.find(
      (n) => n.type === 'tool' && n.id.includes(`:${env.toolCallId}:`)
    )
  }
  // 非 tool 节点按 kind 匹配，取最新（最后创建的）
  const kindToType: Record<string, RenderNode['type']> = {
    thinking: 'thinking',
    verify: 'thinking',
    attention: 'attention',
    answer: 'answer',
  }
  const targetType = kindToType[env.kind]
  if (!targetType) return undefined
  // 反向搜索取最新的匹配节点
  for (let i = fullNodes.length - 1; i >= 0; i--) {
    const n = fullNodes[i]
    if (n.type === targetType) {
      // verify 节点额外检查 role
      if (env.kind === 'verify' && n.type === 'thinking' && n.role !== 'verify') continue
      return n
    }
  }
  return undefined
}

function applyDoneMeta(node: RenderNode, meta: NodeDoneMeta): RenderNode {
  const clone = { ...node }
  if (node.type === 'thinking' || node.type === 'tool') {
    // N-07: cancelled 优先于 success/error
    if (meta.cancelled) {
      ;(clone as { status: string }).status = 'cancelled'
    } else {
      ;(clone as { status: string }).status = meta.success === false ? 'error' : 'done'
    }
  }
  if (meta.durationMs != null && 'durationMs' in clone) {
    ;(clone as { durationMs?: number }).durationMs = meta.durationMs
  }
  if (meta.summary != null && 'summary' in clone) {
    ;(clone as { summary?: string }).summary = meta.summary
  }
  if (meta.result !== undefined && 'result' in clone) {
    ;(clone as { result?: unknown }).result = meta.result
  }
  if (clone.type === 'thinking') {
    clone.title = clone.role === 'verify' ? '验证' : '思考'
  }
  return clone
}

function buildErrorPatch(node: RenderNode, error: ErrorInfo): Partial<RenderNode> {
  const patch: Record<string, unknown> = {}
  if ('status' in node) {
    patch.status = 'error'
  }
  if ('summary' in node) {
    patch.summary = error.message
  }
  return patch as Partial<RenderNode>
}

/** 仅对含 status 字段的节点类型比较 status */
function hasStatus(n: RenderNode): n is RenderNode & { status: string } {
  return 'status' in n
}

function computePatch(prev: RenderNode, next: RenderNode): Partial<RenderNode> {
  const patch: Record<string, unknown> = {}

  // status 字段（artifact 无此字段，跳过）
  if (hasStatus(prev) && hasStatus(next) && prev.status !== next.status) {
    patch.status = next.status
  }

  // ThinkingNode
  if (prev.type === 'thinking' && next.type === 'thinking') {
    if (prev.content !== next.content) patch.content = next.content
    if (prev.title !== next.title) patch.title = next.title
    if (prev.durationMs !== next.durationMs) patch.durationMs = next.durationMs
  }

  // ToolNode
  if (prev.type === 'tool' && next.type === 'tool') {
    if (prev.args !== next.args) patch.args = next.args
    if (prev.summary !== next.summary) patch.summary = next.summary
    if (prev.result !== next.result) patch.result = next.result
    if (prev.executionLog !== next.executionLog) patch.executionLog = next.executionLog
    if (prev.durationMs !== next.durationMs) patch.durationMs = next.durationMs
    // 并行组 ID / 状态转换通道
    if (prev.groupId !== next.groupId) patch.groupId = next.groupId
    if (prev.status !== next.status) patch.status = next.status
  }

  // AnswerNode
  if (prev.type === 'answer' && next.type === 'answer') {
    if (prev.content !== next.content) patch.content = next.content
  }

  // AttentionNode
  if (prev.type === 'attention' && next.type === 'attention') {
    if (prev.durationMs !== next.durationMs) patch.durationMs = next.durationMs
  }

  return patch as Partial<RenderNode>
}

// ── RenderOp 应用器（syncRenderNodes 使用） ──

/**
 * 将 RenderOp[] 应用到当前节点数组上，返回新的节点数组。
 * 此函数也是纯的——相同输入 → 相同输出。
 */
export function applyOps(nodes: readonly RenderNode[], ops: readonly RenderOp[]): RenderNode[] {
  let result = [...nodes] as RenderNode[]
  const nodeMap = new Map<RenderNodeId, number>() // id → index

  for (let i = 0; i < result.length; i++) {
    nodeMap.set(result[i].id, i)
  }

  for (const op of ops) {
    switch (op.op) {
      case 'insert': {
        result = [...result, op.node]
        nodeMap.set(op.node.id, result.length - 1)
        break
      }
      case 'update': {
        const idx = nodeMap.get(op.id)
        if (idx !== undefined) {
          result[idx] = { ...result[idx], ...op.patch } as RenderNode
        }
        break
      }
      case 'remove': {
        const idx = nodeMap.get(op.id)
        if (idx !== undefined) {
          result = [...result.slice(0, idx), ...result.slice(idx + 1)]
          // 重建 map
          nodeMap.clear()
          for (let i = 0; i < result.length; i++) {
            nodeMap.set(result[i].id, i)
          }
        }
        break
      }
      case 'settle': {
        // BUG-03: settle → running/queued → done, answer streaming → done, waiting attention → skipped
        result = result.map((node): RenderNode => {
          if (node.type === 'thinking' && node.status === 'running') {
            return { ...node, status: 'done' as const }
          }
          if (node.type === 'tool' && (node.status === 'running' || node.status === 'queued')) {
            return { ...node, status: 'done' as const }
          }
          if (node.type === 'answer' && node.status === 'streaming') {
            return { ...node, status: 'done' as const }
          }
          if (node.type === 'attention' && node.status === 'waiting') {
            return { ...node, status: 'skipped' as const }
          }
          return node
        })
        // 重建 map
        nodeMap.clear()
        for (let i = 0; i < result.length; i++) {
          nodeMap.set(result[i].id, i)
        }
        break
      }
      case 'abort': {
        // BUG-03: abort → running → cancelled, answer streaming → stopped, waiting attention → cancelled
        result = result.map((node): RenderNode => {
          if (node.type === 'thinking' && node.status === 'running') {
            return { ...node, status: 'done' as const }
          }
          if (node.type === 'tool' && (node.status === 'running' || node.status === 'queued')) {
            return { ...node, status: 'cancelled' as const, summary: '用户已中断' }
          }
          if (node.type === 'answer' && node.status === 'streaming') {
            return { ...node, status: 'stopped' as const }
          }
          if (node.type === 'attention' && node.status === 'waiting') {
            return { ...node, status: 'cancelled' as const }
          }
          return node
        })
        // 重建 map
        nodeMap.clear()
        for (let i = 0; i < result.length; i++) {
          nodeMap.set(result[i].id, i)
        }
        break
      }
      case 'promote': {
        // promote 是 UI 层信号（WaterfallTurn 通过 promotedToolCallIds 消费），
        // 产物节点本身已通过 insert op 加入数组，此处无需修改节点
        break
      }
    }
  }

  return result
}
