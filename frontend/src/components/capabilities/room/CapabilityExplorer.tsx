import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from 'react'
import {
  Brain,
  ChevronLeft,
  Clock3,
  Grid3X3,
  List,
  Plug,
  Plus,
  RefreshCw,
  Search,
  SearchX,
} from 'lucide-react'
import {
  capabilityAdminApi,
  capabilityManagementApi,
  type CapabilityAdminItem,
  type CapabilityAdminListing,
  type CapabilityAdminProblem,
  type CapabilityTreeNode,
  type SkillView,
} from '@/api/irisApi'
import { Button, Input, notify } from '@/components/ui'
import { cn } from '@/lib/cn'
import { kindMeta } from '@/domain/capability/kindMeta'
import { riskMeta, type BadgeTone } from '@/domain/capability/riskMeta'
import {
  cacheCapabilityDetail,
  cacheCapabilityListing,
  invalidateAll,
  makeCapabilityDetailKey,
  readCapabilityCenterCache,
  readCapabilityDetail,
  readCapabilityListing,
  syncWithGeneration,
  writeCapabilityCenterCache,
} from '@/domain/capability/capabilityCenterCache'
import { QuietState, useFocusReturn } from '../controls'
import { SkillEditor } from '../SkillEditor'
import { DirectoryTree } from './DirectoryTree'
import { CapabilityDetailPanel } from './CapabilityDetailPanel'

const RISK_EDGE: Record<BadgeTone, string> = {
  neutral: '',
  info: '',
  success: '',
  warning: 'ring-warning ring-[1.5px]',
  danger: 'ring-danger ring-[1.5px]',
  violet: '',
  teal: '',
}

const STAT_LABELS: Record<string, string> = {
  tool_count: '工具数',
  success_rate_7d: '7 日成功率',
  p50_ms_7d: '7 日 p50',
}

function formatStat(key: string, value: unknown): string {
  if (key === 'success_rate_7d') {
    const rate = Number(value)
    return Number.isFinite(rate)
      ? `${Math.round((rate > 1 ? rate : rate * 100) * 10) / 10}%`
      : String(value)
  }
  if (key === 'p50_ms_7d') return `${String(value)} ms`
  return String(value)
}

function findNode(
  node: CapabilityTreeNode,
  path: string,
): CapabilityTreeNode | null {
  if (node.path === path) return node
  for (const child of node.children) {
    const found = findNode(child, path)
    if (found) return found
  }
  return null
}

function ancestorsOf(path: string): string[] {
  const result = ['/']
  const segments = path.split('/').filter(Boolean)
  let current = ''
  for (const segment of segments.slice(0, -1)) {
    current += `/${segment}`
    result.push(current)
  }
  return result
}

function parentPathOf(path: string): string {
  if (path === '/') return '/'
  const idx = path.lastIndexOf('/')
  return idx <= 0 ? '/' : path.slice(0, idx)
}

function fuzzyMatch(haystack: string, needle: string): boolean {
  const text = haystack.toLowerCase()
  const tokens = needle
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  return tokens.every((token) => text.includes(token))
}

function intersects(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
): boolean {
  return (
    a.left < b.right &&
    a.right > b.left &&
    a.top < b.bottom &&
    a.bottom > b.top
  )
}

