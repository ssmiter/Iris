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
  Clock3,
  Plug,
  Plus,
  RefreshCw,
  Search,
  SearchX,
} from 'lucide-react'
import type { CapabilityAdminItem, SkillView } from '@/api/irisApi'
import { Button, ContextMenu, Input } from '@/components/ui'
import { RoomSide, RoomStage, RoomTopBar } from '@/components/room'
import {
  invalidateAll,
  readCapabilityCenterCache,
  readCapabilityListing,
} from '@/domain/capability/capabilityCenterCache'
import {
  ancestorsOf,
  fileNameOf,
  findNode,
  parentPathOf,
} from '@/domain/capability/treeUtils'
import { QuietState, useFocusReturn } from '../controls'
import { SkillEditor } from '../SkillEditor'
import { DirectoryTree, TreeSkeleton } from './DirectoryTree'
import { StageView, type StageSearch } from './StageView'
import { DetailLayer } from './DetailLayer'
import { MoveToPopover } from './MoveToPopover'
import { DeleteConfirmModal } from './DeleteConfirmModal'
import { useCapabilityData } from './useCapabilityData'
import { useCapabilityFileOps } from './useCapabilityFileOps'
import { useExplorerMenus } from './useExplorerMenus'
import { useDragSelect } from './useDragSelect'
import { useCapabilityDetail } from './useCapabilityDetail'
import { useCapabilitySearch } from './useCapabilitySearch'

