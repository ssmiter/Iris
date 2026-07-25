import { useRef, useEffect, useState, type ReactNode } from 'react'

interface ClampControllerProps {
  children: ReactNode
  /** 折叠阈值高度（px），默认 152px（≈ 正文 6 行） */
  maxHeight?: number
  /** 包裹容器的 className */
  className?: string
}

/**
 * 长内容软截断控制器。
 *
 * 用 ResizeObserver 监听内容区高度——字体/图片晚加载后仍能正确判断是否需要截断。
 * 超过阈值时加渐隐 mask + "展开全部" 按钮；展开后按钮变为 "收起"。
 * 不再需要 setTimeout + scrollHeight 的猜测式截断。
 */
export function ClampController({ children, maxHeight = 152, className }: ClampControllerProps) {
  const innerRef = useRef<HTMLDivElement>(null)
  const [clampable, setClampable] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const el = innerRef.current
    if (!el) return
    const check = () => setClampable(el.scrollHeight > maxHeight + 8)
    const observer = new ResizeObserver(check)
    observer.observe(el)
    check()
    return () => observer.disconnect()
  }, [maxHeight])

  return (
    <div className={className}>
      <div
        ref={innerRef}
        className={clampable && !expanded ? 'wf-clamp' : 'wf-clamp-off'}
        style={clampable && !expanded ? { maxHeight: `${maxHeight}px` } : undefined}
      >
        {children}
      </div>
      {clampable && (
        <button
          className="wf-more-btn"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '收起 ▴' : '展开全部 ▾'}
        </button>
      )}
    </div>
  )
}
