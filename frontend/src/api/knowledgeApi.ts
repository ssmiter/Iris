import { API_BASE, getAuthHeaders } from '@/api/client'
import type {
  KnowledgeCapabilities,
  KnowledgeCollection,
  KnowledgeConflictStrategy,
  KnowledgeDomain,
  KnowledgeDocumentSummary,
  KnowledgeIngestionResult,
  KnowledgeIngestionJob,
  KnowledgeQualitySnapshot,
  KnowledgeDocumentRelationships,
  KnowledgeReadRequest,
  KnowledgeReadResult,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
  KnowledgeSourceDomain,
  KnowledgeTransferPreflight,
  KnowledgeTransferRequest,
  KnowledgeTransferResult,
  KnowledgeTransferStatus,
  KnowledgeWorkspaceIndexResult,
} from '@/types/knowledge'

type WireDomain = number | string

export class KnowledgeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'KnowledgeApiError'
  }
}

function sourceDomain(value: WireDomain): KnowledgeSourceDomain {
  if (value === 1 || String(value).toLowerCase() === 'local') return 'local'
  if (value === 2 || String(value).toLowerCase() === 'online') return 'online'
  throw new KnowledgeApiError(`Unknown knowledge domain: ${String(value)}`, 500)
}

function searchDomain(value: KnowledgeDomain): number {
  return value === 'local' ? 1 : value === 'online' ? 2 : 3
}

function conflictStrategy(value: KnowledgeConflictStrategy): number {
  return value === 'createRevision' ? 1 : value === 'createCopy' ? 2 : 3
}

function transferStatus(value: number | string): KnowledgeTransferStatus {
  const normalized = String(value).toLowerCase()
  if (value === 1 || normalized === 'pending') return 'pending'
  if (value === 2 || normalized === 'running') return 'running'
  if (value === 3 || normalized === 'succeeded') return 'succeeded'
  return 'failed'
}

function ingestionStatus(value: number | string): KnowledgeIngestionJob['status'] {
  const normalized = String(value).toLowerCase()
  if (value === 1 || normalized === 'running') return 'running'
  if (value === 2 || normalized === 'succeeded') return 'succeeded'
  if (value === 3 || normalized === 'failed') return 'failed'
  return 'cancelled'
}

const wait = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, milliseconds)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
})

const ONLINE_UPLOAD_TIMEOUT_MS = 2 * 60_000

async function requestOnlineUpload<T>(path: string, body: FormData, signal?: AbortSignal): Promise<T> {
  const timeoutController = new AbortController()
  const forwardAbort = () => timeoutController.abort(signal?.reason)
  signal?.addEventListener('abort', forwardAbort, { once: true })
  const timeout = setTimeout(() => timeoutController.abort('online-upload-timeout'), ONLINE_UPLOAD_TIMEOUT_MS)
  try {
    return await request<T>(path, { method: 'POST', body, signal: timeoutController.signal })
  } catch (error) {
    if (timeoutController.signal.aborted && !signal?.aborted) {
      throw new KnowledgeApiError('在线文档处理超过 2 分钟，已停止等待；请检查网络或稍后重试', 408)
    }
    throw error
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', forwardAbort)
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = { ...getAuthHeaders(), ...(init.headers || {}) }
  if (init.body instanceof FormData) delete (headers as Record<string, string>)['Content-Type']
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  })
  if (!response.ok) {
    let details: unknown
    try { details = await response.json() } catch { details = await response.text() }
    const problem = details as { title?: string; detail?: string; error?: string } | null
    throw new KnowledgeApiError(
      problem?.detail || problem?.title || problem?.error || `HTTP ${response.status}`,
      response.status,
      details,
    )
  }
  return response.json() as Promise<T>
}

function normalizeCollection(raw: KnowledgeCollection & { domain: WireDomain }): KnowledgeCollection {
  return { ...raw, domain: sourceDomain(raw.domain) }
}

function normalizeSearch(raw: KnowledgeSearchResponse): KnowledgeSearchResponse {
  return {
    ...raw,
    results: raw.results.map((item) => ({
      citation: { ...item.citation, domain: sourceDomain(item.citation.domain as unknown as WireDomain) },
    })),
    providers: raw.providers.map((provider) => ({
      ...provider,
      domain: sourceDomain(provider.domain as unknown as WireDomain),
    })),
  }
}

