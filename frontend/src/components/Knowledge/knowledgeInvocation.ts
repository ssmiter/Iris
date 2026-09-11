import type { KnowledgeLensSelection } from '@/types/knowledge'

export interface KnowledgeInvocation {
  query: string
  scope: KnowledgeLensSelection
}

const KNOWLEDGE_COMMAND = /^\/(?:knowledge|知识库|知识)\s+([\s\S]+)$/i

/** Convert an explicit slash request into the same scoped message used by Agent retrieval. */
export function parseKnowledgeInvocation(content: string): KnowledgeInvocation | null {
  const match = content.trim().match(KNOWLEDGE_COMMAND)
  const query = match?.[1]?.trim()
  if (!query) return null
  return {
    query,
    scope: { domain: 'both', collectionId: null, collectionName: null },
  }
}
