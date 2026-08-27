import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  Folder,
  FolderOpen,
  MoreHorizontal,
  SearchX,
} from 'lucide-react'
import type {
  CapabilityAdminItem,
  CapabilityAdminListing,
  CapabilityAdminProblem,
  CapabilityTreeNode,
} from '@/api/irisApi'
import { Button } from '@/components/ui'
import { NoticeBar } from '@/components/room'
import { cn } from '@/lib/cn'
import { kindMeta } from '@/domain/capability/kindMeta'
import { riskMeta, type BadgeTone } from '@/domain/capability/riskMeta'
import {
  ancestorsOf,
  fileNameOf,
  findNode,
  isValidMachineName,
  parentPathOf,
} from '@/domain/capability/treeUtils'
import { QuietState } from '../controls'
import { StatusLine } from './StatusLine'
import { highlightParts, type SearchResult } from './CapabilitySearch'

const RISK_EDGE: Record<BadgeTone, string> = {
  neutral: '',
  info: '',
  success: '',
  warning: 'ring-[1.5px] ring-inset ring-warning',
  danger: 'ring-[1.5px] ring-inset ring-danger',
  violet: '',
  teal: '',
}

/** 搜索交互槽：结果数据与动作都由壳层（CapabilityExplorer）备好，舞台只渲染。 */
export interface StageSearch {
  query: string
  result: SearchResult
  searchedAll: boolean
  searchingAll: boolean
  onSearchAll: () => void
  onClear: () => void
  onOpenDir: (path: string) => void
  onOpenItem: (item: CapabilityAdminItem) => void
}

