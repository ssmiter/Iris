import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Folder } from 'lucide-react'
import type { CapabilityTreeNode } from '@/api/irisApi'
import { cn } from '@/lib/cn'

const VIEWPORT_PAD = 8

/**
 * 「移动到…」树选浮层（docs/39 §4）：列出目录树，当前所在目录标注不可点。
 * 合法落点由后端铁律校验（out_of_extension_root 错误有专人话 toast）——
 * 前端不预过滤，避免在 UI 里复刻一套根目录映射规则。
 */
export function MoveToPopover({
  anchor,
  tree,
  currentDir,
  onSelect,
  onClose,
}: {
  /** 视口坐标（详情层按钮或右键菜单位置）。 */
  anchor: { x: number; y: number }
  tree: CapabilityTreeNode
  currentDir: string
  onSelect: (dirPath: string) => void
  onClose: () => void
}) {
  const popRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(
    null,
  )
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const tick = requestAnimationFrame(() => {
      const pop = popRef.current
      if (!pop) return
      const rect = pop.getBoundingClientRect()
      const left = Math.min(
        Math.max(anchor.x, VIEWPORT_PAD),
        Math.max(VIEWPORT_PAD, window.innerWidth - rect.width - VIEWPORT_PAD),
      )
      const top = Math.min(
        Math.max(anchor.y, VIEWPORT_PAD),
        Math.max(VIEWPORT_PAD, window.innerHeight - rect.height - VIEWPORT_PAD),
      )
      setPosition({ left, top })
      requestAnimationFrame(() => setVisible(true))
    })
    return () => cancelAnimationFrame(tick)
  }, [anchor])

  useEffect(() => {
    const handleDown = (event: MouseEvent) => {
      if (!popRef.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handleDown)
    return () => document.removeEventListener('mousedown', handleDown)
  }, [onClose])

  const rows: Array<{ path: string; title: string; depth: number }> = []
  const walk = (node: CapabilityTreeNode, depth: number) => {
    if (node.path !== '/') {
      rows.push({
        path: node.path,
        title: node.title || node.name,
        depth: Math.min(depth, 3),
      })
    }
    for (const child of node.children) walk(child, depth + 1)
  }
  walk(tree, 0)

  return createPortal(
    <div
      ref={popRef}
      role="menu"
      aria-label="移动到目录"
      style={position ?? { left: -9999, top: -9999 }}
      className={cn(
        'fixed z-[80] w-64 overflow-hidden rounded-lg border border-border bg-surface-raised p-1.5 shadow-floating',
        'transition-[opacity,transform] duration-fast ease-enter motion-reduce:transition-none',
        visible ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
      )}
    >
      <p className="px-2.5 pb-1 pt-1.5 text-caption font-semibold text-ink-muted">
        移动到
      </p>
      <div className="scrollbar-subtle max-h-72 overflow-y-auto">
        {rows.map((row) => {
          const here = row.path === currentDir
          return (
            <button
              key={row.path}
              type="button"
              role="menuitem"
              disabled={here}
              aria-current={here ? 'location' : undefined}
              onClick={() => onSelect(row.path)}
              className={cn(
                'press flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-small',
                'transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focus',
                here
                  ? 'cursor-default text-ink-muted opacity-60'
                  : 'text-ink-subtle hover:bg-surface-muted hover:text-ink',
              )}
              style={{ paddingLeft: `${0.625 + row.depth * 0.875}rem` }}
            >
              <Folder className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
              <span className="min-w-0 flex-1 truncate">{row.title}</span>
              {here && (
                <span className="shrink-0 text-caption text-ink-muted">
                  现在在这
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}
