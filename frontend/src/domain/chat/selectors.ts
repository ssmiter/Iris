import type { ChatState } from '@/stores/chatStore'
import type {
  ConversationProjection,
  RenderNode,
  TurnView,
} from './models'

export function selectTurns(state: ChatState): TurnView[] {
  return state.turnOrder
    .map((turnId) => state.turnsById[turnId])
    .filter((turn): turn is TurnView => Boolean(turn))
}

export function selectActiveTurn(state: ChatState): TurnView | null {
  for (let index = state.turnOrder.length - 1; index >= 0; index -= 1) {
    const turn = state.turnsById[state.turnOrder[index]]
    if (turn?.phase === 'active' || turn?.phase === 'queued') return turn
  }
  return null
}

interface AnswerIndexCache {
  source: Record<string, RenderNode>
  fingerprint: string
  map: ReadonlyMap<string, string>
}

let answerIndexCache: AnswerIndexCache | null = null

/**
 * roundId → answer nodeId 索引（稳定引用版）。
 * answer 节点集合（id 列表）不变时复用旧 Map：流式期间 delta 只改内容，
 * 集合不变 → 下游 memo 比较器用引用相等即可安全短路。
 * 扫描本身是 O(N)，每次投影构建一次，替代三层比较器各自的
 * Object.values().find 兜底（每次 delta 重复十几遍的 O(N)）。
 */
export function indexAnswerNodesByRoundId(
  renderNodesById: Record<string, RenderNode>,
): ReadonlyMap<string, string> {
  if (answerIndexCache?.source === renderNodesById) {
    return answerIndexCache.map
  }
  const entries: Array<[string, string]> = []
  const seen = new Set<string>()
  for (const node of Object.values(renderNodesById)) {
    if (node.type === 'answer' && node.roundId && !seen.has(node.roundId)) {
      // first-wins：与原先 Object.values().find 的语义一致
      seen.add(node.roundId)
      entries.push([node.roundId, node.nodeId])
    }
  }
  const fingerprint = entries.map(([roundId, nodeId]) => `${roundId}${nodeId}`).join('')
  if (answerIndexCache?.fingerprint === fingerprint) {
    answerIndexCache = { ...answerIndexCache, source: renderNodesById }
    return answerIndexCache.map
  }
  const map: ReadonlyMap<string, string> = new Map(entries)
  answerIndexCache = { source: renderNodesById, fingerprint, map }
  return map
}

/** 取某 round 的 answer 节点：链接字段优先，索引兜底，O(1)。 */
export function answerNodeForRound(
  round: { answerNodeId: string | null; roundId: string },
  renderNodesById: Record<string, RenderNode>,
  answerNodeIdsByRoundId: ReadonlyMap<string, string>,
): RenderNode | undefined {
  const nodeId = round.answerNodeId ?? answerNodeIdsByRoundId.get(round.roundId)
  return nodeId ? renderNodesById[nodeId] : undefined
}

export function selectProjection(
  state: ChatState,
  compactBoundaries: ConversationProjection['compactBoundaries'],
): ConversationProjection {
  return {
    turns: selectTurns(state),
    runsById: state.runsById,
    roundsById: state.roundsById,
    renderNodesById: state.renderNodesById,
    answerNodeIdsByRoundId: indexAnswerNodesByRoundId(state.renderNodesById),
    compactBoundaries,
  }
}
