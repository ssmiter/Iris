import {
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react'

interface Point {
  x: number
  y: number
}

export interface DragBox {
  start: Point
  current: Point
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

/**
 * 舞台框选（docs/39 §6 从壳拆出）：空白处按下拖出选框，命中 data-item 砖；
 * 点击空白同时关闭详情层（与 Esc / ✕ 等价的第三条退出路径）。
 */
export function useDragSelect({
  contentRef,
  setSelection,
  setCursorPath,
  closeDetail,
}: {
  contentRef: RefObject<HTMLDivElement | null>
  setSelection: (paths: ReadonlySet<string>) => void
  setCursorPath: (path: string | null) => void
  closeDetail: () => void
}) {
  const [drag, setDrag] = useState<DragBox | null>(null)

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
  }, [drag, contentRef, setSelection, setCursorPath])

  const onContentMouseDown = (event: ReactMouseEvent) => {
    if (event.button !== 0) return
    if (event.shiftKey || event.ctrlKey || event.metaKey) return
    const target = event.target as HTMLElement
    if (target.closest('[data-item]')) return
    if (target.closest('button, a, input, [role="menu"]')) return
    const container = contentRef.current
    if (!container) return
    closeDetail()
    const rect = container.getBoundingClientRect()
    const start = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    setDrag({ start, current: start })
    setSelection(new Set())
    setCursorPath(null)
  }

  return { drag, onContentMouseDown }
}
