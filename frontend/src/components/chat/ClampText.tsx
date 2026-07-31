import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

const CLAMP_PX = 168

/**
 * 长内容软截断（WonWork ClampController 的克制版）。
 * 内容超过阈值时折叠到底部渐隐，并给"展开全部"出口；
 * 短内容零开销零 UI。展开/收起是用户主动动作，瞬时切换不做高度动画。
 */
export function ClampText({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [needsClamp, setNeedsClamp] = useState(false)
  const [open, setOpen] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    // +24 余量：只超出一两行时不截断，避免"为了藏一行多一个按钮"
    if (el && el.scrollHeight > CLAMP_PX + 24) setNeedsClamp(true)
  }, [children])

  const collapsed = needsClamp && !open

  return (
    <div>
      <div
        ref={ref}
        className={cn(
          collapsed &&
            'overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]',
        )}
        style={collapsed ? { maxHeight: CLAMP_PX } : undefined}
      >
        {children}
      </div>
      {needsClamp && (
        <button
          type="button"
          className="mt-1 text-caption text-primary transition-colors duration-fast hover:text-primary-hover motion-reduce:transition-none"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? '收起' : '展开全部'}
        </button>
      )}
    </div>
  )
}
