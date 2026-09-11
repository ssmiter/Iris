import { create } from 'zustand'
import type { KnowledgeCitation } from '@/types/knowledge'

interface KnowledgeNavigationState {
  pendingCitation: KnowledgeCitation | null
  openCitation: (citation: KnowledgeCitation) => void
  consumeCitation: () => void
}

/**
 * A tiny cross-surface bridge for citation cards. It deliberately carries no
 * knowledge data or API client, so registering Agent renderers does not pull the
 * full Knowledge workspace into the initial application bundle.
 */
export const useKnowledgeNavigationStore = create<KnowledgeNavigationState>((set) => ({
  pendingCitation: null,
  openCitation: (pendingCitation) => set({ pendingCitation }),
  consumeCitation: () => set({ pendingCitation: null }),
}))
