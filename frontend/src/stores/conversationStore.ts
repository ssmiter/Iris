import { create } from 'zustand'
import type {
  CompactBoundaryView,
  ConversationProjection,
} from '@/domain/chat/models'

export interface ConversationSummary {
  conversationId: string
  title: string
  updatedAt: string
  activeTurnCount: number
}

export interface ConversationState {
  conversationOrder: string[]
  conversationsById: Record<string, ConversationSummary>
  currentConversationId: string | null
  currentBranchId: string | null
  compactBoundaries: CompactBoundaryView[]
  loadingState: 'idle' | 'loading' | 'ready' | 'failed'

  hydratePreview: (
    projection: ConversationProjection,
    summary: ConversationSummary,
  ) => void
  setCurrentConversation: (conversationId: string, branchId: string) => void
  upsertConversation: (conversation: ConversationSummary) => void
}

export const useConversationStore = create<ConversationState>((set) => ({
  conversationOrder: [],
  conversationsById: {},
  currentConversationId: null,
  currentBranchId: null,
  compactBoundaries: [],
  loadingState: 'idle',

  hydratePreview: (projection, summary) =>
    set({
      conversationOrder: [summary.conversationId],
      conversationsById: { [summary.conversationId]: summary },
      currentConversationId: summary.conversationId,
      currentBranchId: projection.turns[0]?.branchId ?? null,
      compactBoundaries: projection.compactBoundaries,
      loadingState: 'ready',
    }),

  setCurrentConversation: (currentConversationId, currentBranchId) =>
    set({ currentConversationId, currentBranchId }),

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
}))
