import { useTranslation } from 'react-i18next'
import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/utils'
import { useFileMemoryStore } from '@/stores/fileMemoryStore'
import type { MemoryFileEntry, MemoryFileType } from '@/types/memoryFile'
import { MEMORY_FILE_TYPES, buildMemoryFileContent, memoryFileName } from '@/types/memoryFile'
import { MEMORY_FILE_TYPE_VALUES, fileTypeLabelKey, FILE_TYPE_BADGE } from './fileTypeUi'
import { Brain, Plus, Search, Trash2, Pencil, Check, X, Clock, Filter } from 'lucide-react'

function formatDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')
}

interface Draft {
  name: string
  description: string
  type: MemoryFileType | ''
  content: string
}

function emptyDraft(): Draft {
  return { name: '', description: '', type: '', content: '' }
}

/**
 * 记忆管理页（2026-09-03 文件化重写）：~/.wonwork/memory/ 目录的直面管理。
 * 一条记忆 = 一个 .md 文件（frontmatter: name/description/type）+ MEMORY.md 索引行。
 * 旧模型的 layer/status/priority/source/tags/consolidate 随 SQLite 链路退役——
 * 这里的操作就是文件操作：新增=写文件+索引行，编辑=改写文件，删除=删文件+移除索引行。
 * 模型用文件原语管同一组文件，两边操作的是同一个事实源。
 */
