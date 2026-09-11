/**
 * 选中浮条（v9 §7 + 记忆之野 2026-07-31）
 *
 * 在对话正文（.wf-answer / .ans-body / .wf-prose）中选中文字时，
 * 选区上方浮出小条：❝ 引用到输入框 ｜ ✦ 收入记忆。
 *
 * 防呆：划词是阅读习惯——选中本身**零副作用**（不发请求、不改状态），
 * 只有显式点击按钮才触发后续动作；收入记忆的 LLM 誊写 pipeline
 * 另有 30s 同文短路兜底（pipelines/memoryRemember）。
 *
 * Esc / 滚动 / 点击别处 → 浮条消失。
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface QuotePopover {
  text: string
  x: number
  y: number
}

const QUOTABLE_SELECTOR = '.wf-answer, .ans-body, .wf-prose'

export function useSelectionQuote(
  onQuote: (text: string) => void,
  onRemember?: (text: string) => void
) {
  const [popover, setPopover] = useState<QuotePopover | null>(null)
  const { t } = useTranslation()
  const onQuoteRef = useRef(onQuote)
  onQuoteRef.current = onQuote
  const onRememberRef = useRef(onRemember)
  onRememberRef.current = onRemember

  useEffect(() => {
    const handleMouseUp = (e: MouseEvent) => {
      // 右键划词留给浏览器原生菜单（2026-07-31 用户报右键菜单与浮条齐弹）
      if (e.button !== 0) return
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
    document.addEventListener('contextmenu', dismiss)
    return () => {
      document.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('scroll', dismiss, true)
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('contextmenu', dismiss)
    }
  }, [])

  const popoverEl = popover ? (
    <div className="wf-quote-pop" style={{ left: popover.x, top: popover.y }}>
      <button
        type="button"
        className="wf-quote-pop-btn"
        onMouseDown={(e) => {
          // 先于 mouseup 的选区清空拿到点击
          e.preventDefault()
          onQuoteRef.current(popover.text)
          setPopover(null)
          window.getSelection()?.removeAllRanges()
        }}
      >
        ❝ {t('chat.quote')}
      </button>
      {onRememberRef.current && (
        <button
          type="button"
          className="wf-quote-pop-btn wf-quote-pop-mem"
          onMouseDown={(e) => {
            e.preventDefault()
            onRememberRef.current?.(popover.text)
            setPopover(null)
            window.getSelection()?.removeAllRanges()
          }}
        >
          ✦ {t('memory.selbar.remember')}
        </button>
      )}
    </div>
  ) : null

  return popoverEl
}
