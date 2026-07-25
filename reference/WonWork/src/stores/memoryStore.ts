import { create } from 'zustand'
import type {
  MemoryConfig,
  MemoryEntry,
  MemoryEntryType,
  MemoryLayer,
  MemoryPriority,
  MemoryQuery,
  MemoryRecallResult,
  MemoryStatus,
  QueryStrategy,
  UserProfile,
} from '@/types/memory'
import {
  createMemoryConfig,
  createMemoryEntry,
  defaultLayerForType,
  defaultRetentionDays,
  extractTriple,
  formatResultsForContext,
  generateMemoryId,
  MEMORY_LAYERS,
  priorityScore,
} from '@/types/memory'
import { embeddingApi } from '@/api/client'
import {
  clearLegacyMemoryStorage,
  loadMemoryData,
  saveMemoryData,
} from '@/utils/memoryStorage'

const IS_STANDALONE = import.meta.env.VITE_STANDALONE_MODE === 'true'

interface MemoryState {
  entries: MemoryEntry[]
  config: MemoryConfig
  lastConsolidatedAt: string | null
  initialized: boolean
  isLoading: boolean
  error: string | null
  embeddingAvailable: boolean | null
  activeLayer: MemoryLayer | 'all'
  activeTypes: MemoryEntryType[]
  activeStatuses: MemoryStatus[]
  searchQuery: string

  initialize: () => Promise<void>
  remember: (input: Partial<MemoryEntry> & { content: string }) => Promise<MemoryEntry>
  recall: (query: MemoryQuery) => Promise<MemoryRecallResult[]>
  consolidate: () => Promise<void>
  getUserProfile: () => UserProfile
  deleteMemory: (id: string) => Promise<void>
  updateMemory: (id: string, updates: Partial<MemoryEntry>) => Promise<void>
  archiveMemory: (id: string) => Promise<void>
  setConfig: (partial: Partial<MemoryConfig>) => Promise<void>
  setActiveLayer: (layer: MemoryLayer | 'all') => void
  setActiveTypes: (types: MemoryEntryType[]) => void
  setActiveStatuses: (statuses: MemoryStatus[]) => void
  setSearchQuery: (query: string) => void
  getVisibleMemories: () => MemoryEntry[]
  searchMemories: (query: string, limit?: number) => MemoryEntry[]
  extractAndRemember: (text: string, conversationId?: number) => Promise<MemoryEntry[]>
  refreshEmbeddingAvailability: () => Promise<void>
}

interface ResolvedQuery extends MemoryQuery {
  text: string
  keywords: string[]
  layers: MemoryLayer[]
  types: MemoryEntryType[]
  tags: string[]
  strategy: QueryStrategy
  top_k: number
  min_score: number
  semantic_weight: number
  keyword_weight: number
  recency_weight: number
  importance_weight: number
}

function now(): string {
  return new Date().toISOString()
}