export function StageView({
  selectedPath,
  rootTree,
  node,
  listing,
  listingLoading,
  description,
  problems,
  search,
  selection,
  clipboard,
  renamingPath,
  renameDraft,
  onRenameDraftChange,
  onRenameCommit,
  onRenameCancel,
  onItemClick,
  onItemContextMenu,
  onSelectPath,
  onOpenDirMenu,
}: {
  selectedPath: string
  rootTree: CapabilityTreeNode | null
  node: CapabilityTreeNode | null
  listing: CapabilityAdminListing | null
  listingLoading: boolean
  description: string | null
  problems: CapabilityAdminProblem[]
  search: StageSearch | null
  selection: ReadonlySet<string>
  clipboard: { mode: 'cut' | 'copy'; paths: string[] } | null
  renamingPath: string | null
  renameDraft: string
  onRenameDraftChange: (value: string) => void
  onRenameCommit: () => void
  onRenameCancel: () => void
  onItemClick: (item: CapabilityAdminItem, event: ReactMouseEvent) => void
  onItemContextMenu: (event: ReactMouseEvent, item: CapabilityAdminItem) => void
  onSelectPath: (path: string) => void
  onOpenDirMenu: (event: ReactMouseEvent) => void
}) {
  const [problemsOpen, setProblemsOpen] = useState(false)

  if (search) {
    return <SearchStage search={search} />
  }

  const isRoot = selectedPath === '/'
  const chain =
    selectedPath === '/'
      ? ['/']
      : [...ancestorsOf(selectedPath), selectedPath]
  const titleOf = (path: string) => {
    if (path === '/') return '全部能力'
    const found = rootTree ? findNode(rootTree, path) : null
    return found ? found.title || found.name : fileNameOf(path)
  }
  const dirTitle = isRoot
    ? '全部能力'
    : (node?.title || node?.name || fileNameOf(selectedPath))
  const dirDescription = isRoot
    ? '它会做的事，都住在这里。每个能力有且只有一个家。'
    : description
  const directories = listing?.directories ?? []
  const items = listing?.items ?? []

  return (
    <div>
      {/* 面包屑：当前段加粗不响应 */}
      <nav
        aria-label="目录路径"
        className="mb-2 flex flex-wrap items-center gap-1 text-caption text-ink-muted"
      >
        {chain.map((path, index) => {
          const here = index === chain.length - 1
          return (
            <span key={path} className="flex items-center gap-1">
              {index > 0 && <span aria-hidden="true" className="text-ink-muted/60">/</span>}
              {here ? (
                <span className="rounded-xs px-1 py-0.5 font-semibold text-ink">
                  {titleOf(path)}
                </span>
              ) : (
                <button
                  type="button"
                  className="press rounded-xs px-1 py-0.5 transition-colors duration-fast hover:bg-surface-muted hover:text-ink focus-visible:outline-none focus-visible:shadow-focus"
                  onClick={() => onSelectPath(path)}
                >
                  {titleOf(path)}
                </button>
              )}
            </span>
          )
        })}
      </nav>

      {/* 目录头 */}
      <div className="mb-5 flex items-start gap-3.5">
        <div className="min-w-0 flex-1">
          <h3 className="text-[20px] font-bold leading-[30px] tracking-[-0.01em] text-ink">
            {dirTitle}
          </h3>
          {dirDescription && (
            <p className="mt-1 max-w-[520px] text-small leading-relaxed text-ink-muted">
              {dirDescription}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pt-1">
          {node && (
            <span className="rounded-xs bg-surface-muted px-2 py-1 font-mono text-caption text-ink-muted">
              {node.count} 个能力
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="press h-8 w-8 rounded-md"
            aria-label="目录操作"
            onClick={onOpenDirMenu}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* 需要注意聚合条 */}
      {problems.length > 0 && (
        <div className="mb-5">
          <NoticeBar
            action={problemsOpen ? '收起' : '去看看'}
            onClick={() => setProblemsOpen((open) => !open)}
          >
            <b className="font-semibold text-ink">{problems.length} 个能力</b>
            需要注意：{problems[0].description}
          </NoticeBar>
          {problemsOpen && (
            <ul className="mt-2 grid gap-1 animate-node-enter motion-reduce:animate-none">
              {problems.map((problem, index) => (
                <li
                  key={`${problem.root}-${problem.file ?? index}`}
                  className="flex items-baseline gap-2 rounded-md bg-surface-muted px-3 py-2"
                >
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full bg-warning"
                  />
                  <span className="min-w-0 flex-1 text-small text-ink-subtle">
                    {problem.description}
                  </span>
                  {problem.file && (
                    <code className="shrink-0 text-caption text-ink-muted">
                      {problem.file}
                    </code>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {listingLoading ? (
        <GridSkeleton />
      ) : isRoot ? (
        directories.length === 0 ? (
          <QuietState
            icon={FolderOpen}
            title="这里还是空的"
            hint="接入能力后，它们会按域住进各自的目录，每个能力有且只有一个家。"
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3.5">
            {directories.map((dir, index) => (
              <button
                key={dir.path}
                type="button"
                onClick={() => onSelectPath(dir.path)}
                className={cn(
                  'press-row rounded-xl border border-border bg-surface-raised p-4 text-left',
                  'transition-[border-color,transform,box-shadow] duration-normal ease-standard',
                  'hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-raised',
                  'focus-visible:outline-none focus-visible:shadow-focus',
                  'animate-node-enter motion-reduce:transform-none motion-reduce:animate-none',
                )}
                style={{ animationDelay: `${Math.min(index * 16, 128)}ms` }}
              >
                <div className="mb-2 flex items-center gap-2.5">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-muted text-ink-subtle">
                    <Folder className="h-4 w-4" />
                  </span>
                  <span className="truncate text-small font-semibold text-ink">
                    {dir.title}
                  </span>
                </div>
                <p className="line-clamp-2 min-h-[2.125rem] text-caption leading-relaxed text-ink-muted">
                  {dir.description}
                </p>
                <p className="mt-2 font-mono text-caption text-ink-muted">
                  {dir.capabilityCount} 个能力
                </p>
              </button>
            ))}
          </div>
        )
      ) : (
        <>
          {directories.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-2">
              {directories.map((dir) => (
                <button
                  key={dir.path}
                  type="button"
                  onClick={() => onSelectPath(dir.path)}
                  className={cn(
                    'press flex items-center gap-2 rounded-md border border-border bg-surface-raised px-3 py-2',
                    'text-small font-medium text-ink-subtle transition-colors duration-fast',
                    'hover:border-primary/40 hover:text-ink',
                    'focus-visible:outline-none focus-visible:shadow-focus',
                  )}
                >
                  <Folder className="h-3.5 w-3.5 text-ink-muted" />
                  {dir.title}
                  <span className="font-mono text-caption text-ink-muted">
                    {dir.capabilityCount}
                  </span>
                </button>
              ))}
            </div>
          )}
          {items.length === 0 && directories.length === 0 ? (
            <QuietState
              icon={FolderOpen}
              title="这里还是空的"
              hint="打开任意能力的详情层用「移动到」，它就搬来这里住了。"
            />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
              {items.map((item, index) => (
                <CapabilityTile
                  key={item.path}
                  item={item}
                  index={index}
                  selected={selection.has(item.path)}
                  cut={
                    clipboard?.mode === 'cut' &&
                    clipboard.paths.includes(item.path)
                  }
                  renaming={renamingPath === item.path}
                  renameDraft={renameDraft}
                  onRenameDraftChange={onRenameDraftChange}
                  onRenameCommit={onRenameCommit}
                  onRenameCancel={onRenameCancel}
                  onClick={(event) => onItemClick(item, event)}
                  onContextMenu={(event) => onItemContextMenu(event, item)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* ---------- 搜索舞台：按目录路径分组平铺，匹配字符高亮 ---------- */

function SearchStage({ search }: { search: StageSearch }) {
  const { result } = search
  const empty =
    result.dirs.length === 0 && result.groups.length === 0 && search.searchedAll
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-small text-ink-subtle">
        <span>
          搜索「<span className="font-medium text-ink">{search.query}</span>」
          {result.totalItems > 0 && `，${result.totalItems} 个结果`}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="press h-7 px-2 text-caption"
          onClick={search.onClear}
        >
          清空
        </Button>
      </div>

      {result.dirs.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {result.dirs.map((dir) => (
            <button
              key={dir.path}
              type="button"
              onClick={() => search.onOpenDir(dir.path)}
              className={cn(
                'press flex items-center gap-2 rounded-md border border-border bg-surface-raised px-3 py-2',
                'text-small font-medium text-ink-subtle transition-colors duration-fast',
                'hover:border-primary/40 hover:text-ink',
                'focus-visible:outline-none focus-visible:shadow-focus',
              )}
            >
              <Folder className="h-3.5 w-3.5 text-ink-muted" />
              <Highlighted text={dir.title} query={search.query} />
            </button>
          ))}
        </div>
      )}

      {result.groups.map((group) => (
        <section key={group.dirPath} className="mb-4">
          <h4 className="px-1 pb-1 text-caption font-semibold text-ink-muted">
            {group.dirTitle}
          </h4>
          <div className="grid gap-0.5">
            {group.items.map((item) => (
              <SearchHit
                key={item.path}
                item={item}
                query={search.query}
                onClick={() => search.onOpenItem(item)}
              />
            ))}
          </div>
        </section>
      ))}

      {!search.searchedAll && (
        <div className="mt-2 flex items-center gap-3 rounded-md bg-surface-muted px-3.5 py-2.5">
          <span className="min-w-0 flex-1 text-small text-ink-subtle">
            以上来自已经打开过的目录。
          </span>
          <Button
            variant="secondary"
            size="sm"
            className="press h-8 shrink-0"
            isLoading={search.searchingAll}
            loadingLabel="正在搜索"
            onClick={search.onSearchAll}
          >
            搜索全部目录
          </Button>
        </div>
      )}

      {empty && (
        <QuietState
          icon={SearchX}
          title={`没有找到「${search.query}」`}
          hint="换个词试试，或者回到目录里逛逛。它一定住在某个目录里。"
        />
      )}
    </div>
  )
}

function SearchHit({
  item,
  query,
  onClick,
}: {
  item: CapabilityAdminItem
  query: string
  onClick: () => void
}) {
  const kind = kindMeta(item)
  const risk = item.riskLevel ? riskMeta(item.riskLevel) : undefined
  const riskEdge = risk ? RISK_EDGE[risk.tone] : ''
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'press flex w-full items-center gap-3 rounded-md px-3 py-2 text-left',
        'transition-colors duration-fast hover:bg-surface-muted',
        'focus-visible:outline-none focus-visible:shadow-focus',
      )}
    >
      <span
        className={cn(
          'grid h-9 w-9 shrink-0 place-items-center rounded-lg',
          kind.tileClass,
          riskEdge,
        )}
      >
        <kind.Icon className="h-4 w-4" />
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate text-small font-semibold text-ink">
            <Highlighted text={item.name} query={query} />
          </span>
          <StatusLine item={item} />
        </span>
        <code className="truncate text-caption text-ink-muted">
          {parentPathOf(item.path)}
        </code>
      </span>
    </button>
  )
}

function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, index) =>
        part.match ? (
          <mark key={index} className="rounded-[3px] bg-primary-soft px-0.5 text-inherit">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  )
}

/* ---------- 能力砖：图标 + 名（蓝图手机桌面节奏），异常只在图标角落出黄点 ---------- */

function CapabilityTile({
  item,
  index,
  selected,
  cut,
  renaming,
  renameDraft,
  onRenameDraftChange,
  onRenameCommit,
  onRenameCancel,
  onClick,
  onContextMenu,
}: {
  item: CapabilityAdminItem
  index: number
  selected: boolean
  cut?: boolean
  renaming?: boolean
  renameDraft?: string
  onRenameDraftChange?: (value: string) => void
  onRenameCommit?: () => void
  onRenameCancel?: () => void
  onClick: (event: ReactMouseEvent) => void
  onContextMenu: (event: ReactMouseEvent) => void
}) {
  const kind = kindMeta(item)
  const risk = item.riskLevel ? riskMeta(item.riskLevel) : undefined
  const riskEdge = risk ? RISK_EDGE[risk.tone] : ''
  const hasIssue =
    item.shadowedBy !== null ||
    (item.availability != null && item.availability !== 'available')
  return (
    <button
      type="button"
      data-item={item.path}
      title={item.description ?? item.name}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={cn(
        'press group flex flex-col items-center gap-2.5 rounded-lg p-3 text-center',
        'transition-colors duration-fast',
        'focus-visible:outline-none focus-visible:shadow-focus',
        'animate-node-enter motion-reduce:animate-none',
        selected
          ? 'bg-surface-muted ring-1 ring-primary ring-offset-2 ring-offset-canvas'
          : 'hover:bg-surface-muted',
      )}
      style={{ animationDelay: `${Math.min(index * 16, 128)}ms` }}
    >
      <span
        className={cn(
          'relative grid h-12 w-12 place-items-center rounded-xl',
          'transition-transform duration-fast ease-standard group-hover:scale-105 motion-reduce:transition-none',
          kind.tileClass,
          riskEdge,
          cut && 'opacity-60 outline outline-1 outline-dashed outline-border',
        )}
      >
        <kind.Icon className="h-6 w-6" />
        {hasIssue && (
          <span
            aria-hidden="true"
            className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-warning ring-[2.5px] ring-canvas"
          />
        )}
      </span>
      {renaming ? (
        <RenameInput
          value={renameDraft ?? item.name}
          onChange={onRenameDraftChange ?? (() => {})}
          onCommit={onRenameCommit ?? (() => {})}
          onCancel={onRenameCancel ?? (() => {})}
        />
      ) : (
        <span className="w-full truncate text-[12.5px] font-medium text-ink">
          {item.name}
        </span>
      )}
    </button>
  )
}

function RenameInput({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  const valid = isValidMachineName(value.trim())
  return (
    <div className="grid w-full gap-1">
      <input
        type="text"
        value={value}
        autoFocus
        className={cn(
          'w-full rounded-xs border bg-surface-raised px-2 py-1 text-[12.5px] font-medium text-ink',
          'focus-visible:outline-none focus-visible:shadow-focus',
          valid
            ? 'border-border'
            : 'border-danger focus-visible:border-danger',
        )}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            if (valid) onCommit()
          } else if (e.key === 'Escape') {
            onCancel()
          }
        }}
        onBlur={() => {
          if (valid) onCommit()
          else onCancel()
        }}
        onClick={(e) => e.stopPropagation()}
      />
      {!valid && value.trim().length > 0 && (
        <span className="text-caption text-danger">
          仅小写、数字、短横线、下划线
        </span>
      )}
    </div>
  )
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
      {Array.from({ length: 10 }).map((_, index) => (
        <div
          key={index}
          className="flex flex-col items-center gap-2.5 rounded-lg p-3"
        >
          <span className="h-12 w-12 rounded-xl bg-surface-muted animate-pulse" />
          <span className="h-3.5 w-14 rounded bg-surface-muted animate-pulse" />
        </div>
      ))}
    </div>
  )
}
