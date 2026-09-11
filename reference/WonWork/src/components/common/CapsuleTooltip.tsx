import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * 全局胶囊停留显示（2026-08-13，参照 chatgpt停留显示.jpg）。
 * 浏览器原生 title 提示是白底黑边框且不可美化——事件委托统一拦截：
 * hover 时把 title 转存 data-tip（抑制原生弹框），320ms 后渲染 wf 胶囊
 * （capsule 变量：浅色=深胶囊白字 / 暗色=反相浅胶囊，与发送键同一语言）。
 * 零接线：任何元素照常写 title= 即自动接入；mousedown/wheel/blur 立即消失。
 */
export function CapsuleTooltip() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; above: boolean } | null>(null)
  const anchorRef = useRef<HTMLElement | null>(null)
  const timerRef = useRef(0)

  const hide = useCallback(() => {
    window.clearTimeout(timerRef.current)
    anchorRef.current = null
    setTip(null)
  }, [])

  useEffect(() => {
    const SHOW_DELAY = 320
    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest?.('[title],[data-tip]') as HTMLElement | null
      if (el === anchorRef.current) return // 同一锚点内移动不重置
      hide()
      if (!el) return
      // 摘除原生 title 防双提示（文本转存 data-tip，一次到位；
      // React 重渲染会重写 title，下次 mouseover 再摘一次，原生延迟长不会闪现）
      let text = el.getAttribute('data-tip') || ''
      const native = el.getAttribute('title')
      if (native != null) {
        text = native
        el.setAttribute('data-tip', native)
        el.removeAttribute('title')
      }
      if (!text.trim()) return
      anchorRef.current = el
      timerRef.current = window.setTimeout(() => {
        if (anchorRef.current !== el || !el.isConnected) return
        const r = el.getBoundingClientRect()
        const above = r.top > 48 // 顶部空间不足则翻到下方
        setTip({
          text,
          // 水平钳制在视口内（胶囊半宽上限 ~140 + 边距 8）
          x: Math.min(Math.max(r.left + r.width / 2, 148), window.innerWidth - 148),
          y: above ? window.innerHeight - r.top + 8 : r.bottom + 8,
          above,
        })
      }, SHOW_DELAY)
    }
    const onOut = (e: MouseEvent) => {
      const anchor = anchorRef.current
      if (!anchor) return
      // 移到锚点子元素不算离开
      const to = e.relatedTarget as HTMLElement | null
      if (to && anchor.contains(to)) return
      hide()
    }
    document.addEventListener('mouseover', onOver)
    document.addEventListener('mouseout', onOut)
    document.addEventListener('mousedown', hide, true)
    document.addEventListener('wheel', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      window.clearTimeout(timerRef.current)
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mouseout', onOut)
      document.removeEventListener('mousedown', hide, true)
      document.removeEventListener('wheel', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [hide])

  if (!tip) return null
  return createPortal(
    <div
      className="wf-tip"
      style={{ left: tip.x, [tip.above ? 'bottom' : 'top']: tip.y } as React.CSSProperties}
      role="tooltip"
    >
      {tip.text}
    </div>,
    document.body
  )
}
