import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowLeftRight, Check, Cloud, Copy, Database, Download, Eye, FileClock, FileText, Link2, LoaderCircle, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { knowledgeApi } from '@/api/knowledgeApi'
import type { KnowledgeConflictStrategy, KnowledgeDocumentRelationships, KnowledgeTransferRequest } from '@/types/knowledge'

export function KnowledgeInspector() {
  const { t } = useTranslation()
  const citation = useKnowledgeStore((state) => state.selectedCitation)
  const content = useKnowledgeStore((state) => state.readResult)
  const reading = useKnowledgeStore((state) => state.reading)
  const collections = useKnowledgeStore((state) => state.collections)
  const capabilities = useKnowledgeStore((state) => state.capabilities)
  const close = useKnowledgeStore((state) => state.closeInspector)
  const preflight = useKnowledgeStore((state) => state.preflightTransfer)
  const execute = useKnowledgeStore((state) => state.executeTransfer)
  const transferPreflight = useKnowledgeStore((state) => state.transferPreflight)
  const transferResult = useKnowledgeStore((state) => state.transferResult)
  const mutating = useKnowledgeStore((state) => state.mutating)
  const [showTransfer, setShowTransfer] = useState(false)
  const [targetCollectionId, setTargetCollectionId] = useState('')
  const [strategy, setStrategy] = useState<KnowledgeConflictStrategy>('createRevision')
  const [copied, setCopied] = useState(false)
  const [relationships, setRelationships] = useState<KnowledgeDocumentRelationships | null>(null)
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [originalLoading, setOriginalLoading] = useState(false)

  const targetDomain = citation?.domain === 'local' ? 'online' : 'local'
  const targetCollections = collections[targetDomain]
  const request = useMemo<KnowledgeTransferRequest | null>(() => citation && targetCollectionId ? ({
    operationKey: crypto.randomUUID(),
    sourceDomain: citation.domain,
    targetDomain,
    sourceDocumentId: citation.documentId,
    sourceRevision: citation.revision,
    targetCollectionId,
    conflictStrategy: strategy,
  }) : null, [citation, strategy, targetCollectionId, targetDomain])

  useEffect(() => {
    setRelationships(null)
    if (!citation || citation.domain !== 'local') return
    const controller = new AbortController()
    void knowledgeApi.relationships(citation.documentId, controller.signal)
      .then((value) => {
        if (value && Array.isArray(value.related) && Array.isArray(value.revisions)) setRelationships(value)
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [citation])

  useEffect(() => {
    setOriginalUrl(null)
  }, [citation?.documentId, citation?.revision])

  useEffect(() => () => {
    if (originalUrl) URL.revokeObjectURL(originalUrl)
  }, [originalUrl])

  if (!citation) return null

  const copyCitation = async () => {
    await navigator.clipboard.writeText(t('knowledge.inspector.citationFormat', {
      title: citation.title,
      sourceLocator: citation.sourceLocator,
      revision: citation.revision,
      chunkOrdinal: citation.chunkOrdinal + 1,
    }))
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  const beginTransfer = () => {
    setShowTransfer(true)
    setTargetCollectionId(targetCollections[0]?.id || '')
  }

  const exportRevision = async () => {
    if (citation.domain !== 'local') return
    const blob = await knowledgeApi.exportRevision(citation.documentId, citation.revision)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `knowledge-${citation.documentId.slice(0, 12)}-r${citation.revision}.zip`
    link.click()
    URL.revokeObjectURL(url)
  }

  const previewOriginal = async () => {
    if (citation.domain !== 'online' || content?.mimeType !== 'application/pdf') return
    setOriginalLoading(true)
    try {
      const blob = await knowledgeApi.originalRevision(citation.documentId, citation.revision, true)
      setOriginalUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous)
        return URL.createObjectURL(blob)
      })
    } finally {
      setOriginalLoading(false)
    }
  }

  const downloadOriginal = async () => {
    if (citation.domain !== 'online') return
    setOriginalLoading(true)
    try {
      const blob = await knowledgeApi.originalRevision(citation.documentId, citation.revision)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = content?.originalFileName || citation.sourceLocator.split('/').pop() || `knowledge-r${citation.revision}`
      link.click()
      URL.revokeObjectURL(url)
    } finally {
      setOriginalLoading(false)
    }
  }

  return (
    <aside className="ww-kb-inspector" aria-label={t('knowledge.inspector.panelAriaLabel')}>
      <header>
        <span>{t('knowledge.inspector.title')}</span>
        <button type="button" onClick={close} aria-label={t('knowledge.inspector.close')}><X size={16} /></button>
      </header>
      <div className="ww-kb-inspector-title">
        <em className={citation.domain === 'local' ? 'is-local' : 'is-online'}>
          {citation.domain === 'local' ? <Database size={12} /> : <Cloud size={12} />}
          {citation.domain === 'local' ? t('knowledge.inspector.domainLocal') : t('knowledge.inspector.domainOnline')}
        </em>
        <h2>{citation.title}</h2>
        <p><FileText size={13} />{citation.sourceLocator}</p>
      </div>
      <div className="ww-kb-citation-grid">
        <span><small>{t('knowledge.inspector.revisionLabel')}</small><b>r{citation.revision}</b></span>
        <span><small>{t('knowledge.inspector.chunkLabel')}</small><b>{citation.chunkOrdinal + 1}</b></span>
        <span><small>{t('knowledge.inspector.keywordLabel')}</small><b>{Math.round(citation.keywordScore * 100)}</b></span>
        <span><small>{t('knowledge.inspector.vectorLabel')}</small><b>{Math.round(citation.vectorScore * 100)}</b></span>
      </div>
      {citation.domain === 'online' && content && <div className="ww-kb-original-strip">
        <span><FileText size={13} /><b>{content.originalFileName || citation.sourceLocator}</b><small>{content.mimeType}</small></span>
        <em>{content.mimeType === 'application/pdf' ? t('knowledge.inspector.pdfPreviewHint') : t('knowledge.inspector.originalDownloadHint')}</em>
      </div>}
      <div className="ww-kb-inspector-content">
        {reading && <div className="ww-kb-reading"><LoaderCircle className="ww-kb-spin" size={18} />{t('knowledge.inspector.reading')}</div>}
        {originalUrl
          ? <div className="ww-kb-original-preview"><button type="button" onClick={() => setOriginalUrl(null)}><FileText size={13} />{t('knowledge.inspector.viewParsed')}</button><iframe title={t('knowledge.inspector.originalPreviewTitle')} src={`${originalUrl}#toolbar=0&navpanes=0&scrollbar=1`} /></div>
          : content && <ReactMarkdown remarkPlugins={[remarkGfm]}>{content.content}</ReactMarkdown>}
      </div>
      {relationships && (relationships.related.length > 0 || relationships.revisions.length > 1) && (
        <div className="ww-kb-relationships">
          {relationships.related.length > 0 && <section><h3><Link2 size={13} />{t('knowledge.inspector.relatedTitle')}</h3>{relationships.related.map((item) => <article key={item.documentId}><b>{item.title}</b><small>{item.sourceLocator}</small><div>{item.sharedTags.map((tag) => <em key={tag}>#{tag}</em>)}</div></article>)}</section>}
          {relationships.revisions.length > 1 && <section><h3><FileClock size={13} />{t('knowledge.inspector.revisionsTitle')}</h3><div className="ww-kb-timeline">{relationships.revisions.map((revision) => <span key={revision.revision}><i /><b>r{revision.revision}</b><small>{new Date(revision.createdAt).toLocaleString()}</small></span>)}</div></section>}
        </div>
      )}
      <footer>
        <button type="button" onClick={() => void copyCitation()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? t('knowledge.inspector.copied') : t('knowledge.inspector.copy')}</button>
        {citation.domain === 'local' && <button type="button" onClick={() => void exportRevision()}><Download size={14} />{t('knowledge.inspector.export')}</button>}
        {citation.domain === 'online' && content?.mimeType === 'application/pdf' && <button type="button" disabled={originalLoading} onClick={() => void previewOriginal()}>{originalLoading ? <LoaderCircle className="ww-kb-spin" size={14} /> : <Eye size={14} />}{t('knowledge.inspector.previewOriginal')}</button>}
        {citation.domain === 'online' && <button type="button" disabled={originalLoading || !content} onClick={() => void downloadOriginal()}><Download size={14} />{t('knowledge.inspector.downloadOriginal')}</button>}
        <button
          type="button"
          className="is-primary"
          disabled={targetDomain === 'online' && !capabilities?.onlineAvailable}
          onClick={beginTransfer}
        ><ArrowLeftRight size={14} />{t('knowledge.inspector.saveTo', { domain: targetDomain === 'local' ? t('knowledge.inspector.domainLocal') : t('knowledge.inspector.domainOnline') })}</button>
      </footer>

      {showTransfer && (
        <div className="ww-kb-transfer-sheet">
          <div className="ww-kb-transfer-head"><span>{t('knowledge.inspector.saveTo', { domain: targetDomain === 'local' ? t('knowledge.inspector.domainLocal') : t('knowledge.inspector.domainOnline') })}</span><button type="button" onClick={() => setShowTransfer(false)}><X size={14} /></button></div>
          <p>{t('knowledge.inspector.transferDescription')}</p>
          <label>{t('knowledge.inspector.targetCollectionLabel')}
            {targetCollections.length > 0 ? (
              <select value={targetCollectionId} onChange={(event) => setTargetCollectionId(event.target.value)}>
                <option value="">{t('knowledge.inspector.targetCollectionPlaceholder')}</option>
                {targetCollections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}
              </select>
            ) : (
              <input value={targetCollectionId} onChange={(event) => setTargetCollectionId(event.target.value)} placeholder={t('knowledge.inspector.targetCollectionInputPlaceholder')} />
            )}
          </label>
          <label>{t('knowledge.inspector.conflictLabel')}
            <select value={strategy} onChange={(event) => setStrategy(event.target.value as KnowledgeConflictStrategy)}>
              <option value="createRevision">{t('knowledge.inspector.strategyCreateRevision')}</option>
              <option value="createCopy">{t('knowledge.inspector.strategyCreateCopy')}</option>
              <option value="skip">{t('knowledge.inspector.strategySkip')}</option>
            </select>
          </label>
          {transferPreflight && (
            <div className={transferPreflight.allowed ? 'ww-kb-preflight is-ok' : 'ww-kb-preflight is-blocked'}>
              {transferPreflight.issues.length === 0 ? t('knowledge.inspector.preflightOk') : transferPreflight.issues.map((issue) => <span key={issue.code}>{issue.message}</span>)}
            </div>
          )}
          {transferResult?.status === 'succeeded' && <div className="ww-kb-preflight is-ok"><Check size={13} />{t('knowledge.inspector.transferSucceeded')}</div>}
          <div className="ww-kb-transfer-actions">
            <button type="button" disabled={!request || mutating} onClick={() => request && void preflight(request)}>{mutating ? <LoaderCircle className="ww-kb-spin" size={14} /> : null}{t('knowledge.inspector.preflightCheck')}</button>
            <button type="button" className="is-primary" disabled={!request || !transferPreflight?.allowed || mutating} onClick={() => request && void execute(request)}>{t('knowledge.inspector.confirmSave')}</button>
          </div>
        </div>
      )}
    </aside>
  )
}
