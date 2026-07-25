import { useTranslation } from 'react-i18next'
import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/utils'
import { useMemoryStore } from '@/stores/memoryStore'
import type { MemoryEntry, MemoryEntryType, MemoryLayer, MemoryPriority, MemoryStatus } from '@/types/memory'
import {
  MEMORY_ENTRY_TYPES,
  MEMORY_LAYERS,
  MEMORY_PRIORITIES,
  MEMORY_STATUSES,
} from '@/types/memory'
import {
  Brain,
  Plus,
  Search,
  Trash2,
  Pencil,
  Check,
  X,
  Tag,
  Clock,
  Layers,
  Filter,
  Archive,
  RefreshCw,
} from 'lucide-react'

const LAYER_COLORS: Record<MemoryLayer | 'all', string> = {
  all: 'bg-surface-200 text-surface-700',
  working: 'bg-amber-100 text-amber-700',
  episodic: 'bg-blue-100 text-blue-700',
  semantic: 'bg-green-100 text-green-700',
  procedural: 'bg-purple-100 text-purple-700',
}

const TYPE_COLORS: Record<MemoryEntryType, string> = {
  conversation: 'bg-indigo-100 text-indigo-700',
  fact: 'bg-blue-100 text-blue-700',
  preference: 'bg-emerald-100 text-emerald-700',
  decision: 'bg-orange-100 text-orange-700',
  action: 'bg-amber-100 text-amber-700',
  observation: 'bg-cyan-100 text-cyan-700',
  error: 'bg-red-100 text-red-700',
  summary: 'bg-violet-100 text-violet-700',
  code: 'bg-slate-100 text-slate-700',
  relationship: 'bg-pink-100 text-pink-700',
  note: 'bg-amber-100 text-amber-700',
}

const PRIORITY_COLORS: Record<MemoryPriority, string> = {
  critical: 'bg-red-100 text-red-700',
  high: 'bg-orange-100 text-orange-700',
  medium: 'bg-yellow-100 text-yellow-700',
  low: 'bg-green-100 text-green-700',
  ephemeral: 'bg-slate-100 text-slate-700',
}

const STATUS_COLORS: Record<MemoryStatus, string> = {
  active: 'bg-green-100 text-green-700',
  archived: 'bg-slate-100 text-slate-700',
  consolidated: 'bg-blue-100 text-blue-700',
  expired: 'bg-red-100 text-red-700',
  pending_review: 'bg-yellow-100 text-yellow-700',
}

function formatDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')
}

function emptyEntry(): Partial<MemoryEntry> {
  return {
    layer: 'semantic',
    type: 'note',
    priority: 'medium',
    status: 'active',
    content: '',
    summary: '',
    tags: [],
  }
}

