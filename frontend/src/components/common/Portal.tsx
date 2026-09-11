import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface PortalProps {
  children: ReactNode
}

/**
 * Portal 组件：将子元素渲染到 document.body，脱离当前 stacking context。
 * 用于下拉菜单、tooltip 等需要浮于所有面板之上的元素。
 */
export function Portal({ children }: PortalProps) {
  const elRef = useRef<HTMLDivElement | null>(null)

  if (!elRef.current) {
    elRef.current = document.createElement('div')
  }

  useEffect(() => {
    const el = elRef.current!
    document.body.appendChild(el)
    return () => {
      document.body.removeChild(el)
    }
  }, [])

  return createPortal(children, elRef.current)
}
