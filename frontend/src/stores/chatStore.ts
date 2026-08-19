import { create } from 'zustand'
import type {
  ConversationProjection,
  RenderNode,
  RoundView,
  RunView,
  TurnView,
} from '@/domain/chat/models'
import type {
  PendingSupplement,
  SupplementView,
} from '@/domain/chat/input'
import type {
  ConversationEvent,
  ConversationView,
  TaskView,
} from '@/api/irisApi'

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
  tasksById: Record<string, TaskView>
  connectionState: ConnectionState
  eventCursor: string | null
  projectionVersion: number
  pendingSupplements: PendingSupplement[]
  /** 视野之外还有更早的 Turn（后端分页水位线） */
  hasEarlierTurns: boolean
  /** 本会话最后一次收到 SSE 事件的时间（ISO，用于停滞检测） */
  lastEventAt: string | null

  hydrateProjection: (projection: ConversationProjection) => void
  hydrateView: (view: ConversationView) => void
  /** 向上翻一页：只补不覆盖——本地较新版本的实体一律优先 */
  prependEarlierView: (view: ConversationView) => number
  applyEvent: (event: ConversationEvent) => void
  upsertTurn: (turn: TurnView) => void
  upsertRun: (run: RunView) => void
  upsertRound: (round: RoundView) => void
  upsertRenderNode: (node: RenderNode) => void
  hydrateTasks: (tasks: TaskView[]) => void
  upsertTask: (task: TaskView) => void
  setConnectionState: (state: ConnectionState) => void
  addPendingSupplement: (turnId: string, text: string) => string
  confirmPendingSupplement: (
    clientRequestId: string,
    supplement: SupplementView,
  ) => void
  cancelPendingSupplement: (clientRequestId: string) => void
  clearPendingSupplements: () => void
  resetConversation: () => void
}

function shouldReplace(currentVersion: number | undefined, nextVersion: number) {
  return currentVersion === undefined || nextVersion >= currentVersion
}

function reduceConversationEvent(
  state: ChatState,
  event: ConversationEvent,
): Partial<ChatState> {
  const payload = event.envelope.payload
  const next: Partial<ChatState> = {
    eventCursor: event.envelope.eventId,
    lastEventAt: event.envelope.occurredAt,
  }

  if (event.type === 'turn.accepted' || event.type === 'turn.updated') {
    const turn = payload.turn as TurnView | undefined
    if (turn && shouldReplace(state.turnsById[turn.turnId]?.version, turn.version)) {
      next.turnsById = { ...state.turnsById, [turn.turnId]: turn }
      if (!state.turnsById[turn.turnId]) {
        next.turnOrder = [...state.turnOrder, turn.turnId]
      }
    }
  } else if (
    event.type === 'run.started' ||
    event.type === 'run.updated' ||
    event.type === 'run.settled'
  ) {
    const run = payload.run as RunView | undefined
    if (run && shouldReplace(state.runsById[run.runId]?.version, run.version)) {
      next.runsById = { ...state.runsById, [run.runId]: run }
    }
  } else if (event.type === 'round.started' || event.type === 'round.updated') {
    const round = payload.round as RoundView | undefined
    if (round && shouldReplace(state.roundsById[round.roundId]?.version, round.version)) {
      next.roundsById = { ...state.roundsById, [round.roundId]: round }
    }
  } else if (
    event.type === 'render_node.added' ||
    event.type === 'render_node.updated' ||
    event.type === 'attention.requested' ||
    event.type === 'attention.updated'
  ) {
    const node = payload.node as RenderNode | undefined
    if (
      node
      && shouldReplace(state.renderNodesById[node.nodeId]?.version, node.version)
    ) {
      next.renderNodesById = { ...state.renderNodesById, [node.nodeId]: node }
    }
  } else if (event.type === 'render_node.delta') {
    const nodeId = payload.nodeId as string | undefined
    const baseVersion = payload.baseVersion as number | undefined
    const targetVersion = payload.targetVersion as number | undefined
    const append = payload.append as string | undefined
    const current = nodeId ? state.renderNodesById[nodeId] : undefined

    if (
      current?.type === 'answer'
      && current.version === baseVersion
      && typeof targetVersion === 'number'
      && typeof append === 'string'
    ) {
      next.renderNodesById = {
        ...state.renderNodesById,
        [current.nodeId]: {
          ...current,
          content: current.content + append,
          version: targetVersion,
          updatedAt: event.envelope.occurredAt,
        },
      }
    } else {
      next.connectionState = 'invalidated'
    }
  } else if (event.type === 'render_node.invalidated') {
    const node = payload.node as RenderNode | undefined
    if (node && state.renderNodesById[node.nodeId]) {
      const nodes = { ...state.renderNodesById }
      delete nodes[node.nodeId]
      next.renderNodesById = nodes
    }
  } else if (event.type === 'supplement.updated') {
    const supplement = payload.supplement as SupplementView | undefined
    if (supplement) {
      const remaining = state.pendingSupplements.filter(
        (item) => item.supplementId !== supplement.supplementId,
      )
      next.pendingSupplements =
        supplement.state === 'pending'
          ? [
              ...remaining,
              {
                clientRequestId: supplement.supplementId,
                supplementId: supplement.supplementId,
                turnId: supplement.turnId,
                text: supplement.text,
                state: 'pending',
              },
            ]
          : remaining
    }
  } else if (event.type === 'task.updated') {
    const task = payload.task as TaskView | undefined
    if (task && shouldReplace(state.tasksById[task.taskId]?.version, task.version)) {
      next.tasksById = { ...state.tasksById, [task.taskId]: task }
    }
  } else if (event.type === 'projection.invalidated') {
    next.connectionState = 'invalidated'
  }

  return next
}

