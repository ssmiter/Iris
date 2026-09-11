import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { knowledgeApi } from '@/api/knowledgeApi'
import { KnowledgeSearchCache, isCacheableKnowledgeRequest, normalizeKnowledgeSearchKey } from './knowledgeSearchPolicy'
import type {
  KnowledgeCapabilities,
  KnowledgeCitation,
  KnowledgeCollection,
  KnowledgeDomain,
  KnowledgeDocumentSummary,
  KnowledgeIngestionJob,
  KnowledgeReadResult,
  KnowledgeSearchResponse,
  KnowledgeSourceDomain,
  KnowledgeTransferPreflight,
  KnowledgeTransferRequest,
  KnowledgeTransferResult,
} from '@/types/knowledge'

interface KnowledgeState {
  capabilities: KnowledgeCapabilities | null
  initialized: boolean
  domain: KnowledgeDomain
  query: string
  tags: string[]
  mimeTypes: string[]
  updatedAfter: string | null
  updatedBefore: string | null
  selectedCollectionId: string | null
  collections: Record<KnowledgeSourceDomain, KnowledgeCollection[]>
  documents: KnowledgeDocumentSummary[]
  search: KnowledgeSearchResponse | null
  selectedCitation: KnowledgeCitation | null
  readResult: KnowledgeReadResult | null
  transferPreflight: KnowledgeTransferPreflight | null
  transferResult: KnowledgeTransferResult | null
  loading: boolean
  reading: boolean
  documentsLoading: boolean
  mutating: boolean
  activeIngestionJob: KnowledgeIngestionJob | null
  error: string | null
  /** 文档卡片缓存：key=collectionId，/knowledge VFS 物化与知识库页共用；不入 persist */
  documentsByCollection: Record<string, KnowledgeDocumentSummary[]>
  /** VFS 物化用：确保某集合的文档摘要已加载（去重并发、失败静默——VFS 少物化一级而已） */
  ensureDocuments: (collectionId: string, domain: KnowledgeSourceDomain) => Promise<void>
  initialize: () => Promise<void>
  /** 供 chatStore 发消息时调用：后台预热 capabilities+collections（fire-and-forget），
   * 首轮不注入清单、下一轮起生效；不阻塞发送，失败静默（capabilities 拉不到=不注入） */
  ensurePromptWarm: () => void
  loadCollections: (domain?: KnowledgeSourceDomain) => Promise<void>
  loadDocuments: (collectionId: string) => Promise<void>
  setDomain: (domain: KnowledgeDomain) => void
  setQuery: (query: string) => void
  setFilters: (filters: Partial<Pick<KnowledgeState, 'tags' | 'mimeTypes' | 'updatedAfter' | 'updatedBefore'>>) => void
  setCollection: (collectionId: string | null) => void
  runSearch: (query?: string) => Promise<void>
  openCitation: (citation: KnowledgeCitation) => Promise<void>
  openDocument: (document: KnowledgeDocumentSummary) => Promise<void>
  replaceDocumentTags: (documentId: string, tags: string[]) => Promise<void>
  deleteDocument: (documentId: string) => Promise<void>
  closeInspector: () => void
  createCollection: (name: string, description?: string) => Promise<KnowledgeCollection>
  upload: (collectionId: string, file: File) => Promise<void>
  indexWorkspace: (collectionId: string, rootIndex: number, relativePath: string) => Promise<void>
  preflightTransfer: (request: KnowledgeTransferRequest) => Promise<KnowledgeTransferPreflight>
  executeTransfer: (request: KnowledgeTransferRequest) => Promise<KnowledgeTransferResult>
  clearError: () => void
}

