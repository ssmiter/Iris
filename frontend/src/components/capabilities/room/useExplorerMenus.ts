import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  ClipboardPaste,
  Copy,
  FolderInput,
  FolderOpen,
  Link,
  Pencil,
  Pin,
  PinOff,
  Scissors,
  TextCursor,
  Trash2,
} from 'lucide-react'
import type { CapabilityAdminItem } from '@/api/irisApi'
import { notify, type ContextMenuSlot } from '@/components/ui'
import {
  isDbTruth,
  isFileTruth,
  isKernelTool,
  parentPathOf,
} from '@/domain/capability/treeUtils'

export interface ExplorerContextMenu {
  open: boolean
  x: number
  y: number
  target: 'item' | 'tree' | 'pin'
  path: string | null
}

const CLOSED: ExplorerContextMenu = {
  open: false,
  x: 0,
  y: 0,
  target: 'item',
  path: null,
}

/**
 * 能力房右键菜单（docs/39 §6 从壳拆出）：菜单状态、分档构建（文件真相 /
 * DB 真相 / 内核）、四类打开入口。文件真相档含「移动到…」，指向树选浮层。
 */
export function useExplorerMenus({
  selection,
  setSelection,
  setCursorPath,
  clipboard,
  cutItems,
  copyItems,
  pasteTo,
  requestMove,
  startRename,
  confirmDelete,
  isPinned,
  togglePin,
  openDetailOrEdit,
  toggleDetail,
  selectPath,
}: {
  selection: ReadonlySet<string>
  setSelection: (paths: ReadonlySet<string>) => void
  setCursorPath: (path: string | null) => void
  clipboard: { mode: 'cut' | 'copy'; paths: string[] } | null
  cutItems: (paths: string[]) => void
  copyItems: (paths: string[]) => void
  pasteTo: (targetDir: string) => void
  requestMove: (path: string, x: number, y: number) => void
  startRename: (path: string, currentName: string) => void
  confirmDelete: (paths: string[]) => void
  isPinned: (path: string) => boolean
  togglePin: (path: string) => void
  openDetailOrEdit: (item: CapabilityAdminItem) => void
  toggleDetail: (item: CapabilityAdminItem) => void
  selectPath: (path: string) => void
}) {
  const [contextMenu, setContextMenu] =
    useState<ExplorerContextMenu>(CLOSED)

  const closeMenu = () =>
    setContextMenu((current) => ({ ...current, open: false }))

  const openMenu = (config: ExplorerContextMenu) => setContextMenu(config)

  const copyText = async (text: string, description?: string) => {
    try {
      await navigator.clipboard.writeText(text)
      notify.success(description ?? '已复制到剪贴板')
    } catch {
      notify.error('复制失败', { description: text })
    }
  }

  const buildPinMenu = (path: string): ContextMenuSlot[] => {
    return [
      {
        key: 'open-location',
        label: '打开所在位置',
        icon: FolderOpen,
        onSelect: () => selectPath(parentPathOf(path)),
      },
      {
        key: 'unpin',
        label: '取消钉选',
        icon: PinOff,
        onSelect: () => togglePin(path),
      },
      { type: 'separator', key: 'sep-1' },
      {
        key: 'copy-path',
        label: '复制路径',
        icon: Link,
        onSelect: () => copyText(path),
      },
    ]
  }

  const buildTreeMenu = (path: string): ContextMenuSlot[] => {
    return [
      {
        key: 'paste',
        label: '粘贴',
        icon: ClipboardPaste,
        disabled: !clipboard,
        onSelect: () => pasteTo(path),
      },
      { type: 'separator', key: 'sep-1' },
      {
        key: 'copy-path',
        label: '复制路径',
        icon: Link,
        onSelect: () => copyText(path),
      },
    ]
  }

  const buildItemMenu = (item: CapabilityAdminItem): ContextMenuSlot[] => {
    const pinned = isPinned(item.path)
    const commonFooter: ContextMenuSlot[] = [
      { type: 'separator', key: 'sep-pin' },
      {
        key: 'pin',
        label: pinned ? '取消钉选' : '钉到收藏',
        icon: pinned ? PinOff : Pin,
        onSelect: () => togglePin(item.path),
      },
    ]

    if (isFileTruth(item)) {
      return [
        {
          key: 'open',
          label: '编辑',
          icon: Pencil,
          onSelect: () => openDetailOrEdit(item),
        },
        {
          key: 'cut',
          label: '剪切',
          icon: Scissors,
          onSelect: () => cutItems([item.path]),
        },
        {
          key: 'move-to',
          label: '移动到…',
          icon: FolderInput,
          onSelect: () => requestMove(item.path, contextMenu.x, contextMenu.y),
        },
        {
          key: 'copy',
          label: '复制',
          icon: Copy,
          onSelect: () => copyItems([item.path]),
        },
        {
          key: 'paste',
          label: '粘贴',
          icon: ClipboardPaste,
          disabled: !clipboard,
          onSelect: () => pasteTo(parentPathOf(item.path)),
        },
        {
          key: 'rename',
          label: '重命名',
          icon: TextCursor,
          onSelect: () => startRename(item.path, item.name),
        },
        { type: 'separator', key: 'sep-1' },
        {
          key: 'delete',
          label: '删除',
          icon: Trash2,
          danger: true,
          onSelect: () => confirmDelete([item.path]),
        },
        {
          key: 'copy-path',
          label: '复制路径',
          icon: Link,
          onSelect: () => copyText(item.path),
        },
        ...commonFooter,
      ]
    }

    if (isDbTruth(item)) {
      return [
        {
          key: 'open',
          label: '编辑',
          icon: Pencil,
          onSelect: () => openDetailOrEdit(item),
        },
        { type: 'separator', key: 'sep-1' },
        {
          key: 'copy-path',
          label: '复制路径',
          icon: Link,
          onSelect: () => copyText(item.path),
        },
        ...commonFooter,
      ]
    }

    if (isKernelTool(item)) {
      return [
        {
          key: 'detail',
          label: '详情',
          onSelect: () => toggleDetail(item),
        },
        {
          key: 'copy-name',
          label: '复制名称',
          icon: Copy,
          onSelect: () => copyText(item.path),
        },
        { type: 'separator', key: 'sep-1' },
        {
          key: 'copy-path',
          label: '复制路径',
          icon: Link,
          onSelect: () => copyText(item.path),
        },
        ...commonFooter,
      ]
    }

    return [
      {
        key: 'copy-path',
        label: '复制路径',
        icon: Link,
        onSelect: () => copyText(item.path),
      },
      ...commonFooter,
    ]
  }

  const buildMultiMenu = (paths: string[]): ContextMenuSlot[] => {
    return [
      {
        key: 'cut',
        label: '剪切',
        icon: Scissors,
        onSelect: () => cutItems(paths),
      },
      { type: 'separator', key: 'sep-1' },
      {
        key: 'delete',
        label: '删除',
        icon: Trash2,
        danger: true,
        onSelect: () => confirmDelete(paths),
      },
    ]
  }

  const openItemContextMenu = (
    event: ReactMouseEvent,
    item: CapabilityAdminItem,
  ) => {
    event.preventDefault()
    if (selection.size > 1 && !selection.has(item.path)) {
      setSelection(new Set([item.path]))
      setCursorPath(item.path)
    }
    openMenu({
      open: true,
      x: event.clientX,
      y: event.clientY,
      target: 'item',
      path: item.path,
    })
  }

  const openTreeContextMenu = (event: ReactMouseEvent, path: string) => {
    event.preventDefault()
    openMenu({
      open: true,
      x: event.clientX,
      y: event.clientY,
      target: 'tree',
      path,
    })
  }

  const openPinContextMenu = (event: ReactMouseEvent, path: string) => {
    event.preventDefault()
    openMenu({
      open: true,
      x: event.clientX,
      y: event.clientY,
      target: 'pin',
      path,
    })
  }

  /** 目录头的「目录操作」按钮：与树右键同等项（docs/39 §2）。 */
  const openDirMenu = (event: ReactMouseEvent, path: string) => {
    const rect = event.currentTarget.getBoundingClientRect()
    openMenu({
      open: true,
      x: rect.left,
      y: rect.bottom + 4,
      target: 'tree',
      path,
    })
  }

  /** 当前打开菜单应渲染的条目；未打开或找不到对象时为空数组。 */
  const menuItemsFor = (
    activeItems: CapabilityAdminItem[],
  ): ContextMenuSlot[] => {
    if (!contextMenu.open) return []
    if (contextMenu.target === 'tree' && contextMenu.path) {
      return buildTreeMenu(contextMenu.path)
    }
    if (contextMenu.target === 'pin' && contextMenu.path) {
      return buildPinMenu(contextMenu.path)
    }
    if (
      selection.size > 1 &&
      contextMenu.path &&
      selection.has(contextMenu.path)
    ) {
      return buildMultiMenu([...selection])
    }
    const item = activeItems.find((i) => i.path === contextMenu.path)
    return item ? buildItemMenu(item) : []
  }

  return {
    contextMenu,
    closeMenu,
    openMenu,
    openItemContextMenu,
    openTreeContextMenu,
    openPinContextMenu,
    openDirMenu,
    menuItemsFor,
  }
}
