import {
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { ChevronRight, GripVertical, Pin } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { CapabilityPin, CapabilityTreeNode } from '@/api/irisApi'

export function DirectoryTree({
  node,
  depth,
  selectedPath,
  expanded,
  pins,
  onToggle,
  onSelect,
  onNodeContextMenu,
  onPinClick,
  onPinContextMenu,
  onPinReorder,
}: {
  node: CapabilityTreeNode
  depth: number
  selectedPath: string
  expanded: ReadonlySet<string>
  pins: CapabilityPin[]
  onToggle: (path: string) => void
  onSelect: (path: string, alt: boolean) => void
  onNodeContextMenu?: (event: ReactMouseEvent, path: string) => void
  onPinClick?: (path: string) => void
  onPinContextMenu?: (event: ReactMouseEvent, path: string) => void
  onPinReorder?: (paths: string[]) => void
}) {
  return (
    <>
      {pins.length > 0 && (
        <PinSection
          pins={pins}
          tree={node}
          selectedPath={selectedPath}
          onPinClick={onPinClick}
          onPinContextMenu={onPinContextMenu}
          onPinReorder={onPinReorder}
        />
      )}
      <ul>
        <TreeNode
          node={node}
          depth={depth}
          selectedPath={selectedPath}
          expanded={expanded}
          onToggle={onToggle}
          onSelect={onSelect}
          onContextMenu={onNodeContextMenu}
        />
      </ul>
    </>
  )
}

function PinSection({
  pins,
  tree,
  selectedPath,
  onPinClick,
  onPinContextMenu,
  onPinReorder,
}: {
  pins: CapabilityPin[]
  tree: CapabilityTreeNode
  selectedPath: string
  onPinClick?: (path: string) => void
  onPinContextMenu?: (event: ReactMouseEvent, path: string) => void
  onPinReorder?: (paths: string[]) => void
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const handleDragStart = (index: number) => (event: ReactDragEvent) => {
    setDragIndex(index)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(index))
  }

  const handleDragOver = (index: number) => (event: ReactDragEvent) => {
    event.preventDefault()
    if (dragIndex === null || dragIndex === index) {
      setDropIndex(null)
      return
    }
    setDropIndex(index)
    event.dataTransfer.dropEffect = 'move'
  }

  const handleDrop = (index: number) => (event: ReactDragEvent) => {
    event.preventDefault()
    const from = dragIndex
    setDragIndex(null)
    setDropIndex(null)
    if (from === null || from === index) return
    const next = pins.map((p) => p.path)
    const [moved] = next.splice(from, 1)
    next.splice(index, 0, moved)
    onPinReorder?.(next)
  }

  const handleDragEnd = () => {
    setDragIndex(null)
    setDropIndex(null)
  }

  return (
    <div className="mb-2">
      <div className="px-2 py-1 text-caption font-medium text-ink-muted">
        收藏
      </div>
      <ul>
        {pins.map((pin, index) => {
          const title = nodeTitle(tree, pin.path)
          const isSelected = selectedPath === pin.path
          const isDropTarget = dropIndex === index
          return (
            <li key={pin.path}>
              <div
                draggable
                onDragStart={handleDragStart(index)}
                onDragOver={handleDragOver(index)}
                onDrop={handleDrop(index)}
                onDragEnd={handleDragEnd}
                className={cn(
                  'flex cursor-grab items-center gap-0.5 rounded-sm text-small transition-colors duration-fast',
                  'active:cursor-grabbing',
                  isSelected
                    ? 'bg-primary-soft font-semibold text-ink'
                    : 'text-ink-subtle hover:bg-surface-muted',
                  isDropTarget && 'bg-primary/10',
                )}
              >
                <span className="grid h-6 w-5 shrink-0 place-items-center text-ink-muted">
                  <Pin className="h-3 w-3" />
                </span>
                <button
                  type="button"
                  aria-current={isSelected ? 'true' : undefined}
                  className="flex min-w-0 flex-1 items-baseline gap-1.5 rounded-xs py-1 pr-1.5 text-left focus-visible:outline-none focus-visible:shadow-focus"
                  onClick={() => onPinClick?.(pin.path)}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    onPinContextMenu?.(event, pin.path)
                  }}
                >
                  <span className="truncate break-keep">{title}</span>
                </button>
                <span className="grid h-6 w-5 shrink-0 place-items-center text-ink-muted/60">
                  <GripVertical className="h-3 w-3" />
                </span>
              </div>
            </li>
          )
        })}
      </ul>
      <div className="mx-2 my-2 h-px bg-border/60" />
    </div>
  )
}

function TreeNode({
  node,
  depth,
  selectedPath,
  expanded,
  onToggle,
  onSelect,
  onContextMenu,
}: {
  node: CapabilityTreeNode
  depth: number
  selectedPath: string
  expanded: ReadonlySet<string>
  onToggle: (path: string) => void
  onSelect: (path: string, alt: boolean) => void
  onContextMenu?: (event: ReactMouseEvent, path: string) => void
}) {
  const hasChildren = node.children.length > 0
  const isExpanded = expanded.has(node.path)
  const isSelected = selectedPath === node.path

  return (
    <li>
      <div
        className={cn(
          'flex items-center gap-0.5 rounded-sm text-small transition-colors duration-fast',
          isSelected
            ? 'bg-primary-soft font-semibold text-ink'
            : 'text-ink-subtle hover:bg-surface-muted',
        )}
        style={{ paddingLeft: `${depth * 0.75}rem` }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={isExpanded ? `收起 ${node.name}` : `展开 ${node.name}`}
            className="grid h-6 w-5 shrink-0 place-items-center rounded-xs text-ink-muted focus-visible:outline-none focus-visible:shadow-focus"
            onClick={() => onToggle(node.path)}
          >
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 transition-transform duration-fast ease-standard motion-reduce:transition-none',
                isExpanded && 'rotate-90',
              )}
            />
          </button>
        ) : (
          <span className="w-5 shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          aria-current={isSelected ? 'true' : undefined}
          className="flex min-w-0 flex-1 items-baseline gap-1.5 rounded-xs py-1 pr-1.5 text-left focus-visible:outline-none focus-visible:shadow-focus"
          onClick={(event) => onSelect(node.path, event.altKey)}
          onContextMenu={(event) => {
            event.preventDefault()
            onContextMenu?.(event, node.path)
          }}
        >
          <span className="truncate break-keep">{node.title || node.name}</span>
          <span className="shrink-0 text-caption font-normal text-ink-muted">
            {node.count}
          </span>
        </button>
      </div>
      {isExpanded && hasChildren && (
        <ul>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

function nodeTitle(root: CapabilityTreeNode, path: string): string {
  const found = findNode(root, path)
  return found ? found.title || found.name : path
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