export const useChatStore = create<ChatState>((set) => {
  let queuedDeltas: ConversationEvent[] = []
  let queuedFrame: number | null = null

  const reduceEvents = (state: ChatState, events: ConversationEvent[]) =>
    events.reduce<ChatState>(
      (current, event) => ({
        ...current,
        ...reduceConversationEvent(current, event),
      }),
      state,
    )

  const flushQueuedDeltas = () => {
    queuedFrame = null
    if (queuedDeltas.length === 0) return
    const events = queuedDeltas
    queuedDeltas = []
    set((state) => reduceEvents(state, events))
  }

  const clearQueuedDeltas = () => {
    queuedDeltas = []
    if (queuedFrame !== null) {
      window.cancelAnimationFrame(queuedFrame)
      queuedFrame = null
    }
  }

  const applyEvent = (event: ConversationEvent) => {
    if (event.type === 'render_node.delta') {
      queuedDeltas.push(event)
      if (queuedFrame === null) {
        queuedFrame = window.requestAnimationFrame(flushQueuedDeltas)
      }
      return
    }

    const pending = queuedDeltas
    clearQueuedDeltas()
    set((state) => reduceEvents(state, [...pending, event]))
  }

  return {
  turnOrder: [],
  turnsById: {},
  runsById: {},
  roundsById: {},
  renderNodesById: {},
  tasksById: {},
  connectionState: 'idle',
  eventCursor: null,
  projectionVersion: 1,
  pendingSupplements: [],
  hasEarlierTurns: false,
  lastEventAt: null,

  hydrateProjection: (projection) => {
    clearQueuedDeltas()
    set({
      turnOrder: projection.turns.map((turn) => turn.turnId),
      turnsById: Object.fromEntries(
        projection.turns.map((turn) => [turn.turnId, turn]),
      ),
      runsById: projection.runsById,
      roundsById: projection.roundsById,
      renderNodesById: projection.renderNodesById,
      connectionState: 'connected',
      lastEventAt: new Date().toISOString(),
    })
  },

  hydrateView: (view) => {
    clearQueuedDeltas()
    set({
      turnOrder: view.turnOrder,
      turnsById: view.turnsById,
      runsById: view.runsById,
      roundsById: view.roundsById,
      renderNodesById: view.renderNodesById,
      eventCursor: view.eventCursor,
      projectionVersion: view.projectionVersion,
      hasEarlierTurns: view.hasEarlierTurns,
      pendingSupplements: Object.values(view.turnsById)
        .flatMap((turn) => turn.supplements ?? [])
        .filter((supplement) => supplement.state === 'pending')
        .map((supplement) => ({
          clientRequestId: supplement.supplementId,
          supplementId: supplement.supplementId,
          turnId: supplement.turnId,
          text: supplement.text,
          state: 'pending' as const,
        })),
      connectionState: 'connecting',
      lastEventAt: new Date().toISOString(),
    })
  },

  applyEvent,

  prependEarlierView: (view) => {
    let prepended = 0
    set((state) => {
      const known = new Set(state.turnOrder)
      const freshOrder = view.turnOrder.filter((id) => !known.has(id))
      prepended = freshOrder.length
      return {
        turnOrder: [...freshOrder, ...state.turnOrder],
        // 历史页实体在前、本地状态在后：本地（可能含流式较新版本）优先
        turnsById: { ...view.turnsById, ...state.turnsById },
        runsById: { ...view.runsById, ...state.runsById },
        roundsById: { ...view.roundsById, ...state.roundsById },
        renderNodesById: { ...view.renderNodesById, ...state.renderNodesById },
        hasEarlierTurns: view.hasEarlierTurns,
      }
    })
    return prepended
  },

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

  hydrateTasks: (tasks) =>
    set((state) => {
      const next = { ...state.tasksById }
      for (const task of tasks) {
        if (shouldReplace(next[task.taskId]?.version, task.version)) {
          next[task.taskId] = task
        }
      }
      return { tasksById: next }
    }),

  upsertTask: (task) =>
    set((state) => {
      if (!shouldReplace(state.tasksById[task.taskId]?.version, task.version)) {
        return state
      }
      return { tasksById: { ...state.tasksById, [task.taskId]: task } }
    }),

  setConnectionState: (connectionState) => set({ connectionState }),

  addPendingSupplement: (turnId, text) => {
    const clientRequestId = crypto.randomUUID()
    set((state) => ({
      pendingSupplements: [
        ...state.pendingSupplements,
        {
          clientRequestId,
          supplementId: null,
          turnId,
          text,
          state: 'submitting',
        },
      ],
    }))
    return clientRequestId
  },

  confirmPendingSupplement: (clientRequestId, supplement) =>
    set((state) => ({
      pendingSupplements: [
        ...state.pendingSupplements.filter(
          (item) =>
            item.clientRequestId !== clientRequestId &&
            item.supplementId !== supplement.supplementId,
        ),
        {
          clientRequestId,
          supplementId: supplement.supplementId,
          turnId: supplement.turnId,
          text: supplement.text,
          state: 'pending',
        },
      ],
    })),

  cancelPendingSupplement: (clientRequestId) =>
    set((state) => ({
      pendingSupplements: state.pendingSupplements.filter(
        (item) => item.clientRequestId !== clientRequestId,
      ),
    })),

  clearPendingSupplements: () => set({ pendingSupplements: [] }),

  resetConversation: () => {
    clearQueuedDeltas()
    set({
      turnOrder: [],
      turnsById: {},
      runsById: {},
      roundsById: {},
      renderNodesById: {},
      tasksById: {},
      connectionState: 'idle',
      eventCursor: null,
      pendingSupplements: [],
      hasEarlierTurns: false,
      lastEventAt: null,
    })
  },
  }
})
