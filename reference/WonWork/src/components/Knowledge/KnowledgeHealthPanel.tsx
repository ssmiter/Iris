import { useEffect, useState, type CSSProperties } from 'react'
import { Activity, AlertTriangle, DatabaseZap, FileStack, SearchX, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { knowledgeApi } from '@/api/knowledgeApi'
import type { KnowledgeQualitySnapshot } from '@/types/knowledge'

export function KnowledgeHealthPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<KnowledgeQualitySnapshot | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    void knowledgeApi.quality(controller.signal).then(setSnapshot).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t('knowledge.health.loadError'))
    })
    return () => controller.abort()
  }, [t])

  const coverage = Math.round((snapshot?.vectorCoverage ?? 0) * 100)
  return (
    <aside className="ww-kb-health" aria-label={t('knowledge.health.panelAriaLabel')}>
      <header><span><Activity size={15} />{t('knowledge.health.title')}</span><button type="button" onClick={onClose} aria-label={t('knowledge.health.close')}><X size={15} /></button></header>
      {!snapshot && !error && <p className="ww-kb-health-loading">{t('knowledge.health.loading')}</p>}
      {error && <p className="ww-kb-health-error"><AlertTriangle size={14} />{error}</p>}
      {snapshot && <>
        <div className="ww-kb-health-score">
          <div style={{ '--coverage': `${coverage * 3.6}deg` } as CSSProperties}><strong>{coverage}%</strong><small>{t('knowledge.health.coverage')}</small></div>
          <p>{snapshot.failedJobCount === 0 && snapshot.invalidCitationCount === 0 ? t('knowledge.health.statusOk') : t('knowledge.health.statusWarn')}<small>{t('knowledge.health.updatedAt', { time: new Date(snapshot.generatedAt).toLocaleTimeString() })}</small></p>
        </div>
        <div className="ww-kb-health-grid">
          <span><FileStack size={14} /><b>{snapshot.documentCount}</b><small>{t('knowledge.health.documents')}</small></span>
          <span><DatabaseZap size={14} /><b>{snapshot.chunkCount}</b><small>{t('knowledge.health.chunks')}</small></span>
          <span><SearchX size={14} /><b>{snapshot.noAnswerSearchCount}</b><small>{t('knowledge.health.noAnswerSearches')}</small></span>
          <span className={snapshot.failedJobCount ? 'is-warn' : ''}><AlertTriangle size={14} /><b>{snapshot.failedJobCount}</b><small>{t('knowledge.health.failedJobs')}</small></span>
        </div>
        <section><h3>{t('knowledge.health.formatsTitle')}</h3>{snapshot.formats.map((format) => <div key={format.mimeType}><span>{format.mimeType.split('/').pop()}</span><i /><b>{format.documentCount}</b></div>)}</section>
        {(snapshot.hotDocuments || []).length > 0 && <section className="ww-kb-hot-docs"><h3>{t('knowledge.health.hotDocsTitle')}</h3>{snapshot.hotDocuments.map((document) => <div key={document.documentId}><span>{document.title}</span><small>{document.sourceLocator}</small><b>{document.readCount}</b></div>)}</section>}
      </>}
    </aside>
  )
}
