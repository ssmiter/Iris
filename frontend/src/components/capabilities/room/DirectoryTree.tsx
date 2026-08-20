import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { CapabilityTreeNode } from '@/api/irisApi'

export function DirectoryTree({
  node,
  depth,
  selectedPath,
  expanded,
  onToggle,
  onSelect,
}: {
  node: CapabilityTreeNode
  depth: number
  selectedPath: string
  expanded: ReadonlySet<string>
  onToggle: (path: string) => void
  onSelect: (path: string, alt: boolean) => void
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
            <DirectoryTree
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
