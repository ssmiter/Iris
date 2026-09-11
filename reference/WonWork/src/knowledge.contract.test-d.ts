import type {
  KnowledgeCapabilities,
  KnowledgeCitation,
  KnowledgeDomain,
  KnowledgeDocumentSummary,
  KnowledgeSearchResponse,
} from '@/types/knowledge'
import { knowledgeApi } from '@/api/knowledgeApi'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { KnowledgeWorkspace } from '@/components/Knowledge/KnowledgeWorkspace'
import { KnowledgeToolResultRenderer } from '@/agent/tools/knowledgeToolRenderers'
import { useKnowledgeNavigationStore } from '@/stores/knowledgeNavigationStore'
import { KnowledgeFilterRibbon } from '@/components/Knowledge/KnowledgeFilterRibbon'

const domain: KnowledgeDomain = 'both'
const capabilities: KnowledgeCapabilities = {
  enabled: true,
  localAvailable: true,
  onlineConfigured: true,
  onlineAvailable: true,
  mesAuthenticated: true,
  onlineUnavailableReason: null,
  maxSearchLimit: 50,
  maxFileBytes: 52_428_800,
}

const citation: KnowledgeCitation = {
  domain: 'local',
  provider: 'workspace',
  collectionId: 'collection',
  documentId: 'document',
  revision: 1,
  chunkOrdinal: 0,
  title: 'Runbook',
  sourceLocator: 'runbook.md',
  snippet: 'restart service',
  keywordScore: 1,
  vectorScore: 0,
  finalScore: 1,
  startLine: 1,
  endLine: 2,
}

const response: KnowledgeSearchResponse = {
  results: [{ citation }],
  providers: [],
  partial: false,
  elapsedMilliseconds: 1,
}

const document: KnowledgeDocumentSummary = {
  id: 'document',
  domain: 'local',
  provider: 'workspace',
  ownerUserId: 1,
  collectionId: 'collection',
  title: 'Runbook',
  sourceLocator: 'runbook.md',
  mimeType: 'text/markdown',
  currentRevision: 1,
  byteLength: 4096,
  chunkCount: 3,
  vectorChunkCount: 3,
  tags: ['runbook'],
  headingPaths: ['Runbook / Restart'],
  updatedAt: new Date().toISOString(),
}

void knowledgeApi.documents('collection', 'local')
void useKnowledgeStore.getState().loadDocuments('collection')
void useKnowledgeStore.getState().openDocument(document)

void domain
void capabilities
void response
void knowledgeApi
void useKnowledgeStore
void KnowledgeWorkspace
void KnowledgeToolResultRenderer
void useKnowledgeNavigationStore
void KnowledgeFilterRibbon