/**
 * 能力房壳（docs/39 §6 拆分后）：键盘层栈、选择/剪贴板留在壳，数据加载 /
 * 文件操作 / 右键菜单 / 框选 / 详情 / 搜索各归其 hook；
 * 舞台渲染在 StageView，详情在 DetailLayer，搜索纯函数在 CapabilitySearch。
 */
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
  const { rootRef, captureFocusKey, restoreFocus } =
    useFocusReturn<HTMLDivElement>()
  const [editingSkill, setEditingSkill] = useState<
    SkillView | undefined | null
  >(null)

  const data = useCapabilityData()
  const {
    tree,
    treeFailed,
    selectedPath,
    listing,
    skills,
    problems,
    pins,
    listingsVersion,
  } = data

  // ===== 选择 / 剪贴板（壳保留） =====

  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
  const [cursorPath, setCursorPath] = useState<string | null>(null)
  const [clipboard, setClipboard] = useState<{
    mode: 'cut' | 'copy'
    paths: string[]
  } | null>(null)

  const searchRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const treeTitleOf = useCallback(
    (path: string): string => {
      if (path === '/') return '全部能力'
      const found = tree ? findNode(tree, path) : null
      return found ? found.title || found.name : fileNameOf(path)
    },
    [tree],
  )

  /** 目录的完整标题链（搜索分组头用）：全部能力 / 域 / 子目录。 */
  const chainTitleOf = useCallback(
    (path: string): string => {
      if (path === '/') return '全部能力'
      return [...ancestorsOf(path), path].map(treeTitleOf).join(' / ')
    },
    [treeTitleOf],
  )

  // ===== 详情 / 搜索 / 文件操作 / 菜单 / 框选 =====

  const detail = useCapabilityDetail({ listing, listingsVersion })

  const search = useCapabilitySearch({
    tree,
    listing,
    listingsVersion,
    chainTitleOf,
    onListingsChanged: data.bumpListings,
  })

  const afterMutation = async () => {
    invalidateAll()
    search.resetScope()
    data.bumpListings()
    await Promise.all([
      data.reloadTree(),
      data.reloadPins(),
      data.reloadListing(selectedPath, true),
    ])
  }

  const fileOps = useCapabilityFileOps({
    clipboard,
    setClipboard,
    selectedPath,
    treeTitleOf,
    afterMutation,
    setSelection,
    setCursorPath,
    closeDetail: detail.closeDetail,
  })

  const toggleDetail = (item: CapabilityAdminItem) => {
    if (detail.detailPath === item.path) {
      detail.closeDetail()
      return
    }
    detail.openDetail(item)
    setCursorPath(item.path)
  }

  const skillOf = (item: CapabilityAdminItem) =>
    item.origin === 'skill_store'
      ? skills.find(
          (skill) =>
            skill.skillId === item.id || skill.capabilityPath === item.path,
        )
      : undefined

  const openDetailOrEdit = (item: CapabilityAdminItem) => {
    if (item.origin === 'skill_store') {
      const skill = skillOf(item)
      if (skill) {
        captureFocusKey(`skill-edit-${item.path}`)
        setEditingSkill(skill)
        return
      }
    }
    toggleDetail(item)
  }

  /** 目录跳转的唯一入口：清搜索/详情/光标（树、面包屑、详情层共用）。 */
  const selectPath = useCallback(
    (path: string, alt = false) => {
      data.setSelectedPath(path)
      data.setExpanded((current) => {
        const chain = ancestorsOf(path)
        if (alt) {
          const next = new Set(current)
          for (const ancestor of chain) next.add(ancestor)
          next.add(path)
          return next
        }
        return new Set([...chain, path])
      })
      search.clear()
      detail.closeDetail()
      setCursorPath(null)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.setSelectedPath, data.setExpanded, search.clear, detail.closeDetail],
  )

  const menus = useExplorerMenus({
    selection,
    setSelection,
    setCursorPath,
    clipboard,
    cutItems: fileOps.cutItems,
    copyItems: fileOps.copyItems,
    pasteTo: (dir) => void fileOps.pasteTo(dir),
    requestMove: fileOps.requestMove,
    startRename: fileOps.startRename,
    confirmDelete: fileOps.confirmDelete,
    isPinned: data.isPinned,
    togglePin: (path) => void data.togglePin(path),
    openDetailOrEdit,
    toggleDetail,
    selectPath,
  })

  const { drag, onContentMouseDown } = useDragSelect({
    contentRef,
    setSelection,
    setCursorPath,
    closeDetail: detail.closeDetail,
  })

  // ===== Esc 层栈：弹窗/浮层 → 详情 → 搜索 → 选择 → 房 =====

  const consumeEsc = useCallback(() => {
    // 删除确认是 Radix Dialog（不入全局层栈），window capture 阶段的层栈
    // 会抢在 Radix 之前收到 Esc——在这里替它消费，否则会一路关到房间。
    if (fileOps.deleteCandidates) {
      fileOps.dismissDelete()
      return true
    }
    if (menus.contextMenu.open) {
      menus.closeMenu()
      return true
    }
    if (fileOps.moveTarget) {
      fileOps.closeMove()
      return true
    }
    if (fileOps.renamingPath) {
      fileOps.cancelRename()
      return true
    }
    if (detail.detailPath) {
      detail.closeDetail()
      return true
    }
    if (search.query.trim().length > 0) {
      search.clear()
      return true
    }
    if (selection.size > 0) {
      setSelection(new Set())
      setCursorPath(null)
      return true
    }
    return false
  }, [menus, fileOps, search, detail, selection])

  useEffect(() => {
    if (!consumeEscRef) return
    consumeEscRef.current = consumeEsc
    return () => {
      consumeEscRef.current = () => false
    }
  }, [consumeEscRef, consumeEsc])

  const toggleExpanded = (path: string) => {
    data.setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  /** 搜索命中：跳到所在目录并直接开详情（清空搜索，与蓝图一致）。 */
  const openSearchHit = (item: CapabilityAdminItem) => {
    const dir = parentPathOf(item.path)
    if (dir !== selectedPath) selectPath(dir)
    search.clear()
    setSelection(new Set([item.path]))
    setCursorPath(item.path)
    detail.openDetail(item)
  }

  /** 键盘导航/右键菜单作用的对象集：搜索时为平铺命中，否则当前目录。 */
  const activeItems = useMemo(() => {
    if (search.result) {
      return search.result.groups.flatMap((group) => group.items)
    }
    return listing?.items ?? []
  }, [search.result, listing])

  const stageSearch: StageSearch | null =
    search.isSearching && search.result
      ? {
          query: search.query.trim(),
          result: search.result,
          searchedAll: search.searchedAll,
          searchingAll: search.searchingAll,
          onSearchAll: search.searchAllDirs,
          onClear: search.clear,
          onOpenDir: (path) => selectPath(path),
          onOpenItem: openSearchHit,
        }
      : null

  // ===== 键盘层（壳保留）：聚焦、上下移动、Enter 详情、Backspace 回上级 =====

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (menus.contextMenu.open) return
      // Skill 编辑器打开时键盘全归编辑器（此时搜索框已卸载，全局快捷键无意义）。
      if (editingSkill !== null) return

      const target = event.target as HTMLElement
      const isTyping =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable

      // 正在输入时只有 Ctrl/Cmd 系快捷键可抢焦点；裸「/」必须能打进输入框。
      if (
        (!isTyping && event.key === '/') ||
        ((event.ctrlKey || event.metaKey) &&
          ['f', 'k'].includes(event.key.toLowerCase()))
      ) {
        event.preventDefault()
        searchRef.current?.focus()
        return
      }

      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault()
        const item = cursorPath
          ? activeItems.find((i) => i.path === cursorPath)
          : activeItems[0]
        if (item) {
          const el = contentRef.current?.querySelector<HTMLElement>(
            `[data-item="${CSS.escape(item.path)}"]`,
          )
          const rect = el?.getBoundingClientRect()
          const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2
          const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2
          menus.openMenu({ open: true, x, y, target: 'item', path: item.path })
        }
        return
      }

      if (isTyping) return

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const items = activeItems
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
            ? activeItems.find((i) => i.path === cursorPath)
            : activeItems[0]
        if (item) toggleDetail(item)
        return
      }

      if (event.key === 'Backspace') {
        event.preventDefault()
        if (detail.detailPath) {
          detail.closeDetail()
        } else {
          selectPath(parentPathOf(selectedPath))
        }
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorPath, detail.detailPath, activeItems, selectedPath, menus.contextMenu.open, editingSkill])

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
      const items = activeItems
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

  /** 当前目录的一句话说明：来自父目录清单里的目录卡片。 */
  const dirDescription = useMemo(() => {
    if (selectedPath === '/') return null
    void listingsVersion
    const parent = readCapabilityListing(parentPathOf(selectedPath))
    return (
      parent?.directories.find((dir) => dir.path === selectedPath)
        ?.description || null
    )
  }, [selectedPath, listingsVersion])

  /** 删除确认里的名称回退链：当前对象集 → 已缓存清单 → 路径末段。 */
  const nameOf = (path: string): string => {
    const inActive = activeItems.find((i) => i.path === path)
    if (inActive) return inActive.name
    const snap = readCapabilityCenterCache()
    for (const entry of Object.values(snap.listings)) {
      const found = entry.data.items.find((i) => i.path === path)
      if (found) return found.name
    }
    return fileNameOf(path)
  }

  const selectedNode = tree ? findNode(tree, selectedPath) : null
  const detailItem = detail.detailItem
  const moveTarget = fileOps.moveTarget
  // 锚点坐标稳定化：内联对象会让浮层定位 effect 每次渲染都重跑。
  const moveAnchor = useMemo(
    () => (moveTarget ? { x: moveTarget.x, y: moveTarget.y } : null),
    [moveTarget],
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
          onSaved={() => {
            setEditingSkill(null)
            restoreFocus()
            void data.reloadSkills()
            void data.reloadTree()
            void data.reloadListing(selectedPath, true)
          }}
        />
      </div>
    )
  }

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <RoomTopBar
        title="能力"
        onBack={onClose}
        search={
          <div className="relative">
            <Input
              ref={searchRef}
              aria-label="搜索能力"
              containerClassName="min-w-0"
              className="h-9 pr-14"
              leadingIcon={<Search className="h-3.5 w-3.5" />}
              placeholder="找一个能力…"
              title="按 / 或 Ctrl+K 聚焦搜索"
              value={search.query}
              onChange={(event) => search.setQuery(event.target.value)}
            />
            <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded-xs border border-border bg-surface-muted px-1.5 py-0.5 font-mono text-[10px] leading-none text-ink-muted">
              Ctrl K
            </kbd>
          </div>
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              className="press h-9 rounded-md"
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
              className="press h-9 rounded-md"
              data-focus-key="entry-mcp"
              onClick={() => onOpenMcp()}
            >
              <Plug className="h-3.5 w-3.5" />
              MCP 连接
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="press h-9 rounded-md"
              data-focus-key="entry-schedule"
              onClick={onOpenSchedule}
            >
              <Clock3 className="h-3.5 w-3.5" />
              定时任务
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="press h-9 rounded-md"
              data-focus-key="entry-memory"
              onClick={onOpenMemory}
            >
              <Brain className="h-3.5 w-3.5" />
              记忆
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="press h-9 w-9 rounded-md"
              aria-label="全量刷新能力数据"
              disabled={data.refreshing}
              onClick={() => {
                search.resetScope()
                data.refreshAll()
              }}
            >
              <RefreshCw
                className="h-4 w-4 transition-transform duration-fold ease-flow motion-reduce:transition-none"
                style={{ transform: `rotate(${data.rotation}deg)` }}
              />
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
        <RoomSide>
          {tree ? (
            <DirectoryTree
              node={tree}
              depth={0}
              selectedPath={selectedPath}
              expanded={data.expanded}
              pins={pins}
              onToggle={toggleExpanded}
              onSelect={(path, alt) => selectPath(path, alt)}
              onNodeContextMenu={menus.openTreeContextMenu}
              onPinClick={(path) => selectPath(parentPathOf(path))}
              onPinContextMenu={menus.openPinContextMenu}
              onPinReorder={(paths) => void data.reorderPins(paths)}
            />
          ) : treeFailed ? (
            <QuietState
              icon={SearchX}
              title="目录读取失败。"
              hint="点右上角刷新按钮重试。"
            />
          ) : (
            <TreeSkeleton />
          )}
        </RoomSide>

        <RoomStage
          contentRef={contentRef}
          onContentMouseDown={onContentMouseDown}
          overlay={
            <DetailLayer
              item={detailItem}
              state={detailItem ? detail.detailStateOf(detailItem) : undefined}
              skill={detailItem ? skillOf(detailItem) : undefined}
              problems={problems}
              titleOf={treeTitleOf}
              onClose={detail.closeDetail}
              onNavigate={selectPath}
              onEditSkill={(skill) => {
                if (detailItem) captureFocusKey(`skill-edit-${detailItem.path}`)
                setEditingSkill(skill)
              }}
              onToggleSkill={(skill) => {
                if (detailItem) void data.toggleSkillEnabled(detailItem, skill)
              }}
              onOpenMcp={onOpenMcp}
              onMoveTo={(event) => {
                if (!detailItem) return
                const rect = event.currentTarget.getBoundingClientRect()
                fileOps.requestMove(detailItem.path, rect.left, rect.bottom + 6)
              }}
              onDelete={() => {
                if (detailItem) fileOps.confirmDelete([detailItem.path])
              }}
            />
          }
        >
          <StageView
            selectedPath={selectedPath}
            rootTree={tree}
            node={selectedNode}
            listing={listing}
            listingLoading={data.listingLoading}
            description={dirDescription}
            problems={problems}
            search={stageSearch}
            selection={selection}
            clipboard={clipboard}
            renamingPath={fileOps.renamingPath}
            renameDraft={fileOps.renameDraft}
            onRenameDraftChange={fileOps.setRenameDraft}
            onRenameCommit={() => void fileOps.commitRename()}
            onRenameCancel={fileOps.cancelRename}
            onItemClick={handleItemClick}
            onItemContextMenu={menus.openItemContextMenu}
            onSelectPath={selectPath}
            onOpenDirMenu={(event) => menus.openDirMenu(event, selectedPath)}
          />
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
        </RoomStage>
      </div>

      {moveTarget && moveAnchor && tree && (
        <MoveToPopover
          anchor={moveAnchor}
          tree={tree}
          currentDir={parentPathOf(moveTarget.path)}
          onSelect={(dir) => void fileOps.moveItemTo(moveTarget.path, dir)}
          onClose={fileOps.closeMove}
        />
      )}

      <ContextMenu
        open={menus.contextMenu.open}
        x={menus.contextMenu.x}
        y={menus.contextMenu.y}
        items={menus.menuItemsFor(activeItems)}
        onClose={menus.closeMenu}
      />

      <DeleteConfirmModal
        candidates={fileOps.deleteCandidates}
        nameOf={nameOf}
        onDismiss={fileOps.dismissDelete}
        onConfirm={() => void fileOps.doDelete()}
      />
    </div>
  )
}
