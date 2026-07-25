/**
 * 选中引用到输入框（v9 §7）
 *
 * 在对话正文（.wf-answer / .ans-body / .wf-prose）中选中文字时，
 * 选区上方浮出「❝ 引用到输入框」小条；点击后把选中文本交给 onQuote，
 * composer 上方出现 violet quote chip，发送时随消息带出。
 *
 * Esc / 滚动 / 点击别处 → 浮条消失。
 */
import { useEffect, useRef, useState } from 'react'

interface QuotePopover {
  text: string
  x: number
  y: number
}

const QUOTABLE_SELECTOR = '.wf-answer, .ans-body, .wf-prose'

export function useSelectionQuote(onQuote: (text: string) => void) {
  const [popover, setPopover] = useState<QuotePopover | null>(null)
  const onQuoteRef = useRef(onQuote)
  onQuoteRef.current = onQuote

  useEffect(() => {
    const handleMouseUp = () => {
      // 等选区稳定
      setTimeout(() => {
        const sel = window.getSelection()
        if (!sel || sel.isCollapsed || !sel.rangeCount) {
          setPopover(null)
          return
        }
        const text = sel.toString().trim()
        if (!text) {
          setPopover(null)
          return
        }
        const anchor = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement
        if (!anchor?.closest(QUOTABLE_SELECTOR)) {
          setPopover(null)
          return
        }
        const rect = sel.getRangeAt(0).getBoundingClientRect()
        setPopover({
          text: text.slice(0, 500),
          x: Math.max(12, Math.min(rect.left + rect.width / 2, window.innerWidth - 90)),
          y: Math.max(8, rect.top - 34),
        })
      }, 10)
    }

    const dismiss = () => setPopover(null)
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss()
    }

    document.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('scroll', dismiss, true)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('scroll', dismiss, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  const popoverEl = popover ? (
    <button
      type="button"
      className="wf-quote-pop"
      style={{ left: popover.x, top: popover.y }}
      onMouseDown={(e) => {
        // 先于 mouseup 的选区清空拿到点击
        e.preventDefault()
        onQuoteRef.current(popover.text)
        setPopover(null)
        window.getSelection()?.removeAllRanges()
      }}
    >
      ❝ 引用到输入框
    </button>
  ) : null

  return popoverEl
}