function normalizeRead(raw: KnowledgeReadResult): KnowledgeReadResult {
  return { ...raw, domain: sourceDomain(raw.domain as unknown as WireDomain) }
}

function normalizeTransfer(raw: KnowledgeTransferResult): KnowledgeTransferResult {
  return {
    ...raw,
    sourceDomain: sourceDomain(raw.sourceDomain as unknown as WireDomain),
    targetDomain: sourceDomain(raw.targetDomain as unknown as WireDomain),
    status: transferStatus(raw.status as unknown as number | string),
  }
}

export const knowledgeApi = {
  capabilities: (signal?: AbortSignal) =>
    request<KnowledgeCapabilities>('/api/knowledge/capabilities', { signal }),

  quality: (signal?: AbortSignal) =>
    request<KnowledgeQualitySnapshot>('/api/knowledge/quality', { signal }),

  relationships: (documentId: string, signal?: AbortSignal) =>
    request<KnowledgeDocumentRelationships>(
      `/api/knowledge/documents/${encodeURIComponent(documentId)}/relationships`, { signal },
    ),

  exportRevision: async (documentId: string, revision: number, signal?: AbortSignal) => {
    const response = await fetch(`${API_BASE}/api/knowledge/documents/${encodeURIComponent(documentId)}/revisions/${revision}/export`, {
      headers: { ...getAuthHeaders() }, credentials: 'include', signal,
    })
    if (!response.ok) throw new KnowledgeApiError(`HTTP ${response.status}`, response.status)
    return response.blob()
  },

  originalRevision: async (documentId: string, revision: number, inline = false, signal?: AbortSignal) => {
    const response = await fetch(
      `${API_BASE}/api/knowledge/documents/${encodeURIComponent(documentId)}/revisions/${revision}/original?domain=2&inline=${inline}`,
      { headers: { ...getAuthHeaders() }, credentials: 'include', signal },
    )
    if (!response.ok) {
      let details: unknown
      try { details = await response.json() } catch { details = await response.text() }
      const problem = details as { title?: string; detail?: string } | null
      throw new KnowledgeApiError(problem?.detail || problem?.title || `HTTP ${response.status}`, response.status, details)
    }
    return response.blob()
  },

  collections: async (domain: KnowledgeSourceDomain, signal?: AbortSignal) => {
    const items = await request<Array<KnowledgeCollection & { domain: WireDomain }>>(
      `/api/knowledge/collections?domain=${domain === 'local' ? 1 : 2}`,
      { signal },
    )
    return items.map(normalizeCollection)
  },

  documents: async (collectionId: string, domain: KnowledgeSourceDomain = 'local', signal?: AbortSignal) => {
    const items = await request<Array<KnowledgeDocumentSummary & { domain: WireDomain }>>(
      `/api/knowledge/collections/${encodeURIComponent(collectionId)}/documents?domain=${domain === 'local' ? 1 : 2}`,
      { signal },
    )
    return items.map((item) => ({ ...item, domain: sourceDomain(item.domain) }))
  },

  replaceDocumentTags: (documentId: string, tags: string[], signal?: AbortSignal) =>
    fetch(`${API_BASE}/api/knowledge/documents/${encodeURIComponent(documentId)}/tags`, {
      method: 'PUT',
      headers: { ...getAuthHeaders() },
      credentials: 'include',
      body: JSON.stringify({ tags }),
      signal,
    }).then(async (response) => {
      if (!response.ok) throw new KnowledgeApiError(`HTTP ${response.status}`, response.status)
    }),

  deleteDocument: (documentId: string, domain: KnowledgeSourceDomain, signal?: AbortSignal) =>
    fetch(`${API_BASE}/api/knowledge/documents/${encodeURIComponent(documentId)}?domain=${domain === 'local' ? 1 : 2}`, {
      method: 'DELETE', headers: { ...getAuthHeaders() }, credentials: 'include', signal,
    }).then(async (response) => {
      if (!response.ok) throw new KnowledgeApiError(`HTTP ${response.status}`, response.status)
    }),

  createCollection: async (name: string, description?: string | null, domain: KnowledgeSourceDomain = 'local') =>
    normalizeCollection(await request<KnowledgeCollection & { domain: WireDomain }>(
      '/api/knowledge/collections',
      { method: 'POST', body: JSON.stringify({ name, description: description || null, domain: domain === 'local' ? 1 : 2 }) },
    )),

  upload: async (collectionId: string, file: File, domain: KnowledgeSourceDomain = 'local', signal?: AbortSignal, onProgress?: (job: KnowledgeIngestionJob) => void) => {
    const body = new FormData()
    body.append('file', file, file.name)
    if (domain === 'online') {
      return requestOnlineUpload<KnowledgeIngestionResult>(
        `/api/knowledge/collections/${encodeURIComponent(collectionId)}/documents?domain=2`,
        body,
        signal,
      )
    }
    const accepted = await request<{ jobId: string; status: number | string }>(
      `/api/knowledge/collections/${encodeURIComponent(collectionId)}/documents/async`,
      { method: 'POST', body, signal },
    )
    const deadline = Date.now() + 5 * 60_000
    while (Date.now() < deadline) {
      const raw = await request<KnowledgeIngestionJob & { status: number | string }>(
        `/api/knowledge/jobs/${encodeURIComponent(accepted.jobId)}`, { signal },
      )
      const job = { ...raw, status: ingestionStatus(raw.status) }
      onProgress?.(job)
      if (job.status === 'succeeded') return job
      if (job.status === 'failed') throw new KnowledgeApiError(`文档索引失败：${job.errorCode || '未知错误'}`, 422, job)
      if (job.status === 'cancelled') throw new KnowledgeApiError('文档索引已取消', 409, job)
      await wait(500, signal)
    }
    throw new KnowledgeApiError('文档索引等待超时，可稍后在任务状态中查看', 408)
  },

  ingestionJob: async (jobId: string, signal?: AbortSignal) => {
    const raw = await request<KnowledgeIngestionJob & { status: number | string }>(
      `/api/knowledge/jobs/${encodeURIComponent(jobId)}`, { signal },
    )
    return { ...raw, status: ingestionStatus(raw.status) }
  },

  cancelIngestion: (jobId: string, signal?: AbortSignal) =>
    fetch(`${API_BASE}/api/knowledge/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST', headers: { ...getAuthHeaders() }, credentials: 'include', signal,
    }).then(async (response) => { if (!response.ok) throw new KnowledgeApiError(`HTTP ${response.status}`, response.status) }),

  retryIngestion: (jobId: string, signal?: AbortSignal) =>
    request<{ jobId: string; status: number | string }>(
      `/api/knowledge/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST', signal },
    ),

  indexWorkspace: (collectionId: string, rootIndex: number, relativePath: string, signal?: AbortSignal) =>
    request<KnowledgeWorkspaceIndexResult>(
      `/api/knowledge/collections/${encodeURIComponent(collectionId)}/workspace-imports`,
      { method: 'POST', body: JSON.stringify({ rootIndex, relativePath }), signal },
    ),

  search: async (input: KnowledgeSearchRequest, signal?: AbortSignal) => normalizeSearch(
    await request<KnowledgeSearchResponse>('/api/knowledge/search', {
      method: 'POST',
      body: JSON.stringify({
        ...input,
        domain: searchDomain(input.domain),
        ownerUserId: 0,
        collectionId: input.collectionId || null,
        limit: input.limit ?? 12,
      }),
      signal,
    }),
  ),

  read: async (input: KnowledgeReadRequest, signal?: AbortSignal) => normalizeRead(
    await request<KnowledgeReadResult>('/api/knowledge/read', {
      method: 'POST',
      body: JSON.stringify({ ...input, domain: input.domain === 'local' ? 1 : 2 }),
      signal,
    }),
  ),

  preflight: (input: KnowledgeTransferRequest, signal?: AbortSignal) =>
    request<KnowledgeTransferPreflight>('/api/knowledge/transfers/preflight', {
      method: 'POST', body: JSON.stringify({
        ...input,
        sourceDomain: input.sourceDomain === 'local' ? 1 : 2,
        targetDomain: input.targetDomain === 'local' ? 1 : 2,
        conflictStrategy: conflictStrategy(input.conflictStrategy),
      }), signal,
    }),

  transfer: async (input: KnowledgeTransferRequest, signal?: AbortSignal) => normalizeTransfer(
    await request<KnowledgeTransferResult>('/api/knowledge/transfers', {
      method: 'POST', body: JSON.stringify({
        ...input,
        sourceDomain: input.sourceDomain === 'local' ? 1 : 2,
        targetDomain: input.targetDomain === 'local' ? 1 : 2,
        conflictStrategy: conflictStrategy(input.conflictStrategy),
      }), signal,
    }),
  ),
}
