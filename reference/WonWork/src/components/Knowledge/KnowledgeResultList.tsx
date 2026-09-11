import { ArrowUpRight, Cloud, Database, FileText, Timer, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import type { KnowledgeCitation, KnowledgeProviderStatus } from '@/types/knowledge'
import { KnowledgeResourceExplorer } from './KnowledgeResourceExplorer'

function ProviderPill({ provider }: { provider: KnowledgeProviderStatus }) {
  const { t } = useTranslation()
  return (
    <span className={provider.succeeded ? 'ww-kb-provider is-ok' : 'ww-kb-provider is-error'}>
      {provider.domain === 'local' ? <Database size={11} /> : <Cloud size={11} />}
      {provider.domain === 'local' ? t('knowledge.result.domainLocal') : t('knowledge.result.domainOnline')}
      <i />
      {provider.elapsedMilliseconds}ms
    </span>
  )
}

function ResultCard({ citation, rank }: { citation: KnowledgeCitation; rank: number }) {
  const { t } = useTranslation()
  const openCitation = useKnowledgeStore((state) => state.openCitation)
  const selected = useKnowledgeStore((state) => state.selectedCitation)
  const isSelected = selected?.documentId === citation.documentId
    && selected.revision === citation.revision
    && selected.chunkOrdinal === citation.chunkOrdinal

  return (
    <button
      type="button"
      className={isSelected ? 'ww-kb-result is-selected' : 'ww-kb-result'}
      onClick={() => void openCitation(citation)}
    >
      <span className="ww-kb-result-rank">{String(rank).padStart(2, '0')}</span>
      <span className="ww-kb-result-body">
        <span className="ww-kb-result-meta">
          <em className={citation.domain === 'local' ? 'is-local' : 'is-online'}>
            {citation.domain === 'local' ? <Database size={11} /> : <Cloud size={11} />}
            {citation.domain === 'local' ? t('knowledge.result.domainLocal') : t('knowledge.result.domainOnline')}
          </em>
          <span>{t('knowledge.result.revision', { revision: citation.revision })}</span>
          <span>{t('knowledge.result.chunk', { ordinal: citation.chunkOrdinal + 1 })}</span>
          {citation.startLine && <span>{t('knowledge.result.lineRange', { start: citation.startLine, end: citation.endLine ? `–${citation.endLine}` : '' })}</span>}
        </span>
        <strong>{citation.title}</strong>
        <p>{citation.snippet || t('knowledge.result.noSnippet')}</p>
        <span className="ww-kb-result-source"><FileText size={12} />{citation.sourceLocator}</span>
      </span>
      <span className="ww-kb-result-score"><ArrowUpRight size={14} /></span>
    </button>
  )
}

export function KnowledgeResultList() {
  const { t } = useTranslation()
  const response = useKnowledgeStore((state) => state.search)
  const loading = useKnowledgeStore((state) => state.loading)
  const query = useKnowledgeStore((state) => state.query)
  const domain = useKnowledgeStore((state) => state.domain)
  const selectedCollectionId = useKnowledgeStore((state) => state.selectedCollectionId)
  const collections = useKnowledgeStore((state) => state.collections)
  const documents = useKnowledgeStore((state) => state.documents)
  const documentsLoading = useKnowledgeStore((state) => state.documentsLoading)
  const openDocument = useKnowledgeStore((state) => state.openDocument)
  const replaceDocumentTags = useKnowledgeStore((state) => state.replaceDocumentTags)
  const deleteDocument = useKnowledgeStore((state) => state.deleteDocument)

  if (loading) {
    return <div className="ww-kb-result-loading" aria-live="polite"><span /><span /><span /><p>{t('knowledge.result.searching')}</p></div>
  }

  if (!response) {
    if (domain !== 'both' && selectedCollectionId) {
      const collectionName = collections[domain].find((item) => item.id === selectedCollectionId)?.name || t('knowledge.result.currentCollectionFallback')
      return (
        <section className="ww-kb-documents" aria-label={t('knowledge.result.documentsAriaLabel', { collectionName })}>
          <header>
            <div><h2>{collectionName}<small>{t('knowledge.result.documentCount', { count: documents.length })}</small></h2></div>
            <p>{t('knowledge.result.documentsHint')}</p>
          </header>
          {!documentsLoading && documents.length === 0 ? (
            <div className="ww-kb-document-empty"><FileText size={22} /><b>{t('knowledge.result.emptyCollectionTitle')}</b><span>{t('knowledge.result.emptyCollectionHint')}</span></div>
          ) : (
            <KnowledgeResourceExplorer
              collectionName={collectionName}
              documents={documents}
              loading={documentsLoading}
              canEditTags={domain === 'local'}
              canDelete
              openDocument={(document) => void openDocument(document)}
              replaceTags={replaceDocumentTags}
              deleteDocument={deleteDocument}
            />
          )}
        </section>
      )
    }
    return (
      <div className="ww-kb-search-empty">
        <div className="ww-kb-orbit"><Database /><Cloud /></div>
        <b>{t('knowledge.result.emptySearchTitle')}</b>
        <p>{t('knowledge.result.emptySearchDescription')}</p>
        <div><kbd>Ctrl</kbd><kbd>K</kbd><span>{t('knowledge.result.focusShortcut')}</span><kbd>Enter</kbd><span>{t('knowledge.result.executeShortcut')}</span></div>
      </div>
    )
  }

  return (
    <section className="ww-kb-results" aria-label={t('knowledge.result.resultsAriaLabel')}>
      <header>
        <div>
          <h2>{t('knowledge.result.resultsTitle', { query })} <small>{t('knowledge.result.citationCount', { count: response.results.length })}</small></h2>
        </div>
        <div className="ww-kb-provider-row">
          {response.providers.map((provider) => <ProviderPill key={`${provider.domain}-${provider.provider}`} provider={provider} />)}
          <span className="ww-kb-elapsed"><Timer size={12} />{response.elapsedMilliseconds}ms</span>
        </div>
      </header>
      {response.partial && (
        <div className="ww-kb-partial"><TriangleAlert size={14} />{t('knowledge.result.partialWarning')}</div>
      )}
      {response.results.length === 0 ? (
        <div className="ww-kb-no-results">{t('knowledge.result.noResults')}</div>
      ) : response.results.map(({ citation }, index) => (
        <ResultCard key={`${citation.domain}-${citation.documentId}-${citation.revision}-${citation.chunkOrdinal}`} citation={citation} rank={index + 1} />
      ))}
    </section>
  )
}