function normalizeText(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

function normalizeForDedup(s: string): string {
  return normalizeText(s).replace(/[^a-z0-9一-龥]/g, '')
}

function extractTokens(s: string): string[] {
  const text = normalizeText(s)
  const words = text
    .split(/[^a-z0-9一-龥]+/)
    .filter((w) => w.length > 1)
  const chars = text.match(/[一-龥]/g) || []
  const bigrams: string[] = []
  for (let i = 0; i < chars.length - 1; i++) {
    bigrams.push(chars[i] + chars[i + 1])
  }
  return [...new Set([...words, ...bigrams])]
}

function keywordScore(query: string, entry: MemoryEntry): number {
  const queryTokens = extractTokens(query)
  if (queryTokens.length === 0) return 0
  const entryTokens = new Set([
    ...extractTokens(entry.content),
    ...extractTokens(entry.summary || ''),
    ...(entry.tags || []).flatMap((t) => extractTokens(t)),
    ...extractTokens(entry.subject || ''),
    ...extractTokens(entry.object || ''),
  ])
  let hits = 0
  for (const t of queryTokens) {
    if (entryTokens.has(t)) hits++
  }
  return hits / queryTokens.length
}

function recencyScore(timestamp: string): number {
  const hours = (Date.now() - new Date(timestamp).getTime()) / 36e5
  return Math.exp(-hours / 24)
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function shouldEmbed(entry: MemoryEntry): boolean {
  return (
    entry.layer === 'semantic' ||
    entry.layer === 'episodic' ||
    entry.priority === 'critical' ||
    entry.priority === 'high'
  )
}

function filterEntry(query: ResolvedQuery, entry: MemoryEntry): boolean {
  if (!query.layers.includes(entry.layer)) return false
  if (query.types.length > 0 && !query.types.includes(entry.type)) return false
  if (query.tags.length > 0 && !(entry.tags || []).some((t) => query.tags.includes(t)))
    return false
  if (query.session_id && entry.session_id !== query.session_id) return false
  if (query.task_id && entry.task_id !== query.task_id) return false
  if (query.min_priority && priorityScore(entry.priority) < priorityScore(query.min_priority))
    return false
  if (query.since && entry.created_at < query.since) return false
  if (query.until && entry.created_at > query.until) return false
  return true
}

function resolveQuery(query: MemoryQuery, config: MemoryConfig): ResolvedQuery {
  return {
    text: query.text || '',
    embedding: query.embedding,
    keywords: query.keywords || [],
    layers: query.layers || MEMORY_LAYERS,
    types: query.types || [],
    tags: query.tags || [],
    session_id: query.session_id,
    task_id: query.task_id,
    min_priority: query.min_priority,
    since: query.since,
    until: query.until,
    strategy: query.strategy || config.default_query_strategy || 'hybrid',
    top_k: query.top_k || config.default_top_k || 5,
    min_score: query.min_score ?? 0.2,
    semantic_weight: query.semantic_weight ?? config.semantic_weight ?? 0.4,
    keyword_weight: query.keyword_weight ?? config.keyword_weight ?? 0.2,
    recency_weight: query.recency_weight ?? config.recency_weight ?? 0.3,
    importance_weight: query.importance_weight ?? config.importance_weight ?? 0.1,
  }
}

function computeScore(
  entry: MemoryEntry,
  q: ResolvedQuery,
  queryEmbedding: number[] | null
): { score: number; semantic: number; keyword: number; recency: number; importance: number } {
  const kw = keywordScore(q.text || q.keywords.join(' '), entry)
  const rec = recencyScore(entry.last_accessed_at)
  const imp = entry.importance_score ?? priorityScore(entry.priority)
  let sem = 0
  if (queryEmbedding && entry.embedding?.vector) {
    sem = Math.max(0, cosineSimilarity(queryEmbedding, entry.embedding.vector))
  }

  let score: number
  switch (q.strategy) {
    case 'semantic':
      score = sem
      break
    case 'keyword':
      score = kw
      break
    case 'recency':
      score = rec
      break
    case 'importance':
      score = imp
      break
    case 'temporal':
      score = rec * 0.7 + imp * 0.3
      break
    case 'graph':
      score = kw * 0.5 + imp * 0.5
      break
    case 'hybrid':
    default:
      score =
        q.semantic_weight * sem +
        q.keyword_weight * kw +
        q.recency_weight * rec +
        q.importance_weight * imp
  }

  return { score, semantic: sem, keyword: kw, recency: rec, importance: imp }
}

function extractMemoryCandidates(
  text: string,
  conversationId?: number
): Array<Partial<MemoryEntry> & { content: string }> {
  const candidates: Array<Partial<MemoryEntry> & { content: string }> = []
  const add = (content: string, type: MemoryEntryType, priority: MemoryPriority) => {
    if (content.length < 3) return
    candidates.push({
      content,
      type,
      priority,
      layer: defaultLayerForType(type),
      source: 'assistant_extract',
      conversation_id: conversationId,
    })
  }

  // 偏好
  const prefMatch = text.match(
    /(?:我|用户)?[\s，。]*(?:喜欢|偏好|习惯|倾向于|常用|默认使用|总是使用|想使用|请使用|要用)[\s：:]*(.+?)(?:[。！？\n]|$)/i
  )
  if (prefMatch) add(`偏好：${prefMatch[1].trim()}`, 'preference', 'high')

  const negMatch = text.match(
    /(?:我|用户)?[\s，。]*(?:不喜欢|反感|不想|不要|拒绝|避免)[\s：:]*(.+?)(?:[。！？\n]|$)/i
  )
  if (negMatch) add(`不喜欢/避免：${negMatch[1].trim()}`, 'preference', 'high')

  // 事实
  const factPatterns = [
    /(?:请记住?|请记录)[\s：:]*(.+?)(?:[。！？\n]|$)/i,
    /(?:项目名称|工厂名称|车间名称|产线名称|设备编号|系统名称|用户名|账号|密码|API Key|模型|语言)[\s是等为]*[：:]?\s*(.+?)(?:[。！？\n]|$)/i,
  ]
  for (const pattern of factPatterns) {
    const m = text.match(pattern)
    if (m) add(m[1].trim(), 'fact', 'medium')
  }

  // 关系/三元组
  const triple = extractTriple(text)
  if (triple.subject && triple.object && candidates.length === 0) {
    add(`${triple.subject} ${triple.predicate || '是'} ${triple.object}`, 'relationship', 'medium')
  }

  return candidates.slice(0, 3)
}

async function saveCurrentState(state: {
  entries: MemoryEntry[]
  config: MemoryConfig
  lastConsolidatedAt: string | null
}): Promise<void> {
  await saveMemoryData(state.entries, state.config, state.lastConsolidatedAt)
}

async function fetchEmbedding(texts: string[]): Promise<number[][] | null> {
  if (IS_STANDALONE) return null
  try {
    const res = await embeddingApi.embed(texts)
    return res.vectors
  } catch (err) {
    console.warn('[memoryStore] embedding failed:', err)
    return null
  }
}

export const useMemoryStore = create<MemoryState>()((set, get) => ({
  entries: [],
  config: createMemoryConfig('standard'),
  lastConsolidatedAt: null,
  initialized: false,
  isLoading: false,
  error: null,
  embeddingAvailable: null,
  activeLayer: 'all',
  activeTypes: [],
  activeStatuses: ['active'],
  searchQuery: '',

  initialize: async () => {
    if (get().initialized) return
    clearLegacyMemoryStorage()
    set({ isLoading: true })
    try {
      const data = await loadMemoryData()
      set({
        entries: data.entries,
        config: { ...createMemoryConfig('standard'), ...(data.config || {}) },
        lastConsolidatedAt: data.last_consolidated_at,
        initialized: true,
        isLoading: false,
        error: null,
      })
    } catch (err) {
      set({
        initialized: true,
        isLoading: false,
        error: err instanceof Error ? err.message : '初始化记忆失败',
      })
    }
  },

  refreshEmbeddingAvailability: async () => {
    if (IS_STANDALONE) {
      set({ embeddingAvailable: false })
      return
    }
    try {
      await embeddingApi.embed(['test'])
      set({ embeddingAvailable: true })
    } catch {
      set({ embeddingAvailable: false })
    }
  },

  remember: async (input) => {
    await get().initialize()
    const state = get()
    const type = input.type || 'fact'
    const layer = input.layer || defaultLayerForType(type)
    const priority = input.priority || 'medium'

    const base = createMemoryEntry(input.content, type, priority, input.tags || [], input.metadata)
    const entry: MemoryEntry = {
      ...base,
      ...input,
      id: generateMemoryId(),
      layer,
      type,
      priority,
      status: input.status || 'active',
      created_at: now(),
      updated_at: now(),
      last_accessed_at: now(),
      access_count: 0,
      embedding: null,
    }

    // 语义层去重：相同内容更新为新输入
    const isDeduplicable =
      layer === 'semantic' || ['fact', 'preference', 'note', 'relationship'].includes(type)
    if (isDeduplicable) {
      const norm = normalizeForDedup(entry.content)
      const existing = state.entries.find(
        (e) => e.status === 'active' && normalizeForDedup(e.content) === norm
      )
      if (existing) {
        const updated: MemoryEntry = {
          ...existing,
          ...input,
          id: existing.id,
          layer,
          type,
          priority,
          status: existing.status,
          updated_at: now(),
          tags: input.tags || existing.tags,
          metadata: { ...existing.metadata, ...(input.metadata || {}) },
        }
        const next = state.entries.map((e) => (e.id === existing.id ? updated : e))
        set({ entries: next })
        await saveCurrentState({ ...get(), entries: next })
        return updated
      }
    }

    const next = [entry, ...state.entries]
    set({ entries: next })

    if (shouldEmbed(entry)) {
      const vectors = await fetchEmbedding([entry.content])
      if (vectors && vectors[0]) {
        const withVector = {
          ...entry,
          embedding: {
            vector: vectors[0],
            model: '',
            dimensions: vectors[0].length,
          },
        }
        const nextWithVector = next.map((e) => (e.id === entry.id ? withVector : e))
        set({ entries: nextWithVector, embeddingAvailable: true })
        await saveCurrentState({ ...get(), entries: nextWithVector })
        return withVector
      }
    }

    await saveCurrentState({ ...get(), entries: next })
    return entry
  },

  recall: async (query) => {
    await get().initialize()
    const state = get()
    const q = resolveQuery(query, state.config)

    let queryEmbedding: number[] | null = null
    if ((q.strategy === 'semantic' || q.strategy === 'hybrid') && q.text && !IS_STANDALONE) {
      const vectors = await fetchEmbedding([q.text])
      if (vectors && vectors[0]) {
        queryEmbedding = vectors[0]
        set({ embeddingAvailable: true })
      } else {
        set({ embeddingAvailable: false })
      }
    }

    const candidates = state.entries.filter((e) => filterEntry(q, e))

    const scored = candidates.map((entry) => {
      const scores = computeScore(entry, q, queryEmbedding)
      return {
        entry,
        score: scores.score,
        strategy: q.strategy,
        matched_keywords: extractTokens(q.text).filter((t) =>
          extractTokens(entry.content + ' ' + (entry.summary || '') + ' ' + (entry.tags || []).join(' ')).includes(t)
        ),
      }
    })

    scored.sort((a, b) => b.score - a.score)
    const results = scored.filter((r) => r.score >= q.min_score).slice(0, q.top_k)

    if (results.length > 0) {
      const ids = new Set(results.map((r) => r.entry.id))
      const touched = now()
      const next = state.entries.map((e) =>
        ids.has(e.id)
          ? { ...e, access_count: e.access_count + 1, last_accessed_at: touched }
          : e
      )
      set({ entries: next })
      saveCurrentState({ ...get(), entries: next }).catch(() => {})
    }

    return results
  },

  consolidate: async () => {
    await get().initialize()
    const state = get()
    const config = state.config
    const nowTs = Date.now()
    const touched = now()
    let entries = [...state.entries]

    // 1. 按保留期过期
    entries = entries.map((e) => {
      if (e.status !== 'active') return e
      const retention = e.retention_days ?? defaultRetentionDays(e.priority)
      const ageDays = (nowTs - new Date(e.created_at).getTime()) / 86400000
      if (ageDays > retention) {
        return { ...e, status: 'expired' as MemoryStatus, updated_at: touched }
      }
      return e
    })

    // 2. Working Memory 容量超出时归档/提升为 Episodic 摘要
    const working = entries.filter((e) => e.layer === 'working' && e.status === 'active')
    const workingMax = config.working_max_entries ?? 50
    if (working.length > workingMax) {
      const toMove = working
        .sort(
          (a, b) =>
            new Date(a.last_accessed_at).getTime() - new Date(b.last_accessed_at).getTime()
        )
        .slice(0, working.length - workingMax)
      const moveIds = new Set(toMove.map((e) => e.id))
      entries = entries.map((e) => {
        if (!moveIds.has(e.id)) return e
        if (['action', 'observation', 'error', 'code'].includes(e.type)) {
          return {
            ...e,
            layer: 'episodic',
            type: 'summary',
            summary: e.summary || e.content.slice(0, 200),
            updated_at: touched,
          }
        }
        return { ...e, status: 'archived' as MemoryStatus, updated_at: touched }
      })
    }

    // 3. Semantic 层去重，保留最新
    const semanticActive = entries
      .filter((e) => e.layer === 'semantic' && e.status === 'active')
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    const keepIds = new Set<string>()
    const duplicateIds = new Set<string>()
    for (const e of semanticActive) {
      const norm = normalizeForDedup(e.content)
      if (keepIds.has(norm)) {
        duplicateIds.add(e.id)
      } else {
        keepIds.add(norm)
      }
    }
    if (duplicateIds.size > 0) {
      entries = entries.map((e) =>
        duplicateIds.has(e.id) ? { ...e, status: 'archived' as MemoryStatus, updated_at: touched } : e
      )
    }

    set({ entries, lastConsolidatedAt: touched })
    await saveCurrentState({ ...get(), entries, lastConsolidatedAt: touched })
  },

  getUserProfile: () => {
    const { entries, config, lastConsolidatedAt } = get()
    const active = entries.filter((e) => e.status === 'active')
    const preferences = active.filter((e) => e.type === 'preference')
    const facts = active.filter((e) => e.type === 'fact')
    const recentEpisodes = active
      .filter((e) => e.layer === 'episodic' || e.type === 'conversation')
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 10)

    const working = active.filter((e) => e.layer === 'working')
    const currentTask =
      working.find((e) => e.type === 'action' || e.type === 'observation')?.content || undefined

    return {
      preferences: Object.fromEntries(
        preferences.map((p) => [p.subject || p.content, p.object || p.content])
      ),
      key_facts: facts.map((f) => f.content),
      recent_episodes: recentEpisodes.map((e) => e.summary || e.content),
      memory_stats: {
        working: {
          entry_count: working.length,
          max_entries: config.working_max_entries ?? 50,
          current_task: currentTask,
          active_goals: working.filter((e) => e.type === 'decision').map((e) => e.content),
        },
        episodic: {
          entry_count: active.filter((e) => e.layer === 'episodic').length,
          retention_days: config.episodic_retention_days ?? 30,
          last_consolidated: lastConsolidatedAt,
        },
        semantic: {
          entity_count: active.filter(
            (e) => e.layer === 'semantic' && ['fact', 'note'].includes(e.type)
          ).length,
          relationship_count: active.filter((e) => e.type === 'relationship').length,
          fact_count: facts.length,
        },
      },
    }
  },

  deleteMemory: async (id) => {
    await get().initialize()
    const next = get().entries.filter((e) => e.id !== id)
    set({ entries: next })
    await saveCurrentState({ ...get(), entries: next })
  },

  updateMemory: async (id, updates) => {
    await get().initialize()
    const next = get().entries.map((e) =>
      e.id === id ? { ...e, ...updates, updated_at: now() } : e
    )
    set({ entries: next })
    await saveCurrentState({ ...get(), entries: next })
  },

  archiveMemory: async (id) => {
    await get().initialize()
    const next = get().entries.map((e) =>
      e.id === id ? { ...e, status: 'archived' as MemoryStatus, updated_at: now() } : e
    )
    set({ entries: next })
    await saveCurrentState({ ...get(), entries: next })
  },

  setConfig: async (partial) => {
    await get().initialize()
    const config = { ...get().config, ...partial }
    set({ config })
    await saveCurrentState({ ...get(), config })
  },

  setActiveLayer: (layer) => set({ activeLayer: layer }),
  setActiveTypes: (types) => set({ activeTypes: types }),
  setActiveStatuses: (statuses) => set({ activeStatuses: statuses }),
  setSearchQuery: (query) => set({ searchQuery: query }),

  getVisibleMemories: () => {
    const { entries, activeLayer, activeTypes, activeStatuses, searchQuery } = get()
    return entries.filter((e) => {
      if (activeLayer !== 'all' && e.layer !== activeLayer) return false
      if (activeTypes.length > 0 && !activeTypes.includes(e.type)) return false
      if (activeStatuses.length > 0 && !activeStatuses.includes(e.status)) return false
      if (!searchQuery) return true
      const q = normalizeText(searchQuery)
      return (
        normalizeText(e.content).includes(q) ||
        normalizeText(e.summary || '').includes(q) ||
        (e.tags || []).some((t) => normalizeText(t).includes(q))
      )
    })
  },

  searchMemories: (query, limit = 50) => {
    const { entries } = get()
    if (!query.trim()) return entries.slice(0, limit)
    const q = normalizeText(query)
    return entries
      .filter(
        (e) =>
          normalizeText(e.content).includes(q) ||
          normalizeText(e.summary || '').includes(q) ||
          (e.tags || []).some((t) => normalizeText(t).includes(q))
      )
      .slice(0, limit)
  },

  extractAndRemember: async (text, conversationId) => {
    await get().initialize()
    const candidates = extractMemoryCandidates(text, conversationId)
    const created: MemoryEntry[] = []
    for (const input of candidates) {
      try {
        const entry = await get().remember(input)
        created.push(entry)
      } catch (err) {
        console.warn('[memoryStore] extract remember failed:', err)
      }
    }
    return created
  },
}))

// 启动时清理旧 localStorage 并初始化
useMemoryStore.getState().initialize().catch(() => {})

export { formatResultsForContext }
export type { MemoryState }
