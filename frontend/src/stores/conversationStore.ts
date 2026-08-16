import { create } from 'zustand'
import type {
  BranchSummary,
  CompactionView,
  CompactBoundaryView,
  ConversationProjection,
} from '@/domain/chat/models'

export interface ConversationSummary {
  conversationId: string
  title: string
  updatedAt: string
  activeTurnCount: number
  pendingAttentionCount?: number
  lastVisibleText?: string | null
  version?: number
}

export interface ConversationState {
  conversationOrder: string[]
  conversationsById: Record<string, ConversationSummary>
  currentConversationId: string | null
  currentBranchId: string | null
  compactBoundaries: CompactBoundaryView[]
  branches: BranchSummary[]
  compactionsById: Record<string, CompactionView>
  loadingState: 'idle' | 'loading' | 'ready' | 'failed'

  hydratePreview: (
    projection: ConversationProjection,
    summary: ConversationSummary,
  ) => void
  hydrateList: (conversations: ConversationSummary[]) => void
  setCompactBoundaries: (boundaries: CompactBoundaryView[]) => void
  setBranches: (branches: BranchSummary[]) => void
  setCompactions: (compactions: Record<string, CompactionView>) => void
  upsertCompaction: (compaction: CompactionView) => void
  addCompactBoundary: (boundary: CompactBoundaryView) => void
  setCurrentConversation: (conversationId: string, branchId: string) => void
  startNewConversation: () => void
  upsertConversation: (conversation: ConversationSummary) => void
  /** 归档/移出列表：只在本地视野移除，不动历史；返回当前会话被移除时的后继 ID */
  removeConversation: (conversationId: string) => void
}

export const useConversationStore = create<ConversationState>((set) => ({
  conversationOrder: [],
  conversationsById: {},
  currentConversationId: null,
  currentBranchId: null,
  compactBoundaries: [],
  branches: [],
  compactionsById: {},
  loadingState: 'idle',

  hydratePreview: (projection, summary) =>
    set({
      conversationOrder: [summary.conversationId],
      conversationsById: { [summary.conversationId]: summary },
      currentConversationId: summary.conversationId,
      currentBranchId: projection.turns[0]?.branchId ?? null,
      compactBoundaries: projection.compactBoundaries,
      branches: [],
      compactionsById: {},
      loadingState: 'ready',
    }),

  hydrateList: (conversations) =>
    set({
      conversationOrder: conversations.map((item) => item.conversationId),
      conversationsById: Object.fromEntries(
        conversations.map((item) => [item.conversationId, item]),
      ),
      loadingState: 'ready',
    }),

  setCompactBoundaries: (compactBoundaries) => set({ compactBoundaries }),
  setBranches: (branches) => set({ branches }),
  setCompactions: (compactionsById) => set({ compactionsById }),
  upsertCompaction: (compaction) =>
    set((state) => ({
      compactionsById: {
        ...state.compactionsById,
        [compaction.runId]: compaction,
      },
    })),
  addCompactBoundary: (boundary) =>
    set((state) => ({
      compactBoundaries: state.compactBoundaries.some(
        (item) => item.boundaryId === boundary.boundaryId,
      )
        ? state.compactBoundaries.map((item) =>
            item.boundaryId === boundary.boundaryId ? boundary : item,
          )
        : [...state.compactBoundaries, boundary],
    })),

  setCurrentConversation: (currentConversationId, currentBranchId) =>
    set({ currentConversationId, currentBranchId }),

  startNewConversation: () =>
    set({
      currentConversationId: null,
      currentBranchId: null,
      compactBoundaries: [],
      branches: [],
      compactionsById: {},
    }),

  upsertConversation: (conversation) =>
    set((state) => ({
      conversationsById: {
        ...state.conversationsById,
        [conversation.conversationId]: conversation,
      },
      conversationOrder: state.conversationsById[conversation.conversationId]
        ? state.conversationOrder
        : [conversation.conversationId, ...state.conversationOrder],
    })),

  removeConversation: (conversationId) =>
    set((state) => {
      const { [conversationId]: _removed, ...rest } =
        state.conversationsById
      const order = state.conversationOrder.filter(
        (id) => id !== conversationId,
      )
      const removingCurrent =
        state.currentConversationId === conversationId
      return {
        conversationsById: rest,
        conversationOrder: order,
        // 归档当前会话：切到列表下一位，没有则回空态（新对话）
        currentConversationId: removingCurrent
          ? order[0] ?? null
          : state.currentConversationId,
        currentBranchId: removingCurrent ? null : state.currentBranchId,
      }
    }),
}))
