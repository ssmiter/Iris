import { create } from 'zustand'
import type {
  ConversationProjection,
  RenderNode,
  RoundView,
  RunView,
  TurnView,
} from '@/domain/chat/models'
import type { PendingSupplement } from '@/domain/chat/input'

export type ConnectionState =
  | 'idle'
  | 'hydrating'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'invalidated'
  | 'failed'

export interface ChatState {
  turnOrder: string[]
  turnsById: Record<string, TurnView>
  runsById: Record<string, RunView>
  roundsById: Record<string, RoundView>
  renderNodesById: Record<string, RenderNode>
  connectionState: ConnectionState
  eventCursor: string | null
  projectionVersion: number
  pendingSupplements: PendingSupplement[]

  hydrateProjection: (projection: ConversationProjection) => void
  upsertTurn: (turn: TurnView) => void
  upsertRun: (run: RunView) => void
  upsertRound: (round: RoundView) => void
  upsertRenderNode: (node: RenderNode) => void
  setConnectionState: (state: ConnectionState) => void
  addPendingSupplement: (text: string) => string
  cancelPendingSupplement: (clientRequestId: string) => void
  clearPendingSupplements: () => void
}

function shouldReplace(currentVersion: number | undefined, nextVersion: number) {
  return currentVersion === undefined || nextVersion >= currentVersion
}

export const useChatStore = create<ChatState>((set) => ({
  turnOrder: [],
  turnsById: {},
  runsById: {},
  roundsById: {},
  renderNodesById: {},
  connectionState: 'idle',
  eventCursor: null,
  projectionVersion: 1,
  pendingSupplements: [],

  hydrateProjection: (projection) =>
    set({
      turnOrder: projection.turns.map((turn) => turn.turnId),
      turnsById: Object.fromEntries(
        projection.turns.map((turn) => [turn.turnId, turn]),
      ),
      runsById: projection.runsById,
      roundsById: projection.roundsById,
      renderNodesById: projection.renderNodesById,
      connectionState: 'connected',
    }),

  upsertTurn: (turn) =>
    set((state) => {
      const current = state.turnsById[turn.turnId]
      if (!shouldReplace(current?.version, turn.version)) return state
      return {
        turnsById: { ...state.turnsById, [turn.turnId]: turn },
        turnOrder: current
          ? state.turnOrder
          : [...state.turnOrder, turn.turnId],
      }
    }),

  upsertRun: (run) =>
    set((state) => {
      const current = state.runsById[run.runId]
      if (!shouldReplace(current?.version, run.version)) return state
      return { runsById: { ...state.runsById, [run.runId]: run } }
    }),

  upsertRound: (round) =>
    set((state) => {
      const current = state.roundsById[round.roundId]
      if (!shouldReplace(current?.version, round.version)) return state
      return { roundsById: { ...state.roundsById, [round.roundId]: round } }
    }),

  upsertRenderNode: (node) =>
    set((state) => {
      const current = state.renderNodesById[node.nodeId]
      if (!shouldReplace(current?.version, node.version)) return state
      return {
        renderNodesById: {
          ...state.renderNodesById,
          [node.nodeId]: node,
        },
      }
    }),

  setConnectionState: (connectionState) => set({ connectionState }),

  addPendingSupplement: (text) => {
    const clientRequestId = crypto.randomUUID()
    set((state) => ({
      pendingSupplements: [
        ...state.pendingSupplements,
        { clientRequestId, text, state: 'pending' },
      ],
    }))
    return clientRequestId
  },

  cancelPendingSupplement: (clientRequestId) =>
    set((state) => ({
      pendingSupplements: state.pendingSupplements.filter(
        (item) => item.clientRequestId !== clientRequestId,
      ),
    })),

  clearPendingSupplements: () => set({ pendingSupplements: [] }),
}))
