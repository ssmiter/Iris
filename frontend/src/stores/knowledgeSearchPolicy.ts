import type { KnowledgeSearchRequest, KnowledgeSearchResponse } from '@/types/knowledge'

export function isCacheableKnowledgeRequest(request: Pick<KnowledgeSearchRequest, 'domain'>): boolean {
  return request.domain === 'local'
}

export function normalizeKnowledgeSearchKey(request: KnowledgeSearchRequest): string {
  const normalized = {
    domain: request.domain,
    query: request.query.trim().replace(/\s+/g, ' ').toLocaleLowerCase(),
    collectionId: request.collectionId || null,
    limit: request.limit ?? 12,
    tags: [...(request.tags || [])].map((item) => item.trim().toLocaleLowerCase()).filter(Boolean).sort(),
    mimeTypes: [...(request.mimeTypes || [])].map((item) => item.trim().toLocaleLowerCase()).filter(Boolean).sort(),
    updatedAfter: request.updatedAfter || null,
    updatedBefore: request.updatedBefore || null,
  }
  return JSON.stringify(normalized)
}

export class KnowledgeSearchCache {
  private readonly entries = new Map<string, { value: KnowledgeSearchResponse; expiresAt: number }>()

  constructor(
    private readonly maximumEntries = 50,
    private readonly ttlMilliseconds = 120_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): KnowledgeSearchResponse | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: KnowledgeSearchResponse): void {
    if (value.partial) return
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMilliseconds })
    while (this.entries.size > this.maximumEntries) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  clear(): void { this.entries.clear() }
}
