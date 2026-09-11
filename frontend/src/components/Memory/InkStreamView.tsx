import { memo, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, PenLine, Search, Trash2, X } from 'lucide-react'
import { useFileMemoryStore } from '@/stores/fileMemoryStore'
import { useMemoryDockStore } from '@/stores/memoryDockStore'
import type { MemoryFileEntry } from '@/types/memoryFile'
import { FILE_TYPE_BADGE, fileTypeLabelKey } from './fileTypeUi'
import { useForget } from './useInkActions'

/** 每条卡片内的点击展开态（完整时间 + 全文） */
function useExpand() {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  return { expandedId, toggle: (id: string) => setExpandedId((p) => (p === id ? null : id)) }
}

function dayLabel(iso: string, t: (k: string) => string): string {
  const d = new Date(iso)
  const now = new Date()
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86400000)
  if (diffDays <= 0) return t('memory.dock.today')
  if (diffDays === 1) return t('memory.dock.yesterday')
  return `${d.getMonth() + 1}/${d.getDate()}`
}

const InkCard = memo(function InkCard({
  entry,
  index,
  fading,
  onForget,
}: {
  entry: MemoryFileEntry
  index: number
  fading: boolean
  onForget: (e: MemoryFileEntry) => void
}) {
  const { t } = useTranslation()
  const { expandedId, toggle } = useExpand()
  const focusId = useMemoryDockStore((s) => s.focusId)
  const expanded = expandedId === entry.relativePath
  // 卡片正文：默认描述/首行，点击原地展开看全文
  const preview = entry.description || entry.content.split('\n')[0]

  return (
    <div
      className={`wf-mem-card${fading ? ' wf-mem-forgetting' : ''}${focusId === entry.relativePath ? ' lit' : ''}${expanded ? ' expanded' : ''}`}
      style={{ '--i': index } as React.CSSProperties}
      data-mem-id={entry.relativePath}
      onClick={() => toggle(entry.relativePath)}
    >
      <div className="wf-mem-cardhead">
        <span className={FILE_TYPE_BADGE[entry.type] ?? 'wf-badge-mut'}>
          {t(fileTypeLabelKey(entry.type))}
        </span>
      </div>
      <div className="wf-mem-text">{expanded ? entry.content : preview}</div>
      {/* 底脚行：悬停显影——左 meta（修改时间）右动作（删除） */}
      <div className="wf-mem-cardfoot" onClick={(e) => e.stopPropagation()}>
        <span className="wf-mem-meta">
          {expanded && <span>{entry.lastModified.slice(0, 16).replace('T', ' ')}</span>}
          {expanded && <span>{entry.relativePath}</span>}
        </span>
        <span className="wf-mem-actions">
          <button
            className="wf-mem-act danger"
            title={t('memory.dock.delete')}
            onClick={() => onForget(entry)}
          >
            <Trash2 size={13} />
          </button>
        </span>
      </div>
    </div>
  )
})

const PER_GROUP_CAP = 6

/** 底部记一笔：用户主动写记忆（落成无类型速记文件），Enter 写入 */
const InkComposer = memo(function InkComposer() {
  const { t } = useTranslation()
  const addQuickNote = useFileMemoryStore((s) => s.addQuickNote)
  const [text, setText] = useState('')
  const [writing, setWriting] = useState(false)

  const submit = async () => {
    const content = text.trim()
    if (!content || writing) return
    setWriting(true)
    try {
      await addQuickNote(content)
      setText('')
    } finally {
      setWriting(false)
    }
  }

  return (
    <div className="wf-mem-composer">
      <PenLine size={14} />
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
        }}
        placeholder={t('memory.dock.writePlaceholder')}
        disabled={writing}
      />
    </div>
  )
})

/**
 * 时间流（2026-09-03 文件化重写）：按最后修改时间分日组的卡片流 + 底部记一笔。
 * 数据 = ~/.wonwork/memory/ 下的文件（fileMemoryStore 缓存视图）。
 * 旧模型的待确认/已归档/固定/语义寻迹随 SQLite 链路一并退役——
 * 文件世界里状态只有"在/不在"，检索是关键词匹配（条目 200 上限内足够）。
 */
