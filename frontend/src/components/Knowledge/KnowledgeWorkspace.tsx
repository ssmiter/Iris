import { useEffect, useRef, useState } from 'react'
import { Activity, BookOpenCheck, Command, Database, Cloud, Layers3, PanelLeftClose, PanelLeftOpen, Search, ShieldCheck, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { useKnowledgeNavigationStore } from '@/stores/knowledgeNavigationStore'
import { KnowledgeCollectionPanel } from './KnowledgeCollectionPanel'
import { KnowledgeInspector } from './KnowledgeInspector'
import { KnowledgeResultList } from './KnowledgeResultList'
import { KnowledgeFilterRibbon } from './KnowledgeFilterRibbon'
import { KnowledgeHealthPanel } from './KnowledgeHealthPanel'
import type { KnowledgeCapabilities, KnowledgeDomain } from '@/types/knowledge'
import './knowledge.css'

export function KnowledgeWorkspace() {
  const { t } = useTranslation()
  const domains: Array<{ id: KnowledgeDomain; label: string; icon: typeof Database }> = [
    { id: 'local', label: t('knowledge.workspace.domainLocal'), icon: Database },
    { id: 'online', label: t('knowledge.workspace.domainOnline'), icon: Cloud },
    { id: 'both', label: t('knowledge.workspace.domainBoth'), icon: Layers3 },
  ]

  const onlineUnavailableTitle = (reason: KnowledgeCapabilities['onlineUnavailableReason']): string => {
    if (reason === 'mes_login_required') return t('knowledge.workspace.onlineUnavailableTitle.loginRequired')
    if (reason === 'database_or_schema_unavailable') return t('knowledge.workspace.onlineUnavailableTitle.unavailable')
    return t('knowledge.workspace.onlineUnavailableTitle.notConfigured')
  }
  const initialize = useKnowledgeStore((state) => state.initialize)
  const initialized = useKnowledgeStore((state) => state.initialized)
  const capabilities = useKnowledgeStore((state) => state.capabilities)
  const domain = useKnowledgeStore((state) => state.domain)
  const setDomain = useKnowledgeStore((state) => state.setDomain)
  const query = useKnowledgeStore((state) => state.query)
  const setQuery = useKnowledgeStore((state) => state.setQuery)
  const runSearch = useKnowledgeStore((state) => state.runSearch)
  const selectedCitation = useKnowledgeStore((state) => state.selectedCitation)
  const error = useKnowledgeStore((state) => state.error)
  const clearError = useKnowledgeStore((state) => state.clearError)
  const [collectionsOpen, setCollectionsOpen] = useState(true)
  const [healthOpen, setHealthOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const pendingCitation = useKnowledgeNavigationStore((state) => state.pendingCitation)
  const consumeCitation = useKnowledgeNavigationStore((state) => state.consumeCitation)

  useEffect(() => { void initialize() }, [initialize])
  useEffect(() => {
    if (!pendingCitation || !capabilities?.enabled) return
    void useKnowledgeStore.getState().openCitation(pendingCitation)
    consumeCitation()
  }, [capabilities?.enabled, consumeCitation, pendingCitation])
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        input.current?.focus()
      }
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [])

  if (!initialized) return <div className="ww-kb-boot"><BookOpenCheck size={24} /><span>{t('knowledge.workspace.loading')}</span></div>
  if (!capabilities?.enabled) {
    return (
      <div className="ww-kb-disabled">
        <div><ShieldCheck size={28} /></div>
        <h1>{t('knowledge.workspace.disabledTitle')}</h1>
        <p>{t('knowledge.workspace.disabledDescription')}</p>
        <code>Knowledge:Enabled = true</code>
      </div>
    )
  }

  return (
    <div className={`ww-kb-workspace${collectionsOpen ? '' : ' collections-closed'}${selectedCitation ? ' has-inspector' : ''}`}>
      <header className="ww-kb-topbar">
        <div className="ww-kb-heading">
          <button
            type="button"
            className="ww-kb-panel-toggle"
            onClick={() => setCollectionsOpen((open) => !open)}
            aria-label={collectionsOpen ? t('knowledge.workspace.collapseCollections') : t('knowledge.workspace.expandCollections')}
            title={collectionsOpen ? t('knowledge.workspace.collapseCollections') : t('knowledge.workspace.expandCollections')}
          >
            {collectionsOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          </button>
          <BookOpenCheck size={18} />
          <strong>{t('knowledge.workspace.title')}</strong>
        </div>
        <div className="ww-kb-domain-tabs" aria-label={t('knowledge.workspace.domainTabsLabel')}>
          {domains.map(({ id, label, icon: Icon }) => {
            const disabled = id !== 'local' && !capabilities.onlineAvailable
            return (
              <button
                key={id}
                type="button"
                disabled={disabled}
                title={disabled ? onlineUnavailableTitle(capabilities.onlineUnavailableReason) : undefined}
                className={domain === id ? 'is-active' : ''}
                onClick={() => setDomain(id)}
                aria-pressed={domain === id}
              >
                <Icon size={13} />{label}
              </button>
            )
          })}
        </div>
        <form onSubmit={(event) => { event.preventDefault(); void runSearch() }} className="ww-kb-command">
          <Search size={16} />
          <input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('knowledge.workspace.searchPlaceholder')} aria-label={t('knowledge.workspace.searchAriaLabel')} />
          {query && <button type="button" className="ww-kb-clear" onClick={() => setQuery('')} aria-label={t('knowledge.workspace.clearSearch')}><X size={14} /></button>}
          <kbd><Command size={10} />K</kbd>
          <button type="submit" disabled={!query.trim()}>{t('knowledge.workspace.search')}</button>
        </form>
        <button type="button" className={`ww-kb-health-trigger${healthOpen ? ' is-active' : ''}`} onClick={() => setHealthOpen((open) => !open)} title={t('knowledge.workspace.healthTitle')} aria-label={t('knowledge.workspace.healthTitle')}><Activity size={16} /></button>
      </header>
      {collectionsOpen && <KnowledgeCollectionPanel domain={domain} />}
      <main className="ww-kb-center">{query.trim() && <KnowledgeFilterRibbon />}<KnowledgeResultList /></main>
      {selectedCitation && <KnowledgeInspector />}
      {healthOpen && <KnowledgeHealthPanel onClose={() => setHealthOpen(false)} />}
      {error && <div className="ww-kb-toast" role="alert"><span>{error}</span><button type="button" onClick={clearError}><X size={14} /></button></div>}
    </div>
  )
}

export default KnowledgeWorkspace
