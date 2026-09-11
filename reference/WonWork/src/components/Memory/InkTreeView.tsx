import { memo, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useFileMemoryStore } from '@/stores/fileMemoryStore'
import { useMemoryDockStore } from '@/stores/memoryDockStore'
import type { MemoryFileEntry } from '@/types/memoryFile'
import { MEMORY_FILE_TYPE_VALUES, fileTypeLabelKey } from './fileTypeUi'
import { useForget } from './useInkActions'

const PER_BRANCH_CAP = 4

const Leaf = memo(function Leaf({
  entry,
  index,
  onForget,
  fading,
}: {
  entry: MemoryFileEntry
  index: number
  onForget: (e: MemoryFileEntry) => void
  fading: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const focusId = useMemoryDockStore((s) => s.focusId)

  return (
    <>
      <div
        className={`wf-mem-leaf${fading ? ' wf-mem-forgetting' : ''}${focusId === entry.relativePath ? ' lit' : ''}`}
        style={{ '--i': index } as React.CSSProperties}
        data-mem-id={entry.relativePath}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="wf-mem-leaf-text">{entry.description || entry.content.split('\n')[0]}</span>
      </div>
      {open && (
        <div className="wf-mem-leaf-detail">
          <div className="wf-mem-text">{entry.content}</div>
          <div className="wf-mem-meta">
            <span>
              {entry.relativePath} · {entry.lastModified.slice(0, 10)}
            </span>
          </div>
          <div className="wf-mem-confirm-row">
            <button
              className="wf-mem-act danger"
              title={t('memory.dock.delete')}
              onClick={() => onForget(entry)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      )}
    </>
  )
})

/**
 * 分类树（2026-09-03 文件化重写）：枝 = 记忆文件类型（user/feedback/project/reference + 无类型速记），
 * 叶 = 记忆文件。排序只按修改时间（召回计数/激活标记随 SQLite 链路退役——
 * 文件世界里模型经索引自取，没有 access 统计）。
 */
export const InkTreeView = memo(function InkTreeView() {
  const { t } = useTranslation()
  const entries = useFileMemoryStore((s) => s.entries)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [expandedBranches, setExpandedBranches] = useState<Set<string>>(new Set())
  const { fading, collapsing, forget } = useForget()

  const branches = useMemo(() => {
    const byType = new Map<string, MemoryFileEntry[]>()
    for (const e of entries) {
      // 枚举外 type（模型手写文件时可能出现）归入速记枝，不静默丢弃
      const known = (MEMORY_FILE_TYPE_VALUES as string[]).includes(e.type)
      const key = e.type && known ? e.type : ''
      if (!byType.has(key)) byType.set(key, [])
      byType.get(key)!.push(e)
    }
    const order = [...MEMORY_FILE_TYPE_VALUES, '']
    return order
      .filter((k) => byType.has(k))
      .map((k) => ({
        type: k,
        list: byType.get(k)!.sort((a, b) => b.lastModified.localeCompare(a.lastModified)),
      }))
  }, [entries])

  const toggleCollapse = (type: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })

  const toggleExpandBranch = (type: string) =>
    setExpandedBranches((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })

  let leafIndex = 0

  return (
    <div className="wf-mem-tree">
      {branches.length === 0 && (
        <div className="wf-mem-empty">
          {t('memory.dock.empty')}
          <br />
          {t('memory.dock.emptyHint')}
        </div>
      )}
      {branches.map(({ type, list }) => {
        const isCollapsed = collapsed.has(type)
        const expandedAll = expandedBranches.has(type)
        const shown = expandedAll ? list : list.slice(0, PER_BRANCH_CAP)
        return (
          <div className={`wf-mem-branch${isCollapsed ? ' closed' : ''}`} key={type || '_note'}>
            <div className="wf-mem-branch-head" onClick={() => toggleCollapse(type)}>
              <ChevronDown size={13} className="wf-mem-branch-chev" />
              {t(fileTypeLabelKey(type))}
              <span className="wf-mem-branch-count">{list.length}</span>
            </div>
            <div className="wf-mem-branch-leaves">
              <div className="wf-mem-branch-wrap">
                {shown.map((e) => (
                  <div
                    key={e.relativePath}
                    className={`wf-mem-collapse${collapsing.has(e.relativePath) ? ' c0' : ''}`}
                  >
                    <Leaf
                      entry={e}
                      index={leafIndex++}
                      onForget={forget}
                      fading={fading.has(e.relativePath)}
                    />
                  </div>
                ))}
                {list.length > PER_BRANCH_CAP && (
                  <button className="wf-mem-more" onClick={() => toggleExpandBranch(type)}>
                    {expandedAll ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    {!expandedAll && list.length - PER_BRANCH_CAP}
                  </button>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
})