export function MemoryManagerView() {
  const { t, i18n } = useTranslation()
  const entries = useFileMemoryStore((s) => s.entries)
  const initialized = useFileMemoryStore((s) => s.initialized)
  const initialize = useFileMemoryStore((s) => s.initialize)
  const writeMemoryFile = useFileMemoryStore((s) => s.writeMemoryFile)
  const deleteMemoryWithIndex = useFileMemoryStore((s) => s.deleteMemoryWithIndex)
  const upsertIndexLine = useFileMemoryStore((s) => s.upsertIndexLine)

  const [searchQuery, setSearchQuery] = useState('')
  const [activeTypes, setActiveTypes] = useState<string[]>([])
  const [isAdding, setIsAdding] = useState(false)
  const [editEntry, setEditEntry] = useState<MemoryFileEntry | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft())

  useEffect(() => {
    if (!initialized) void initialize()
  }, [initialized, initialize])

  const visible = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return entries.filter((e) => {
      if (activeTypes.length > 0 && !activeTypes.includes(e.type || '')) return false
      if (!q) return true
      return `${e.name}\n${e.description}\n${e.content}\n${e.relativePath}`.toLowerCase().includes(q)
    })
  }, [entries, searchQuery, activeTypes])

  const toggleType = (type: string) => {
    setActiveTypes(
      activeTypes.includes(type) ? activeTypes.filter((x) => x !== type) : [...activeTypes, type]
    )
  }

  /** 新增：写文件 + 索引行（名称缺省时取描述/正文首段） */
  const handleAdd = async () => {
    if (!draft.content.trim()) return
    const name = draft.name.trim() || draft.description.trim() || draft.content.trim().slice(0, 20)
    const description = draft.description.trim() || draft.content.trim().slice(0, 30)
    const slug = memoryFileName(name).replace(/\.md$/, '')
    let path = `${slug}.md`
    const taken = new Set(entries.map((e) => e.relativePath))
    for (let i = 2; taken.has(path); i++) path = `${slug}-${i}.md`
    const ok = await writeMemoryFile(
      path,
      buildMemoryFileContent(name, description, draft.type || undefined, draft.content.trim())
    )
    if (ok) await upsertIndexLine(path, name, description)
    setIsAdding(false)
    setDraft(emptyDraft())
  }

  /** 编辑：改写同一文件（路径不变）；名称/描述变化时同步索引行 */
  const handleSaveEdit = async () => {
    if (!editEntry || !draft.content.trim()) return
    const name = draft.name.trim() || editEntry.name
    const description = draft.description.trim() || editEntry.description
    const ok = await writeMemoryFile(
      editEntry.relativePath,
      buildMemoryFileContent(name, description, draft.type || undefined, draft.content.trim())
    )
    if (ok) await upsertIndexLine(editEntry.relativePath, name, description)
    setEditEntry(null)
    setDraft(emptyDraft())
  }

  /** 删除：文件+索引行一步净（store 统一入口，与覆层遗忘同路径） */
  const handleDelete = async (entry: MemoryFileEntry) => {
    await deleteMemoryWithIndex(entry.relativePath)
  }

  const startEdit = (entry: MemoryFileEntry) => {
    setEditEntry(entry)
    setDraft({
      name: entry.name,
      description: entry.description,
      type: (MEMORY_FILE_TYPES as string[]).includes(entry.type) ? (entry.type as MemoryFileType) : '',
      content: entry.content,
    })
  }

  const closeDialog = () => {
    setIsAdding(false)
    setEditEntry(null)
    setDraft(emptyDraft())
  }

  const renderDialog = () => {
    const isOpen = isAdding || !!editEntry
    if (!isOpen) return null
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div
          className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl"
          style={{ background: 'var(--wf-card-bg)', boxShadow: 'var(--wf-pop)' }}
        >
          <div className="px-6 py-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--wf-hair)' }}>
            <h3 className="text-[15px] font-semibold" style={{ color: 'var(--wf-ink)' }}>
              {isAdding ? t('memory.memoryManager.addMemory') : t('memory.memoryManager.edit')}
            </h3>
            <button
              onClick={closeDialog}
              className="wf-press p-1.5 rounded-lg"
              style={{ color: 'var(--wf-mut)' }}
            >
              <X size={18} />
            </button>
          </div>
          <div className="p-6 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[12px] font-medium mb-1" style={{ color: 'var(--wf-sub)' }}>
                  {t('memory.file.name')}
                </label>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="wf-ink-input"
                  placeholder={t('memory.file.namePlaceholder')}
                />
              </div>
              <div>
                <label className="block text-[12px] font-medium mb-1" style={{ color: 'var(--wf-sub)' }}>
                  {t('memory.memoryManager.type')}
                </label>
                <select
                  value={draft.type}
                  onChange={(e) => setDraft({ ...draft, type: e.target.value as MemoryFileType | '' })}
                  className="wf-ink-select"
                >
                  <option value="">{t('memory.fileTypes.note')}</option>
                  {MEMORY_FILE_TYPE_VALUES.map((tp) => (
                    <option key={tp} value={tp}>
                      {t(fileTypeLabelKey(tp))}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-[12px] font-medium mb-1" style={{ color: 'var(--wf-sub)' }}>
                {t('memory.file.desc')}
              </label>
              <input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                className="wf-ink-input"
                placeholder={t('memory.file.descPlaceholder')}
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium mb-1" style={{ color: 'var(--wf-sub)' }}>
                {t('memory.memoryManager.content')}
              </label>
              <textarea
                value={draft.content}
                onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                rows={5}
                className="wf-ink-input resize-none"
                placeholder={t('memory.memoryManager.contentPlaceholder')}
              />
            </div>
          </div>
          <div className="px-6 py-4 border-t flex justify-end gap-2" style={{ borderColor: 'var(--wf-hair)' }}>
            <button onClick={closeDialog} className="wf-mini-btn wf-press">
              {t('memory.memoryManager.cancel')}
            </button>
            <button
              onClick={editEntry ? handleSaveEdit : handleAdd}
              disabled={!draft.content.trim()}
              className="wf-cta wf-press"
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
    <div
      className="relative flex flex-col h-full flex-1 min-w-0 wf-mempg"
      style={{ background: 'var(--wf-bg)', color: 'var(--wf-ink)' }}
    >
      {/* 滚动容器 = 房间头 + 内容（wf-room-scroll 治理滚动槽，技能页同律） */}
      <div className="flex-1 overflow-y-auto wf-room-scroll">
        {/* sticky 页头：单色图标块 + 标题 + 副标题，操作按钮收进右侧（蓝图三段式） */}
        <div className="wf-mempg-head">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="wf-mempg-head-ic">
                <Brain size={20} />
              </span>
              <div>
                <h1 className="text-[20px] font-bold leading-tight" style={{ color: 'var(--wf-ink)' }}>
                  {t('memory.memoryManager.title')}
                </h1>
                <p className="text-[13px] mt-1 mb-4" style={{ color: 'var(--wf-mut)' }}>
                  {t('memory.memoryManager.memoryCount', { count: entries.length })}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={() => {
                  setDraft(emptyDraft())
                  setIsAdding(true)
                }}
                className="wf-cta wf-press"
              >
                <Plus size={13} />
                {t('memory.memoryManager.addMemory')}
              </button>
            </div>
          </div>

          {/* 搜索 + 类型筛选 */}
          <div className="pb-4 border-b" style={{ borderColor: 'var(--wf-hair)' }}>
            <div className="flex items-center gap-3">
              <div className="relative flex-1 max-w-md">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 wf-mempg-mut pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('memory.memoryManager.search')}
                  className="wf-ink-input !pl-8"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 mt-3">
              <Filter size={13} className="wf-mempg-faint mr-0.5 flex-none" />
              {(['', ...MEMORY_FILE_TYPE_VALUES] as string[]).map((tp) => (
                <button
                  key={tp || '_note'}
                  onClick={() => toggleType(tp)}
                  className={cn('wf-mempg-chip wf-press', activeTypes.includes(tp) && 'on')}
                >
                  {t(fileTypeLabelKey(tp))}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 列表 */}
        <div className="wf-mempg-body">
          {visible.length === 0 && (
            <div className="text-center py-16">
              <span className="wf-mempg-empty-ic">
                <Brain size={22} />
              </span>
              <p className="text-[13px]" style={{ color: 'var(--wf-mut)' }}>
                {searchQuery || activeTypes.length > 0
                  ? t('memory.memoryManager.noMatch')
                  : t('memory.memoryManager.noMemories')}
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
            {visible.map((mem) => (
              <div key={mem.relativePath} className="wf-mempg-card">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 mb-2">
                      <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', FILE_TYPE_BADGE[mem.type] ?? 'bg-surface-200 text-surface-700')}>
                        {t(fileTypeLabelKey(mem.type))}
                      </span>
                      <span className="text-xs wf-mempg-mut flex items-center gap-1">
                        <Clock size={12} />
                        {formatDate(mem.lastModified, i18n.language)}
                      </span>
                      <span className="text-xs wf-mempg-mut">{mem.relativePath}</span>
                    </div>

                    {(mem.name || mem.description) && (
                      <p className="text-[13px] font-medium" style={{ color: 'var(--wf-ink)' }}>
                        {mem.name || mem.description}
                      </p>
                    )}
                    <p className="text-[13px] whitespace-pre-wrap mt-1" style={{ color: 'var(--wf-ink)' }}>
                      {mem.content}
                    </p>
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => startEdit(mem)}
                      className="p-1.5 rounded-lg wf-press wf-mempg-icbtn wf-mempg-icbtn-neu"
                      title={t('memory.memoryManager.edit')}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => void handleDelete(mem)}
                      className="p-1.5 rounded-lg wf-press wf-mempg-icbtn wf-mempg-icbtn-red"
                      title={t('memory.memoryManager.delete')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {renderDialog()}
    </div>
  )
}