export function MemoryManagerView() {
  const { t, i18n } = useTranslation()
  const store = useMemoryStore()
  const {
    entries,
    activeLayer,
    activeTypes,
    activeStatuses,
    searchQuery,
    isLoading,
    initialized,
    initialize,
    remember,
    deleteMemory,
    updateMemory,
    archiveMemory,
    consolidate,
    setActiveLayer,
    setActiveTypes,
    setActiveStatuses,
    setSearchQuery,
    getVisibleMemories,
  } = store

  useEffect(() => {
    if (!initialized) initialize()
  }, [initialized, initialize])

  const visible = useMemo(() => getVisibleMemories(), [getVisibleMemories, entries, activeLayer, activeTypes, activeStatuses, searchQuery])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isAdding, setIsAdding] = useState(false)
  const [editEntry, setEditEntry] = useState<MemoryEntry | null>(null)
  const [draft, setDraft] = useState<Partial<MemoryEntry>>(emptyEntry())

  useEffect(() => {
    setSelectedIds(new Set())
  }, [activeLayer, activeTypes, activeStatuses, searchQuery])

  const allSelected = visible.length > 0 && visible.every((m) => selectedIds.has(m.id))

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(visible.map((m) => m.id)))
    }
  }

  const toggleType = (type: MemoryEntryType) => {
    setActiveTypes(
      activeTypes.includes(type) ? activeTypes.filter((t) => t !== type) : [...activeTypes, type]
    )
  }

  const toggleStatus = (status: MemoryStatus) => {
    setActiveStatuses(
      activeStatuses.includes(status)
        ? activeStatuses.filter((s) => s !== status)
        : [...activeStatuses, status]
    )
  }

  const handleAdd = async () => {
    if (!draft.content?.trim()) return
    await remember({
      content: draft.content.trim(),
      layer: draft.layer,
      type: draft.type,
      priority: draft.priority,
      status: draft.status,
      summary: draft.summary,
      tags: draft.tags,
    })
    setIsAdding(false)
    setDraft(emptyEntry())
  }

  const handleSaveEdit = async () => {
    if (!editEntry || !draft.content?.trim()) return
    await updateMemory(editEntry.id, {
      content: draft.content.trim(),
      layer: draft.layer,
      type: draft.type,
      priority: draft.priority,
      status: draft.status,
      summary: draft.summary,
      tags: draft.tags,
    })
    setEditEntry(null)
    setDraft(emptyEntry())
  }

  const startEdit = (entry: MemoryEntry) => {
    setEditEntry(entry)
    setDraft({
      layer: entry.layer,
      type: entry.type,
      priority: entry.priority,
      status: entry.status,
      content: entry.content,
      summary: entry.summary || '',
      tags: entry.tags,
    })
  }

  const closeDialog = () => {
    setIsAdding(false)
    setEditEntry(null)
    setDraft(emptyEntry())
  }

  const handleDeleteSelected = async () => {
    for (const id of selectedIds) await deleteMemory(id)
    setSelectedIds(new Set())
  }

  const handleArchiveSelected = async () => {
    for (const id of selectedIds) await archiveMemory(id)
    setSelectedIds(new Set())
  }

  const renderDialog = () => {
    const isOpen = isAdding || !!editEntry
    if (!isOpen) return null
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
          <div className="px-6 py-4 border-b border-surface-200 flex items-center justify-between">
            <h3 className="text-base font-semibold text-surface-800">
              {isAdding ? t('memory.memoryManager.addMemory') : t('memory.memoryManager.edit')}
            </h3>
            <button onClick={closeDialog} className="text-surface-400 hover:text-surface-600">
              <X size={18} />
            </button>
          </div>
          <div className="p-6 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-surface-600 mb-1">
                  {t('memory.memoryManager.layer')}
                </label>
                <select
                  value={draft.layer || 'semantic'}
                  onChange={(e) => setDraft({ ...draft, layer: e.target.value as MemoryLayer })}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm"
                >
                  {MEMORY_LAYERS.map((l) => (
                    <option key={l} value={l}>
                      {t(`memory.layers.${l}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-surface-600 mb-1">
                  {t('memory.memoryManager.type')}
                </label>
                <select
                  value={draft.type || 'note'}
                  onChange={(e) => setDraft({ ...draft, type: e.target.value as MemoryEntryType })}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm"
                >
                  {MEMORY_ENTRY_TYPES.map((tp) => (
                    <option key={tp} value={tp}>
                      {t(`memory.types.${tp}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-surface-600 mb-1">
                  {t('memory.memoryManager.priority')}
                </label>
                <select
                  value={draft.priority || 'medium'}
                  onChange={(e) => setDraft({ ...draft, priority: e.target.value as MemoryPriority })}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm"
                >
                  {MEMORY_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {t(`memory.priorities.${p}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-surface-600 mb-1">
                  {t('memory.memoryManager.status')}
                </label>
                <select
                  value={draft.status || 'active'}
                  onChange={(e) => setDraft({ ...draft, status: e.target.value as MemoryStatus })}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm"
                >
                  {MEMORY_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {t(`memory.statuses.${s}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-surface-600 mb-1">
                {t('memory.memoryManager.content')}
              </label>
              <textarea
                value={draft.content || ''}
                onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                rows={4}
                className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm resize-none focus:outline-none focus:border-primary-400 focus:ring-1 focus:ring-primary-400"
                placeholder={t('memory.memoryManager.contentPlaceholder')}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-surface-600 mb-1">
                {t('memory.memoryManager.summary')}
              </label>
              <input
                value={(draft.summary as string) || ''}
                onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
                className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm"
                placeholder={t('memory.memoryManager.summaryPlaceholder')}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-surface-600 mb-1">
                {t('memory.memoryManager.tags')}
              </label>
              <input
                value={(draft.tags || []).join(', ')}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                  })
                }
                className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm"
                placeholder={t('memory.memoryManager.tagsPlaceholder')}
              />
            </div>
          </div>
          <div className="px-6 py-4 border-t border-surface-200 flex justify-end gap-2">
            <button
              onClick={closeDialog}
              className="px-4 py-2 rounded-lg text-sm font-medium text-surface-600 hover:bg-surface-100"
            >
              {t('memory.memoryManager.cancel')}
            </button>
            <button
              onClick={editEntry ? handleSaveEdit : handleAdd}
              disabled={!draft.content?.trim()}
              className={cn(
                'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                draft.content?.trim()
                  ? 'bg-primary-500 text-white hover:bg-primary-600'
                  : 'bg-surface-200 text-surface-400 cursor-not-allowed'
              )}
            >
              <Check size={14} />
              {t('memory.memoryManager.save')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-surface-200 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary-100 flex items-center justify-center">
            <Brain size={20} className="text-primary-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-surface-800">{t('memory.memoryManager.title')}</h2>
            <p className="text-sm text-surface-400">
              {t('memory.memoryManager.memoryCount', { count: entries.length })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => consolidate()}
            disabled={isLoading}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-surface-600 hover:bg-surface-100 transition-colors"
          >
            <RefreshCw size={16} />
            {t('memory.memoryManager.consolidate')}
          </button>
          <button
            onClick={() => {
              setDraft(emptyEntry())
              setIsAdding(true)
            }}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 transition-colors"
          >
            <Plus size={16} />
            {t('memory.memoryManager.addMemory')}
          </button>
        </div>
      </div>

      {/* Search + Filters */}
      <div className="px-6 py-3 bg-surface-50 border-b border-surface-200 space-y-3">
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('memory.memoryManager.search')}
              className="w-full pl-9 pr-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400 focus:ring-1 focus:ring-primary-400"
            />
          </div>
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleArchiveSelected}
                className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium text-surface-600 hover:bg-surface-100"
              >
                <Archive size={16} />
                {t('memory.memoryManager.archiveSelected')}
              </button>
              <button
                onClick={handleDeleteSelected}
                className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50"
              >
                <Trash2 size={16} />
                {t('memory.memoryManager.deleteSelected')}
              </button>
            </div>
          )}
        </div>

        {/* Layer tabs */}
        <div className="flex items-center gap-1">
          {(['all', ...MEMORY_LAYERS] as (MemoryLayer | 'all')[]).map((l) => (
            <button
              key={l}
              onClick={() => setActiveLayer(l)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border',
                activeLayer === l
                  ? 'bg-primary-500 text-white border-primary-500'
                  : 'bg-white text-surface-600 border-surface-200 hover:bg-surface-100'
              )}
            >
              {t(`memory.layers.${l}`)}
            </button>
          ))}
        </div>

        {/* Type filter */}
        <div className="flex flex-wrap items-center gap-1">
          <Filter size={14} className="text-surface-400 mr-1" />
          {MEMORY_ENTRY_TYPES.map((tp) => (
            <button
              key={tp}
              onClick={() => toggleType(tp)}
              className={cn(
                'px-2 py-0.5 rounded-full text-xs font-medium border transition-colors',
                activeTypes.includes(tp)
                  ? 'bg-primary-500 text-white border-primary-500'
                  : 'bg-white text-surface-600 border-surface-200 hover:bg-surface-100'
              )}
            >
              {t(`memory.types.${tp}`)}
            </button>
          ))}
        </div>

        {/* Status filter */}
        <div className="flex flex-wrap items-center gap-1">
          <Layers size={14} className="text-surface-400 mr-1" />
          {MEMORY_STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => toggleStatus(s)}
              className={cn(
                'px-2 py-0.5 rounded-full text-xs font-medium border transition-colors',
                activeStatuses.includes(s)
                  ? 'bg-primary-500 text-white border-primary-500'
                  : 'bg-white text-surface-600 border-surface-200 hover:bg-surface-100'
              )}
            >
              {t(`memory.statuses.${s}`)}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto space-y-3">
          {visible.length > 0 && (
            <div className="flex items-center gap-2 text-sm text-surface-600">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                className="rounded border-surface-300"
              />
              <span>{t('memory.memoryManager.selectAll')}</span>
            </div>
          )}

          {visible.length === 0 && (
            <div className="text-center py-12">
              <Brain size={48} className="mx-auto text-surface-300 mb-3" />
              <p className="text-surface-400">
                {searchQuery || activeTypes.length > 0 || activeStatuses.length > 0 || activeLayer !== 'all'
                  ? t('memory.memoryManager.noMatch')
                  : t('memory.memoryManager.noMemories')}
              </p>
            </div>
          )}

          {visible.map((mem) => {
            const selected = selectedIds.has(mem.id)
            return (
              <div
                key={mem.id}
                className={cn(
                  'bg-white border rounded-xl p-4 hover:shadow-sm transition-shadow',
                  selected ? 'border-primary-400 ring-1 ring-primary-400' : 'border-surface-200'
                )}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleSelect(mem.id)}
                    className="mt-1 rounded border-surface-300"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', LAYER_COLORS[mem.layer])}>
                        {t(`memory.layers.${mem.layer}`)}
                      </span>
                      <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', TYPE_COLORS[mem.type])}>
                        {t(`memory.types.${mem.type}`)}
                      </span>
                      <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', PRIORITY_COLORS[mem.priority])}>
                        {t(`memory.priorities.${mem.priority}`)}
                      </span>
                      <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', STATUS_COLORS[mem.status])}>
                        {t(`memory.statuses.${mem.status}`)}
                      </span>
                      <span className="text-xs text-surface-400 flex items-center gap-1">
                        <Clock size={12} />
                        {formatDate(mem.created_at, i18n.language)}
                      </span>
                      {mem.access_count > 0 && (
                        <span className="text-xs text-surface-400">
                          {t('memory.memoryManager.accessCount', { count: mem.access_count })}
                        </span>
                      )}
                    </div>

                    <p className="text-sm text-surface-800 whitespace-pre-wrap">{mem.content}</p>
                    {mem.summary && (
                      <p className="text-xs text-surface-500 mt-1">{mem.summary}</p>
                    )}
                    {(mem.tags || []).length > 0 && (
                      <div className="flex flex-wrap items-center gap-1 mt-2">
                        {(mem.tags || []).map((tag) => (
                          <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-100 text-surface-600 text-xs">
                            <Tag size={10} />
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => startEdit(mem)}
                      className="p-1.5 rounded-lg text-surface-400 hover:text-primary-500 hover:bg-primary-50 transition-colors"
                      title={t('memory.memoryManager.edit')}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => archiveMemory(mem.id)}
                      className="p-1.5 rounded-lg text-surface-400 hover:text-slate-500 hover:bg-slate-50 transition-colors"
                      title={t('memory.memoryManager.archive')}
                    >
                      <Archive size={14} />
                    </button>
                    <button
                      onClick={() => deleteMemory(mem.id)}
                      className="p-1.5 rounded-lg text-surface-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                      title={t('memory.memoryManager.delete')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {renderDialog()}
    </div>
  )
}