export function CapabilityExplorer({
  consumeEscRef,
  onOpenMcp,
  onOpenMemory,
  onOpenSchedule,
  onClose,
}: {
  consumeEscRef?: MutableRefObject<() => boolean>
  onOpenMcp: (serverId?: string) => void
  onOpenMemory: () => void
  onOpenSchedule: () => void
  onClose: () => void
}) {
  const snapshot = useMemo(readCapabilityCenterCache, [])
  const [tree, setTree] = useState<CapabilityTreeNode | null>(snapshot.tree)
  const [treeFailed, setTreeFailed] = useState(snapshot.treeFailed)
  const [selectedPath, setSelectedPath] = useState(snapshot.selectedPath)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(snapshot.expanded),
  )
  const [listing, setListing] = useState<CapabilityAdminListing | null>(
    snapshot.listings[snapshot.selectedPath]?.data ?? null,
  )
  const [listingLoading, setListingLoading] = useState(
    !snapshot.listings[snapshot.selectedPath]?.data,
  )
  const [skills, setSkills] = useState<SkillView[]>(snapshot.skills)
  const [problems, setProblems] = useState<CapabilityAdminProblem[]>(
    snapshot.problems,
  )
  const [query, setQuery] = useState('')
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [detailPath, setDetailPath] = useState<string | null>(null)
  const [detailStatus, setDetailStatus] = useState<
    Record<string, 'loading' | 'error'>
  >({})
  const [editingSkill, setEditingSkill] = useState<
    SkillView | undefined | null
  >(null)
  const [refreshing, setRefreshing] = useState(false)
  const [generationSynced, setGenerationSynced] = useState(false)
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
  const [cursorPath, setCursorPath] = useState<string | null>(null)
  const [rotation, setRotation] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const consumeEsc = useCallback(() => {
    if (query.trim().length > 0) {
      setQuery('')
      return true
    }
    if (detailPath) {
      setDetailPath(null)
      return true
    }
    if (selection.size > 0) {
      setSelection(new Set())
      setCursorPath(null)
      return true
    }
    return false
  }, [query, detailPath, selection])

  useEffect(() => {
    if (!consumeEscRef) return
    consumeEscRef.current = consumeEsc
    return () => {
      consumeEscRef.current = () => false
    }
  }, [consumeEscRef, consumeEsc])

  const [drag, setDrag] = useState<
    | {
        start: { x: number; y: number }
        current: { x: number; y: number }
      }
    | null
  >(null)
  const { rootRef, captureFocusKey, restoreFocus } =
    useFocusReturn<HTMLDivElement>()

  const reloadTree = () =>
    capabilityAdminApi
      .tree()
      .then(({ generation, root }) => {
        setTree(root)
        setTreeFailed(false)
        writeCapabilityCenterCache({
          tree: root,
          treeGeneration: generation,
          treeFailed: false,
          treeLoaded: true,
        })
      })
      .catch((error: Error) => {
        setTreeFailed(true)
        writeCapabilityCenterCache({ treeFailed: true, treeLoaded: true })
        notify.error('能力目录暂时不可用', { description: error.message })
      })

  const reloadSkills = () =>
    capabilityManagementApi
      .listSkills()
      .then((next) => {
        setSkills(next)
        writeCapabilityCenterCache({ skills: next, skillsLoaded: true })
      })
      .catch(() => setSkills([]))

  const reloadProblems = () =>
    capabilityAdminApi
      .problems()
      .then((next) => {
        setProblems(next)
        writeCapabilityCenterCache({ problems: next, problemsLoaded: true })
      })
      .catch(() => setProblems([]))

  const reloadListing = (path: string, force = false) => {
    if (!force) {
      const cached = readCapabilityListing(path)
      if (cached) {
        setListing(cached)
        setListingLoading(false)
        return Promise.resolve()
      }
    }
    setListingLoading(true)
    return capabilityAdminApi
      .items(path)
      .then((next) => {
        setListing(next)
        cacheCapabilityListing(path, next)
      })
      .catch((error: Error) =>
        notify.error('没有读到该目录的能力', { description: error.message }),
      )
      .finally(() => setListingLoading(false))
  }

  const refreshAll = () => {
    setRefreshing(true)
    setRotation((r) => r + 360)
    invalidateAll()
    void Promise.allSettled([
      reloadTree(),
      reloadSkills(),
      reloadProblems(),
      reloadListing(selectedPath),
    ]).finally(() => setRefreshing(false))
  }

  useEffect(() => {
    let cancelled = false
    const probe = async () => {
      try {
        const { generation } = await capabilityAdminApi.generation()
        if (cancelled) return
        syncWithGeneration(generation)
      } catch {
        // 探针失败时回退到 loaded 标志，避免阻塞已有缓存的渲染。
      }
      if (!cancelled) setGenerationSynced(true)
    }
    probe()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    writeCapabilityCenterCache({ selectedPath })
    setQuery('')
    setDetailPath(null)
    setCursorPath(null)
    if (!generationSynced) return
    const after = readCapabilityCenterCache()
    if (!after.treeLoaded) void reloadTree()
    if (!after.skillsLoaded) void reloadSkills()
    if (!after.problemsLoaded) void reloadProblems()
    void reloadListing(selectedPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generationSynced, selectedPath])

  useEffect(() => {
    writeCapabilityCenterCache({ expanded: [...expanded] })
  }, [expanded])

  const selectPath = (path: string, alt = false) => {
    setSelectedPath(path)
    setExpanded((current) => {
      const chain = ancestorsOf(path)
      if (alt) {
        const next = new Set(current)
        for (const ancestor of chain) next.add(ancestor)
        next.add(path)
        return next
      }
      return new Set([...chain, path])
    })
    setQuery('')
    setDetailPath(null)
    setCursorPath(null)
  }

  const toggleExpanded = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const selectedNode = tree ? findNode(tree, selectedPath) : null

  const filteredItems = useMemo(() => {
    const needle = query.trim()
    const items = listing?.items ?? []
    if (!needle) return items
    return items.filter((item) =>
      fuzzyMatch(
        `${item.name} ${item.description ?? ''} ${item.path}`,
        needle,
      ),
    )
  }, [listing, query])

  const isSearching = query.trim().length > 0

  // 全局键盘：搜索聚焦、上下移动、Enter 打开详情、Backspace 回上级。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === '/' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f')) {
        event.preventDefault()
        searchRef.current?.focus()
        return
      }

      const target = event.target as HTMLElement
      const isTyping =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      if (isTyping) return

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const items = filteredItems
        if (items.length === 0) return
        const idx = items.findIndex((item) => item.path === cursorPath)
        const delta = event.key === 'ArrowDown' ? 1 : -1
        const nextIdx =
          idx < 0
            ? 0
            : Math.max(0, Math.min(items.length - 1, idx + delta))
        const path = items[nextIdx].path
        setCursorPath(path)
        setSelection(new Set([path]))
        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        const item =
          cursorPath != null
            ? filteredItems.find((i) => i.path === cursorPath)
            : filteredItems[0]
        if (item) toggleDetail(item)
        return
      }

      if (event.key === 'Backspace') {
        event.preventDefault()
        if (detailPath) {
          setDetailPath(null)
        } else {
          selectPath(parentPathOf(selectedPath))
        }
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorPath, detailPath, filteredItems, selectedPath])

  const toggleDetail = (item: CapabilityAdminItem) => {
    const path = item.path
    if (detailPath === path) {
      setDetailPath(null)
      return
    }
    setDetailPath(path)
    setCursorPath(path)
    const hash = item.manifestHash
    if (hash) {
      const cached = readCapabilityDetail(makeCapabilityDetailKey(path, hash))
      if (cached) return
    }
    setDetailStatus((current) => ({ ...current, [path]: 'loading' }))
    capabilityAdminApi
      .detail(path)
      .then((detail) => {
        if (hash) {
          cacheCapabilityDetail(makeCapabilityDetailKey(path, hash), detail)
        }
        setDetailStatus((current) => {
          const next = { ...current }
          delete next[path]
          return next
        })
      })
      .catch(() =>
        setDetailStatus((current) => ({ ...current, [path]: 'error' })),
      )
  }

  const detailStateOf = (item: CapabilityAdminItem) => {
    const status = detailStatus[item.path]
    if (status === 'loading') return { status: 'loading' as const }
    if (status === 'error') return { status: 'error' as const }
    const hash = item.manifestHash
    if (hash) {
      const cached = readCapabilityDetail(makeCapabilityDetailKey(item.path, hash))
      if (cached) return { status: 'ready' as const, detail: cached }
    }
    return undefined
  }

  const skillOf = (item: CapabilityAdminItem) =>
    item.origin === 'skill_store'
      ? skills.find(
          (skill) =>
            skill.skillId === item.id || skill.capabilityPath === item.path,
        )
      : undefined

  const toggleSkillEnabled = async (
    item: CapabilityAdminItem,
    skill: SkillView,
  ) => {
    const next = { ...skill, enabled: !skill.enabled }
    setSkills((items) =>
      items.map((entry) => (entry.skillId === skill.skillId ? next : entry)),
    )
    try {
      const updated = await capabilityManagementApi.setSkillEnabled(
        skill,
        !skill.enabled,
      )
      setSkills((items) => {
        const nextItems = items.map((entry) =>
          entry.skillId === skill.skillId ? updated : entry,
        )
        writeCapabilityCenterCache({ skills: nextItems })
        return nextItems
      })
      await reloadListing(selectedPath, true)
    } catch (error) {
      setSkills((items) =>
        items.map((entry) => (entry.skillId === skill.skillId ? skill : entry)),
      )
      notify.error('没有改变 Skill 状态', {
        description: (error as Error).message,
      })
    }
  }

  const handleItemClick = (
    item: CapabilityAdminItem,
    event: ReactMouseEvent,
  ) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      setSelection((current) => {
        const next = new Set(current)
        if (next.has(item.path)) next.delete(item.path)
        else next.add(item.path)
        return next
      })
      setCursorPath(item.path)
      return
    }

    if (event.shiftKey && cursorPath) {
      event.preventDefault()
      const items = filteredItems
      const from = items.findIndex((i) => i.path === cursorPath)
      const to = items.findIndex((i) => i.path === item.path)
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from]
        const range = items.slice(start, end + 1).map((i) => i.path)
        setSelection(new Set(range))
      }
      return
    }

    setSelection(new Set([item.path]))
    setCursorPath(item.path)
    toggleDetail(item)
  }

  // 框选
  useEffect(() => {
    if (!drag) return
    const onMove = (event: globalThis.MouseEvent) => {
      const container = contentRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      setDrag((current) =>
        current
          ? {
              ...current,
              current: {
                x: event.clientX - rect.left,
                y: event.clientY - rect.top,
              },
            }
          : null,
      )
    }
    const onUp = (event: globalThis.MouseEvent) => {
      const container = contentRef.current
      if (container) {
        const rect = container.getBoundingClientRect()
        const end = {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        }
        const box = {
          left: Math.min(drag.start.x, end.x),
          top: Math.min(drag.start.y, end.y),
          right: Math.max(drag.start.x, end.x),
          bottom: Math.max(drag.start.y, end.y),
        }
        const paths: string[] = []
        container.querySelectorAll<HTMLElement>('[data-item]').forEach((el) => {
          const r = el.getBoundingClientRect()
          const rel = {
            left: r.left - rect.left,
            top: r.top - rect.top,
            right: r.right - rect.left,
            bottom: r.bottom - rect.top,
          }
          if (intersects(box, rel)) {
            const path = el.dataset.item
            if (path) paths.push(path)
          }
        })
        setSelection(new Set(paths))
        if (paths.length > 0) setCursorPath(paths[paths.length - 1])
      }
      setDrag(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [drag])

  const onContentMouseDown = (event: ReactMouseEvent) => {
    if (event.button !== 0) return
    if (event.shiftKey || event.ctrlKey || event.metaKey) return
    const target = event.target as HTMLElement
    if (target.closest('[data-item]')) return
    const container = contentRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const start = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    setDrag({ start, current: start })
    setSelection(new Set())
    setCursorPath(null)
  }

  const detailItem = useMemo(
    () => filteredItems.find((item) => item.path === detailPath),
    [filteredItems, detailPath],
  )

  if (editingSkill !== null) {
    return (
      <div ref={rootRef} className="flex min-h-0 flex-1 flex-col p-5">
        <SkillEditor
          current={editingSkill}
          onCancel={() => {
            setEditingSkill(null)
            restoreFocus()
          }}
          onSaved={(skill) => {
            setEditingSkill(null)
            restoreFocus()
            void reloadSkills()
            void reloadTree()
            void reloadListing(selectedPath, true)
          }}
        />
      </div>
    )
  }

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-border/70 bg-surface-raised/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            <ChevronLeft className="h-4 w-4" />
            返回
          </Button>
          <h2 className="text-heading font-semibold text-ink">能力</h2>
          <Input
            ref={searchRef}
            aria-label="搜索能力"
            containerClassName="min-w-0 flex-1"
            className="h-8"
            leadingIcon={<Search className="h-3.5 w-3.5" />}
            placeholder="搜索：名称 / 路径（/ 或 Ctrl+F 聚焦）"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="全量刷新能力数据"
            disabled={refreshing}
            onClick={refreshAll}
          >
            <RefreshCw
              className="h-4 w-4 transition-transform duration-300 ease-standard motion-reduce:transition-none"
              style={{ transform: `rotate(${rotation}deg)` }}
            />
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[14rem_1fr] overflow-hidden">
        <nav className="scrollbar-subtle flex min-h-0 flex-col border-r border-border/70 bg-surface px-2 py-3">
          {tree ? (
            <ul>
              <DirectoryTree
                node={tree}
                depth={0}
                selectedPath={selectedPath}
                expanded={expanded}
                onToggle={toggleExpanded}
                onSelect={(path, alt) => selectPath(path, alt)}
              />
            </ul>
          ) : treeFailed ? (
            <QuietState
              icon={SearchX}
              title="目录读取失败。"
              hint="点右上角刷新按钮重试。"
            />
          ) : (
            <QuietState loading title="正在读取目录…" />
          )}
        </nav>

        <section className="flex min-h-0 flex-col bg-surface-raised">
          <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2">
            <Button
              variant="secondary"
              size="sm"
              data-focus-key="entry-new-skill"
              onClick={() => {
                captureFocusKey('entry-new-skill')
                setEditingSkill(undefined)
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              新建 Skill
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-focus-key="entry-mcp"
              onClick={() => onOpenMcp()}
            >
              <Plug className="h-3.5 w-3.5" />
              MCP 连接
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-focus-key="entry-schedule"
              onClick={onOpenSchedule}
            >
              <Clock3 className="h-3.5 w-3.5" />
              定时任务
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-focus-key="entry-memory"
              onClick={onOpenMemory}
            >
              <Brain className="h-3.5 w-3.5" />
              记忆
            </Button>
            <div className="ml-auto flex items-center rounded-sm border border-border p-0.5">
              <button
                type="button"
                aria-pressed={viewMode === 'grid'}
                aria-label="图标砖视图"
                className={cn(
                  'grid h-7 w-7 place-items-center rounded-xs transition-colors',
                  viewMode === 'grid'
                    ? 'bg-surface-muted text-ink'
                    : 'text-ink-muted hover:text-ink-subtle',
                )}
                onClick={() => setViewMode('grid')}
              >
                <Grid3X3 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-pressed={viewMode === 'list'}
                aria-label="列表视图"
                className={cn(
                  'grid h-7 w-7 place-items-center rounded-xs transition-colors',
                  viewMode === 'list'
                    ? 'bg-surface-muted text-ink'
                    : 'text-ink-muted hover:text-ink-subtle',
                )}
                onClick={() => setViewMode('list')}
              >
                <List className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div
            ref={contentRef}
            className="scrollbar-subtle relative min-h-0 flex-1 overflow-y-auto p-4"
            onMouseDown={onContentMouseDown}
          >
            {listingLoading ? (
              <QuietState loading title="正在读取能力…" />
            ) : filteredItems.length === 0 ? (
              <QuietState
                icon={SearchX}
                title={
                  isSearching
                    ? '没有匹配的能力。'
                    : '这个目录下还没有可直接寻址的能力。'
                }
                hint={
                  isSearching
                    ? '换个关键词，或按 Esc 清空搜索。'
                    : '换个目录看看，或在上方搜索。'
                }
              />
            ) : viewMode === 'grid' ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
                {filteredItems.map((item) => (
                  <CapabilityTile
                    key={item.path}
                    item={item}
                    selected={selection.has(item.path)}
                    onClick={(event) => handleItemClick(item, event)}
                    showBreadcrumb={isSearching}
                  />
                ))}
              </div>
            ) : (
              <div className="grid gap-1">
                {filteredItems.map((item) => (
                  <CapabilityRow
                    key={item.path}
                    item={item}
                    selected={selection.has(item.path)}
                    onClick={(event) => handleItemClick(item, event)}
                    showBreadcrumb={isSearching}
                  />
                ))}
              </div>
            )}

            {detailItem && (
              <div className="mt-4 animate-node-enter border-t border-border/70 pt-4 motion-reduce:animate-none">
                <CapabilityDetailPanel
                  item={detailItem}
                  state={detailStateOf(detailItem)}
                  skill={skillOf(detailItem)}
                  onEditSkill={(skill) => {
                    captureFocusKey(`skill-edit-${detailItem.path}`)
                    setEditingSkill(skill)
                  }}
                  onToggleSkill={(skill) => void toggleSkillEnabled(detailItem, skill)}
                  onOpenMcp={onOpenMcp}
                />
              </div>
            )}

            {drag && (
              <div
                className="pointer-events-none absolute border border-primary bg-primary/10"
                style={{
                  left: Math.min(drag.start.x, drag.current.x),
                  top: Math.min(drag.start.y, drag.current.y),
                  width: Math.abs(drag.current.x - drag.start.x),
                  height: Math.abs(drag.current.y - drag.start.y),
                }}
              />
            )}
          </div>

          <footer className="flex shrink-0 items-center justify-between border-t border-border/60 bg-surface px-4 py-2 text-caption text-ink-muted">
            <div className="flex items-center gap-2">
              <span>{(listing?.items ?? []).length} 项</span>
              <span>·</span>
              <span>选中 {selection.size} 项</span>
              {selectedNode && Object.keys(selectedNode.stats).length > 0 && (
                <>
                  <span>·</span>
                  <span>
                    {Object.entries(selectedNode.stats)
                      .map(
                        ([key, value]) =>
                          `${STAT_LABELS[key] ?? key} ${formatStat(key, value)}`,
                      )
                      .join(' · ')}
                  </span>
                </>
              )}
            </div>
            {problems.length > 0 && (
              <span className="text-warning">{problems.length} 个扫描问题</span>
            )}
          </footer>
        </section>
      </div>
    </div>
  )
}

function CapabilityTile({
  item,
  selected,
  onClick,
  showBreadcrumb,
}: {
  item: CapabilityAdminItem
  selected: boolean
  onClick: (event: ReactMouseEvent) => void
  showBreadcrumb?: boolean
}) {
  const kind = kindMeta(item)
  const risk = item.riskLevel ? riskMeta(item.riskLevel) : undefined
  const riskEdge = risk ? RISK_EDGE[risk.tone] : ''
  return (
    <button
      type="button"
      data-item={item.path}
      onClick={onClick}
      className={cn(
        'group flex flex-col items-center gap-2 rounded-md border border-transparent p-3 text-left transition-colors duration-fast',
        'hover:bg-surface-muted focus-visible:outline-none focus-visible:shadow-focus',
      )}
    >
      <span
        className={cn(
          'grid h-12 w-12 place-items-center rounded-xl',
          kind.tileClass,
          selected
            ? 'ring-[1.5px] ring-primary ring-offset-2 ring-offset-surface-raised'
            : riskEdge,
        )}
      >
        <kind.Icon className="h-6 w-6" />
      </span>
      <div className="grid min-w-0 gap-0.5 text-center">
        <span className="truncate text-[14px] font-medium text-ink">
          {item.name}
        </span>
        {item.description && (
          <span className="line-clamp-2 text-[12.5px] leading-relaxed text-ink-subtle">
            {item.description}
          </span>
        )}
        <StatusLine item={item} />
        {showBreadcrumb && (
          <code className="truncate text-caption text-ink-muted">
            {parentPathOf(item.path)}
          </code>
        )}
      </div>
    </button>
  )
}

function CapabilityRow({
  item,
  selected,
  onClick,
  showBreadcrumb,
}: {
  item: CapabilityAdminItem
  selected: boolean
  onClick: (event: ReactMouseEvent) => void
  showBreadcrumb?: boolean
}) {
  const kind = kindMeta(item)
  const risk = item.riskLevel ? riskMeta(item.riskLevel) : undefined
  const riskEdge = risk ? RISK_EDGE[risk.tone] : ''
  return (
    <button
      type="button"
      data-item={item.path}
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-left transition-colors duration-fast',
        'hover:bg-surface-muted focus-visible:outline-none focus-visible:shadow-focus',
      )}
    >
      <span
        className={cn(
          'grid h-9 w-9 shrink-0 place-items-center rounded-lg',
          kind.tileClass,
          selected
            ? 'ring-[1.5px] ring-primary ring-offset-2 ring-offset-surface-raised'
            : riskEdge,
        )}
      >
        <kind.Icon className="h-4 w-4" />
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[14px] font-medium text-ink">
            {item.name}
          </span>
          <StatusLine item={item} />
        </div>
        {item.description && (
          <span className="truncate text-[12.5px] leading-relaxed text-ink-subtle">
            {item.description}
          </span>
        )}
        {showBreadcrumb && (
          <code className="truncate text-caption text-ink-muted">
            {parentPathOf(item.path)}
          </code>
        )}
      </div>
    </button>
  )
}

function StatusLine({ item }: { item: CapabilityAdminItem }) {
  if (item.shadowedBy !== null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-caption text-ink-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-warning" />
        被遮蔽
      </span>
    )
  }
  if (item.availability && item.availability !== 'available') {
    return (
      <span className="inline-flex items-center gap-1.5 text-caption text-ink-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-warning" />
        {item.availabilityReason ?? item.availability}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-ink-muted">
      <span className="h-1.5 w-1.5 rounded-full bg-success" />
      可用
    </span>
  )
}