export const InkStreamView = memo(function InkStreamView() {
  const { t } = useTranslation()
  const entries = useFileMemoryStore((s) => s.entries)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const { fading, collapsing, forget } = useForget()

  const { dayGroups, keywordResults } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const hay = (e: MemoryFileEntry) => `${e.name}\n${e.description}\n${e.content}`.toLowerCase()
    const keywordResults = q
      ? entries
          .filter((e) => hay(e).includes(q))
          .sort((a, b) => b.lastModified.localeCompare(a.lastModified))
      : []
    const sorted = [...entries].sort((a, b) => b.lastModified.localeCompare(a.lastModified))
    const groups = new Map<string, MemoryFileEntry[]>()
    for (const e of sorted) {
      const label = dayLabel(e.lastModified, t)
      if (!groups.has(label)) groups.set(label, [])
      groups.get(label)!.push(e)
    }
    return { dayGroups: [...groups.entries()], keywordResults }
  }, [entries, query, t])

  const runSearch = (term: string) => setQuery(term.trim())

  const clearSearch = () => {
    setDraft('')
    setQuery('')
  }

  const toggleGroup = (label: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })

  let cardIndex = 0
  const wrapCard = (e: MemoryFileEntry) => (
    <div key={e.relativePath} className={`wf-mem-collapse${collapsing.has(e.relativePath) ? ' c0' : ''}`}>
      <InkCard entry={e} index={cardIndex++} fading={fading.has(e.relativePath)} onForget={forget} />
    </div>
  )

  return (
    <>
      <div className="wf-mem-search">
        {searchOpen ? (
          <div className="wf-mem-searchfield">
            <button
              className="wf-mem-iconbtn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => runSearch(draft)}
              title={t('memory.dock.searchGo')}
            >
              <Search size={13} />
            </button>
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runSearch(draft)
                if (e.key === 'Escape') {
                  if (draft || query) clearSearch()
                  else setSearchOpen(false)
                }
              }}
              onBlur={() => {
                if (!draft.trim() && !query) setSearchOpen(false)
              }}
              placeholder={t('memory.dock.searchPlaceholder')}
            />
            <button
              className="wf-mem-iconbtn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (draft || query) clearSearch()
                else setSearchOpen(false)
              }}
              title={t('memory.dock.searchClose')}
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <button className="wf-mem-searchbtn" onClick={() => setSearchOpen(true)}>
            <Search size={13} />
            <span>{t('memory.dock.searchPlaceholder')}</span>
          </button>
        )}
      </div>
      {query.trim() ? (
        <div className="wf-mem-stream">
          <div className="wf-mem-day">{t('memory.dock.searchResults', { count: keywordResults.length })}</div>
          {keywordResults.length === 0 && <div className="wf-mem-empty">{t('memory.dock.searchNone')}</div>}
          <div className="wf-mem-grid">{keywordResults.map(wrapCard)}</div>
        </div>
      ) : (
        <div className="wf-mem-stream">
          {dayGroups.length === 0 && (
            <div className="wf-mem-empty">
              {t('memory.dock.empty')}
              <br />
              {t('memory.dock.emptyHint')}
            </div>
          )}
          {dayGroups.map(([label, list]) => {
            const expandedAll = expandedGroups.has(label)
            const shown = expandedAll ? list : list.slice(0, PER_GROUP_CAP)
            return (
              <div key={label}>
                <div className="wf-mem-day">{label}</div>
                <div className="wf-mem-grid">{shown.map(wrapCard)}</div>
                {list.length > PER_GROUP_CAP && (
                  <button className="wf-mem-more" onClick={() => toggleGroup(label)}>
                    {expandedAll ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    {!expandedAll && list.length - PER_GROUP_CAP}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
      <InkComposer />
    </>
  )
})
