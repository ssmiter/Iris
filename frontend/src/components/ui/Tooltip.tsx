import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type FocusEvent as ReactFocusEvent,
  type MutableRefObject,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/cn'

/**
 * Tooltip 黑胶囊（docs/34 第二波干净度收敛）。
 *
 * 设计参数对齐 ChatGPT 停留胶囊的观感：
 * - 深色胶囊底（--color-tooltip）+ 反转文字色，亮暗主题各自"离布一层"；
 * - text-caption（12px/500）、px-2.5 py-1、radius-xs 的紧凑胶囊；
 * - 悬停延迟 ~400ms 出现，单次淡入（duration-fast），退场立即消失；
 * - placement 上/下，空间不足自动翻转，横向压进视口 8px 安全边。
 *
 * 用法：包一个触发元素。不渲染额外包裹节点，事件与 ref 合并到子元素上。
 */
export interface TooltipProps {
  content: ReactNode
  placement?: 'top' | 'bottom'
  /** 悬停出现延迟，默认 400ms；键盘 focus 固定 150ms。 */
  delay?: number
  children: ReactElement
  className?: string
}

type ChildProps = {
  ref?: Ref<HTMLElement>
  onMouseEnter?: (e: ReactMouseEvent) => void
  onMouseLeave?: (e: ReactMouseEvent) => void
  onFocus?: (e: ReactFocusEvent) => void
  onBlur?: (e: ReactFocusEvent) => void
  'aria-describedby'?: string
}

const GAP = 6
const VIEWPORT_PAD = 8

function mergeRefs(...refs: Array<Ref<HTMLElement> | undefined>) {
  return (node: HTMLElement | null) => {
    for (const ref of refs) {
      if (!ref) continue
      if (typeof ref === 'function') ref(node)
      else (ref as MutableRefObject<HTMLElement | null>).current = node
    }
  }
}

export function Tooltip({
  content,
  placement = 'top',
  delay = 400,
  children,
  className,
}: TooltipProps) {
  const id = useId()
  const triggerRef = useRef<HTMLElement | null>(null)
  const tipRef = useRef<HTMLSpanElement | null>(null)
  const timerRef = useRef<number | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [visible, setVisible] = useState(false)
  const [style, setStyle] = useState<{ left: number; top: number } | null>(null)
  const [actualPlacement, setActualPlacement] = useState(placement)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current)
      timerRef.current = undefined
    }
  }, [])

  const hide = useCallback(() => {
    clearTimer()
    setVisible(false)
    setOpen(false)
  }, [clearTimer])

  const show = useCallback(
    (wait: number) => {
      if (!content) return
      clearTimer()
      timerRef.current = window.setTimeout(() => {
        setOpen(true)
        // 首帧先挂载（透明）量尺寸，第二帧定位并淡入，避免跳动。
        requestAnimationFrame(() => {
          const trigger = triggerRef.current
          const tip = tipRef.current
          if (!trigger || !tip) return
          const rect = trigger.getBoundingClientRect()
          const tipRect = tip.getBoundingClientRect()
          let nextPlacement = placement
          if (
            placement === 'top' &&
            rect.top - GAP - tipRect.height < VIEWPORT_PAD
          ) {
            nextPlacement = 'bottom'
          } else if (
            placement === 'bottom' &&
            rect.bottom + GAP + tipRect.height >
              window.innerHeight - VIEWPORT_PAD
          ) {
            nextPlacement = 'top'
          }
          const left = Math.min(
            Math.max(
              rect.left + rect.width / 2 - tipRect.width / 2,
              VIEWPORT_PAD,
            ),
            window.innerWidth - tipRect.width - VIEWPORT_PAD,
          )
          const top =
            nextPlacement === 'top'
              ? rect.top - tipRect.height - GAP
              : rect.bottom + GAP
          setActualPlacement(nextPlacement)
          setStyle({ left, top })
          setVisible(true)
        })
      }, wait)
    },
    [clearTimer, content, placement],
  )

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, hide])

  useEffect(() => clearTimer, [clearTimer])

  if (!isValidElement(children) || !content) return children

  const child = children as ReactElement<ChildProps>
  const childProps = child.props

  const triggerProps: ChildProps = {
    ref: mergeRefs(childProps.ref, (node: HTMLElement | null) => {
      triggerRef.current = node
    }),
    onMouseEnter: (e: ReactMouseEvent) => {
      childProps.onMouseEnter?.(e)
      show(delay)
    },
    onMouseLeave: (e: ReactMouseEvent) => {
      childProps.onMouseLeave?.(e)
      hide()
    },
    onFocus: (e: ReactFocusEvent) => {
      childProps.onFocus?.(e)
      show(150)
    },
    onBlur: (e: ReactFocusEvent) => {
      childProps.onBlur?.(e)
      hide()
    },
    'aria-describedby': open ? id : undefined,
  }
  // ref 不在 cloneElement 的配置类型里，运行时正常，这里显式放宽。
  const trigger = cloneElement(child, triggerProps as Partial<unknown>)

  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <span
            ref={tipRef}
            id={id}
            role="tooltip"
            data-placement={actualPlacement}
            style={style ?? { left: -9999, top: -9999 }}
            className={cn(
              'pointer-events-none fixed z-[60] max-w-64',
              'rounded-xs border border-tooltip-foreground/10 bg-tooltip px-2.5 py-1',
              'text-caption text-tooltip-foreground shadow-raised',
              'transition-opacity duration-fast ease-standard motion-reduce:transition-none',
              visible ? 'opacity-100' : 'opacity-0',
              className,
            )}
          >
            {content}
          </span>,
          document.body,
        )}
    </>
  )
}
