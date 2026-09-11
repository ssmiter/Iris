export type KnowledgeSourceDomain = 'local' | 'online'
export type KnowledgeDomain = KnowledgeSourceDomain | 'both'

export interface KnowledgeCapabilities {
  enabled: boolean
  localAvailable: boolean
  onlineConfigured: boolean
  onlineAvailable: boolean
  mesAuthenticated: boolean
  onlineUnavailableReason: 'not_configured' | 'mes_login_required' | 'database_or_schema_unavailable' | null
  maxSearchLimit: number
  maxFileBytes: number
  workspaceRoots?: Array<{ index: number; label: string }>
}

export interface KnowledgeCollection {
  id: string
  domain: KnowledgeSourceDomain
  provider: string
  ownerUserId: number
  name: string
  description: string | null
  createdAt: string
  updatedAt: string
}

export interface KnowledgeDocumentSummary {
  id: string
  domain: KnowledgeSourceDomain
  provider: string
  ownerUserId: number
  collectionId: string
  title: string
  sourceLocator: string
  mimeType: string
  currentRevision: number
  byteLength: number
  chunkCount: number
  vectorChunkCount: number
  tags: string[]
  headingPaths: string[]
  updatedAt: string
  uploadedByUserId?: number | null
  uploadedByName?: string | null
  uploadedAt?: string | null
}

export interface KnowledgeCitation {
  domain: KnowledgeSourceDomain
  provider: string
  collectionId: string
  documentId: string
  revision: number
  chunkOrdinal: number
  title: string
  sourceLocator: string
  snippet: string
  keywordScore: number
  vectorScore: number
  finalScore: number
  startLine: number | null
  endLine: number | null
}

export interface KnowledgeSearchCandidate {
  citation: KnowledgeCitation
}

export interface KnowledgeProviderStatus {
  domain: KnowledgeSourceDomain
  provider: string
  succeeded: boolean
  error: string | null
  elapsedMilliseconds: number
}

export interface KnowledgeSearchRequest {
  domain: KnowledgeDomain
  query: string
  collectionId?: string | null
  limit?: number
  tags?: string[] | null
  mimeTypes?: string[] | null
  updatedAfter?: string | null
  updatedBefore?: string | null
}

export interface KnowledgeSearchResponse {
  results: KnowledgeSearchCandidate[]
  providers: KnowledgeProviderStatus[]
  partial: boolean
  elapsedMilliseconds: number
}

export interface KnowledgeReadRequest {
  domain: KnowledgeSourceDomain
  provider?: string | null
  documentId: string
  revision: number
  chunkOrdinal?: number | null
}

export interface KnowledgeReadResult {
  domain: KnowledgeSourceDomain
  provider: string
  collectionId: string
  documentId: string
  revision: number
  chunkOrdinal: number | null
  title: string
  sourceLocator: string
  mimeType: string
  content: string
  startLine: number | null
  endLine: number | null
  revisionCreatedAt: string
  uploadedByUserId?: number | null
  uploadedByName?: string | null
  originalFileName?: string | null
  originalByteLength?: number | null
}

export type KnowledgeConflictStrategy = 'createRevision' | 'createCopy' | 'skip'
export type KnowledgeTransferStatus = 'pending' | 'running' | 'succeeded' | 'failed'

export interface KnowledgeTransferRequest {
  operationKey: string
  sourceDomain: KnowledgeSourceDomain
  targetDomain: KnowledgeSourceDomain
  sourceDocumentId: string
  sourceRevision: number
  targetCollectionId: string
  conflictStrategy: KnowledgeConflictStrategy
}

export interface KnowledgeTransferIssue {
  code: string
  message: string
  blocking: boolean
}

export interface KnowledgeTransferPreflight {
  allowed: boolean
  issues: KnowledgeTransferIssue[]
}

export interface KnowledgeTransferResult {
  operationKey: string
  status: KnowledgeTransferStatus
  sourceDomain: KnowledgeSourceDomain
  sourceDocumentId: string
  sourceRevision: number
  targetDomain: KnowledgeSourceDomain
  targetDocumentId: string
  targetRevision: number
  completedAt: string
}

export interface KnowledgeIngestionResult {
  outcome: 'created' | 'updated' | 'unchanged'
  documentId: string
  revision: number
  sourceFingerprint: string
  chunkCount: number
}

export type KnowledgeIngestionJobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface KnowledgeIngestionJob {
  id: string
  status: KnowledgeIngestionJobStatus
  sourceCount: number
  processedCount: number
  failedCount: number
  sourceLabel: string
  errorCode: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface KnowledgeWorkspaceIndexResult {
  processedCount: number
  documents: KnowledgeIngestionResult[]
  failures: Array<{ sourceLocator: string; code: string }>
}

export interface KnowledgeQualitySnapshot {
  collectionCount: number
  documentCount: number
  revisionCount: number
  chunkCount: number
  vectorChunkCount: number
  runningJobCount: number
  failedJobCount: number
  searchCount: number
  noAnswerSearchCount: number
  invalidCitationCount: number
  vectorCoverage: number
  generatedAt: string
  formats: Array<{ mimeType: string; documentCount: number }>
  hotDocuments: Array<{ documentId: string; title: string; sourceLocator: string; readCount: number }>
}

export interface KnowledgeDocumentRelationships {
  documentId: string
  related: Array<{
    documentId: string
    collectionId: string
    title: string
    sourceLocator: string
    revision: number
    sharedTags: string[]
    updatedAt: string
  }>
  revisions: Array<{
    revision: number
    contentHash: string
    byteLength: number
    createdAt: string
  }>
}

export interface KnowledgeLensSelection {
  domain: KnowledgeDomain
  collectionId: string | null
  collectionName?: string | null
}
