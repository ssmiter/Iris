import { CalendarRange, Filter, RotateCcw, Tag } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useKnowledgeStore } from '@/stores/knowledgeStore'

export function KnowledgeFilterRibbon() {
  const { t } = useTranslation()
  const MIME_GROUPS = [
    { value: '', label: t('knowledge.filter.allTypes') },
    { value: 'text/markdown', label: 'Markdown' },
    { value: 'text/plain', label: t('knowledge.filter.textAndCode') },
    { value: 'application/pdf', label: 'PDF' },
    { value: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word' },
    { value: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel' },
  ]
  const tags = useKnowledgeStore((state) => state.tags)
  const mimeTypes = useKnowledgeStore((state) => state.mimeTypes)
  const updatedAfter = useKnowledgeStore((state) => state.updatedAfter)
  const updatedBefore = useKnowledgeStore((state) => state.updatedBefore)
  const setFilters = useKnowledgeStore((state) => state.setFilters)
  const active = tags.length + mimeTypes.length + Number(Boolean(updatedAfter)) + Number(Boolean(updatedBefore))

  return (
    <div className="ww-kb-filters" aria-label={t('knowledge.filter.panelAriaLabel')}>
      <span className="ww-kb-filter-title"><Filter size={12} /> {t('knowledge.filter.title')} {active > 0 && <b>{active}</b>}</span>
      <label><Tag size={12} /><input
        value={tags.join(', ')}
        placeholder={t('knowledge.filter.tagsPlaceholder')}
        onChange={(event) => setFilters({ tags: event.target.value.split(/[,，]/).map((value) => value.trim()).filter(Boolean) })}
      /></label>
      <label><select value={mimeTypes[0] || ''} onChange={(event) => setFilters({ mimeTypes: event.target.value ? [event.target.value] : [] })}>
        {MIME_GROUPS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select></label>
      <label className="ww-kb-filter-date"><CalendarRange size={12} /><input aria-label={t('knowledge.filter.dateStart')} type="date" value={updatedAfter?.slice(0, 10) || ''} onChange={(event) => setFilters({ updatedAfter: event.target.value ? `${event.target.value}T00:00:00Z` : null })} /></label>
      <span className="ww-kb-filter-arrow">→</span>
      <label className="ww-kb-filter-date"><input aria-label={t('knowledge.filter.dateEnd')} type="date" value={updatedBefore?.slice(0, 10) || ''} onChange={(event) => setFilters({ updatedBefore: event.target.value ? `${event.target.value}T23:59:59Z` : null })} /></label>
      {active > 0 && <button type="button" onClick={() => setFilters({ tags: [], mimeTypes: [], updatedAfter: null, updatedBefore: null })}><RotateCcw size={11} />{t('knowledge.filter.reset')}</button>}
    </div>
  )
}