let searchController: AbortController | null = null
let searchSequence = 0
let searchDebounce: ReturnType<typeof setTimeout> | null = null
const searchCache = new KnowledgeSearchCache()
// prompt 清单预热防重入（2026-08-16）：chatStore 每条消息都会尝试预热，
// 模块级 Promise 保证 initialize 只触发一次；initialized 后由常规刷新路径维护。
// knowledgeVfs 经 knowledgeStoreReady() 等待预热完成（grep/list 前确保清单可用）。
let promptWarmPromise: Promise<void> | null = null
export function knowledgeStoreReady(): Promise<void> {
  return promptWarmPromise ?? Promise.resolve()
}
// 文档卡片缓存的加载去重（/knowledge VFS 物化用）：同集合并发只发一次请求
const documentsInflight = new Map<string, Promise<void>>()

function cancelDebounce(): void {
  if (searchDebounce) clearTimeout(searchDebounce)
  searchDebounce = null
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : '知识库请求失败'

export const useKnowledgeStore = create<KnowledgeState>()(persist((set, get) => ({
  capabilities: null,
  initialized: false,
  domain: 'local',
  query: '',
  tags: [],
  mimeTypes: [],
  updatedAfter: null,
  updatedBefore: null,
  selectedCollectionId: null,
  collections: { local: [], online: [] },
  documents: [],
  documentsByCollection: {},
  search: null,
  selectedCitation: null,
  readResult: null,
  transferPreflight: null,
  transferResult: null,
  loading: false,
  reading: false,
  documentsLoading: false,
  mutating: false,
  activeIngestionJob: null,
  error: null,

  initialize: async () => {
    try {
      const capabilities = await knowledgeApi.capabilities()
      let domain = get().domain
      if (domain === 'online' && !capabilities.onlineAvailable) domain = 'local'
      if (domain === 'both' && !capabilities.onlineAvailable) domain = 'local'
      set({ capabilities, initialized: true, domain, error: null })
      if (capabilities.enabled) {
        const loads: Array<Promise<void>> = []
        if (capabilities.localAvailable) loads.push(get().loadCollections('local'))
        if (capabilities.onlineAvailable) loads.push(get().loadCollections('online'))
        await Promise.all(loads)
        const selectedCollectionId = get().selectedCollectionId
        if (selectedCollectionId && get().domain !== 'both') await get().loadDocuments(selectedCollectionId)
      }
    } catch (error) {
      set({ initialized: true, error: errorMessage(error) })
    }
  },

  ensurePromptWarm: () => {
    if (promptWarmPromise || get().initialized) return
    promptWarmPromise = get().initialize().catch(() => {})
  },

  ensureDocuments: async (collectionId, domain) => {
    if (get().documentsByCollection[collectionId]) return
    let inflight = documentsInflight.get(collectionId)
    if (!inflight) {
      inflight = (async () => {
        try {
          const docs = await knowledgeApi.documents(collectionId, domain)
          set((s) => ({
            documentsByCollection: { ...s.documentsByCollection, [collectionId]: docs },
          }))
        } catch {
          // 静默：VFS 少物化一级卡片，知识库页有自己的错误面
        } finally {
          documentsInflight.delete(collectionId)
        }
      })()
      documentsInflight.set(collectionId, inflight)
    }
    await inflight
  },

  loadCollections: async (domain = 'local') => {
    if (domain === 'online' && !get().capabilities?.onlineAvailable) return
    try {
      const collections = await knowledgeApi.collections(domain)
      set((state) => ({ collections: { ...state.collections, [domain]: collections }, error: null }))
    } catch (error) {
      set({ error: errorMessage(error) })
    }
  },

  loadDocuments: async (collectionId) => {
    set({ documentsLoading: true, error: null })
    try {
      const currentDomain = get().domain === 'online' ? 'online' : 'local'
      const documents = await knowledgeApi.documents(collectionId, currentDomain)
      // 同步进 VFS 卡片缓存：UI 路径（增删/上传/导入后刷新）同时刷新 /knowledge 物化面
      set((s) => ({
        documentsByCollection: { ...s.documentsByCollection, [collectionId]: documents },
      }))
      if (get().selectedCollectionId === collectionId) set({ documents, documentsLoading: false })
      else set({ documentsLoading: false })
    } catch (error) {
      set({ documentsLoading: false, error: errorMessage(error) })
    }
  },

  setDomain: (domain) => {
    set({ domain, selectedCollectionId: null, documents: [], search: null })
    cancelDebounce()
    if (get().query.trim().length >= 2) searchDebounce = setTimeout(() => void get().runSearch(), 420)
  },
  setQuery: (query) => {
    set({ query })
    cancelDebounce()
    if (query.trim().length >= 2) searchDebounce = setTimeout(() => void get().runSearch(query), 420)
  },
  setFilters: (filters) => {
    set(filters)
    cancelDebounce()
    if (get().query.trim().length >= 2) searchDebounce = setTimeout(() => void get().runSearch(), 180)
  },
  setCollection: (selectedCollectionId) => {
    set({ selectedCollectionId, documents: [], search: null, selectedCitation: null, readResult: null })
    cancelDebounce()
    if (selectedCollectionId && get().domain !== 'both') void get().loadDocuments(selectedCollectionId)
    if (get().query.trim().length >= 2) searchDebounce = setTimeout(() => void get().runSearch(), 420)
  },

  runSearch: async (nextQuery) => {
    const query = (nextQuery ?? get().query).trim()
    if (!query) return
    cancelDebounce()
    searchController?.abort()
    searchController = new AbortController()
    const sequence = ++searchSequence
    const request = {
      domain: get().domain,
      query,
      collectionId: get().selectedCollectionId,
      limit: Math.min(30, get().capabilities?.maxSearchLimit ?? 30),
      tags: get().tags,
      mimeTypes: get().mimeTypes,
      updatedAfter: get().updatedAfter,
      updatedBefore: get().updatedBefore,
    } as const
    const cacheKey = normalizeKnowledgeSearchKey(request)
    const cacheable = isCacheableKnowledgeRequest(request)
    const cached = cacheable ? searchCache.get(cacheKey) : undefined
    if (cached) {
      set({ query, search: cached, loading: false, error: null })
      return
    }
    set({ query, loading: true, error: null })
    try {
      const response = await knowledgeApi.search(request, searchController.signal)
      if (sequence === searchSequence) {
        if (cacheable) searchCache.set(cacheKey, response)
        set({ search: response, loading: false })
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (sequence === searchSequence) set({ loading: false, error: errorMessage(error) })
    }
  },

  openCitation: async (citation) => {
    set({ selectedCitation: citation, readResult: null, reading: true, error: null })
    try {
      const readResult = await knowledgeApi.read({
        domain: citation.domain,
        provider: citation.provider,
        documentId: citation.documentId,
        revision: citation.revision,
        chunkOrdinal: citation.chunkOrdinal,
      })
      if (get().selectedCitation === citation) set({ readResult, reading: false })
    } catch (error) {
      set({ reading: false, error: errorMessage(error) })
    }
  },

  openDocument: async (document) => {
    const citation: KnowledgeCitation = {
      domain: document.domain,
      provider: document.provider,
      collectionId: document.collectionId,
      documentId: document.id,
      revision: document.currentRevision,
      chunkOrdinal: 0,
      title: document.title,
      sourceLocator: document.sourceLocator,
      snippet: '',
      keywordScore: 0,
      vectorScore: 0,
      finalScore: 0,
      startLine: null,
      endLine: null,
    }
    set({ selectedCitation: citation, readResult: null, reading: true, error: null })
    try {
      const readResult = await knowledgeApi.read({
        domain: document.domain,
        provider: document.provider,
        documentId: document.id,
        revision: document.currentRevision,
        chunkOrdinal: null,
      })
      if (get().selectedCitation?.documentId === document.id) set({ readResult, reading: false })
    } catch (error) {
      set({ reading: false, error: errorMessage(error) })
    }
  },

  closeInspector: () => set({ selectedCitation: null, readResult: null }),

  replaceDocumentTags: async (documentId, tags) => {
    const collectionId = get().selectedCollectionId
    if (!collectionId || get().domain !== 'local') throw new Error('只有本地知识文档可以在这里编辑标签')
    set({ mutating: true, error: null })
    try {
      await knowledgeApi.replaceDocumentTags(documentId, tags)
      await get().loadDocuments(collectionId)
      set({ mutating: false })
      if (get().query.trim()) await get().runSearch()
    } catch (error) {
      set({ mutating: false, error: errorMessage(error) })
      throw error
    }
  },

  deleteDocument: async (documentId) => {
    const collectionId = get().selectedCollectionId
    const domain = get().domain
    if (!collectionId || domain === 'both') throw new Error('请先进入本地或在线集合再删除文档')
    set({ mutating: true, error: null })
    try {
      await knowledgeApi.deleteDocument(documentId, domain)
      if (get().selectedCitation?.documentId === documentId) set({ selectedCitation: null, readResult: null })
      await get().loadDocuments(collectionId)
      set({ mutating: false })
      if (get().query.trim()) await get().runSearch()
    } catch (error) {
      set({ mutating: false, error: errorMessage(error) })
      throw error
    }
  },

  createCollection: async (name, description) => {
    set({ mutating: true, error: null })
    try {
      const collectionDomain = get().domain === 'online' ? 'online' : 'local'
      const collection = await knowledgeApi.createCollection(name, description, collectionDomain)
      set((state) => ({
        collections: { ...state.collections, [collectionDomain]: [...state.collections[collectionDomain], collection] },
        selectedCollectionId: collection.id,
        documents: [],
        mutating: false,
      }))
      return collection
    } catch (error) {
      set({ mutating: false, error: errorMessage(error) })
      throw error
    }
  },

  upload: async (collectionId, file) => {
    set({ mutating: true, activeIngestionJob: null, error: null })
    try {
      const uploadDomain = get().domain === 'online' ? 'online' : 'local'
      await knowledgeApi.upload(collectionId, file, uploadDomain, undefined, (activeIngestionJob) => set({ activeIngestionJob }))
      await get().loadDocuments(collectionId)
      set({ mutating: false })
      if (get().query.trim()) await get().runSearch()
    } catch (error) {
      set({ mutating: false, error: errorMessage(error) })
      throw error
    }
  },

  indexWorkspace: async (collectionId, rootIndex, relativePath) => {
    set({ mutating: true, error: null })
    try {
      const result = await knowledgeApi.indexWorkspace(collectionId, rootIndex, relativePath)
      await get().loadDocuments(collectionId)
      set({
        mutating: false,
        error: result.failures.length > 0
          ? `已索引 ${result.processedCount} 个文件，${result.failures.length} 个文件未处理。`
          : null,
      })
      if (get().query.trim()) await get().runSearch()
    } catch (error) {
      set({ mutating: false, error: errorMessage(error) })
      throw error
    }
  },

  preflightTransfer: async (request) => {
    set({ mutating: true, transferPreflight: null, transferResult: null, error: null })
    try {
      const transferPreflight = await knowledgeApi.preflight(request)
      set({ transferPreflight, mutating: false })
      return transferPreflight
    } catch (error) {
      set({ mutating: false, error: errorMessage(error) })
      throw error
    }
  },

  executeTransfer: async (request) => {
    set({ mutating: true, transferResult: null, error: null })
    try {
      const transferResult = await knowledgeApi.transfer(request)
      set({ transferResult, mutating: false })
      await get().loadCollections(request.targetDomain)
      return transferResult
    } catch (error) {
      set({ mutating: false, error: errorMessage(error) })
      throw error
    }
  },

  clearError: () => set({ error: null }),
}), {
  name: 'wonwork-knowledge-view',
  partialize: (state) => ({
    domain: state.domain,
    selectedCollectionId: state.selectedCollectionId,
    tags: state.tags,
    mimeTypes: state.mimeTypes,
    updatedAfter: state.updatedAfter,
    updatedBefore: state.updatedBefore,
  }),
}))
