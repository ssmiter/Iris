import { useEffect, useRef, useState } from 'react'
import { Quote } from 'lucide-react'

interface QuotePopoverState {
  text: string
  x: number
  y: number
}

const QUOTABLE_SELECTOR = '.answer-prose'

/**
 * 在助手答案正文（.answer-prose）中选中文字时，在选区上方浮出引用按钮。
 *
 * 划词本身零副作用；只有点击按钮才会把选中文本作为引用 chip 传出。
 * Esc / 滚动 / 右键菜单 / 选区清空时浮条消失。
 */
export function useAnswerQuote(onQuote: (text: string) => void) {
  const [popover, setPopover] = useState<QuotePopoverState | null>(null)
  const onQuoteRef = useRef(onQuote)
  onQuoteRef.current = onQuote

  useEffect(() => {
    const handleMouseUp = (event: MouseEvent) => {
      // 右键划词保留浏览器原生菜单，不弹浮条
      if (event.button !== 0) return

      setTimeout(() => {
        const selection = window.getSelection()
        if (!selection || selection.isCollapsed || !selection.rangeCount) {
          setPopover(null)
          return
        }

        const text = selection.toString().trim()
        if (!text) {
          setPopover(null)
          return
        }

        const anchor =
          selection.anchorNode instanceof Element
            ? selection.anchorNode
            : selection.anchorNode?.parentElement
        const focus =
          selection.focusNode instanceof Element
            ? selection.focusNode
            : selection.focusNode?.parentElement
        const anchorProse = anchor?.closest(QUOTABLE_SELECTOR)
        const focusProse = focus?.closest(QUOTABLE_SELECTOR)
        if (!anchorProse || anchorProse !== focusProse) {
          setPopover(null)
          return
        }

        const rect = selection.getRangeAt(0).getBoundingClientRect()
        setPopover({
          text: text.slice(0, 500),
          x: Math.max(
            28,
            Math.min(
              rect.left + rect.width / 2,
              window.innerWidth - 28,
            ),
          ),
          y: Math.max(8, rect.top - 38),
        })
      }, 10)
    }

    const dismiss = () => setPopover(null)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss()
    }

    document.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('scroll', dismiss, true)
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('contextmenu', dismiss)
    return () => {
      document.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('scroll', dismiss, true)
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('contextmenu', dismiss)
    }
  }, [])

  const popoverEl = popover ? (
    <div
      className="pointer-events-auto fixed z-50"
      style={{
        left: popover.x,
        top: popover.y,
        transform: 'translateX(-50%)',
      }}
    >
      <div className="animate-node-enter motion-reduce:animate-none">
        <div className="flex items-center gap-0.5 rounded-lg border border-border/70 bg-surface-raised px-1 py-1 shadow-floating">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-caption text-ink hover:bg-surface-muted"
            onMouseDown={(event) => {
              // 先于 mouseup 清空选区前拿到点击，避免按钮触发表单失焦
              event.preventDefault()
              onQuoteRef.current(popover.text)
              window.getSelection()?.removeAllRanges()
              setPopover(null)
            }}
          >
            <Quote aria-hidden="true" className="h-3 w-3" />
            引用
          </button>
        </div>
      </div>
    </div>
  ) : null

  return popoverEl
}
