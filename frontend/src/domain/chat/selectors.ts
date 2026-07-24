import type { ChatState } from '@/stores/chatStore'
import type { ConversationProjection, TurnView } from './models'

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

export function selectProjection(
  state: ChatState,
  compactBoundaries: ConversationProjection['compactBoundaries'],
): ConversationProjection {
  return {
    turns: selectTurns(state),
    runsById: state.runsById,
    roundsById: state.roundsById,
    renderNodesById: state.renderNodesById,
    compactBoundaries,
  }
}
