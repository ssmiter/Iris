import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'
import type { VirtuosoHandle } from 'react-virtuoso'

type FollowMode = 'following' | 'reviewing'

interface ConversationFollow {
  virtuosoRef: RefObject<VirtuosoHandle>
  setScroller: (element: HTMLElement | Window | null) => void
  followMode: FollowMode
  unseenTurnCount: number
  handleAtBottomChange: (atBottom: boolean) => void
  handleListHeightChange: () => void
  followOutput: (isAtBottom: boolean) => 'auto' | false
  jumpToLatest: () => void
}

/**
 * Owns the conversation viewport contract.
 *
 * Content may grow, but only Virtuoso is allowed to move the viewport.
 * Native reading gestures detach immediately; list measurement and
 * programmatic scrolling never masquerade as user intent.
 */
export function useConversationFollow(itemCount: number): ConversationFollow {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const [scroller, setScrollerElement] = useState<HTMLElement | null>(null)
  const [followMode, setFollowMode] = useState<FollowMode>('following')
  const [unseenTurnCount, setUnseenTurnCount] = useState(0)
  const followModeRef = useRef<FollowMode>('following')
  const atBottomRef = useRef(true)
  const previousItemCountRef = useRef(itemCount)
  const followFrameRef = useRef<number | null>(null)

  const setScroller = useCallback((element: HTMLElement | Window | null) => {
    setScrollerElement(element instanceof HTMLElement ? element : null)
  }, [])

  const reviewHistory = useCallback(() => {
    if (followModeRef.current === 'reviewing') return
    followModeRef.current = 'reviewing'
    setFollowMode('reviewing')
  }, [])

  const resumeFollowing = useCallback(() => {
    followModeRef.current = 'following'
    atBottomRef.current = true
    setFollowMode('following')
    setUnseenTurnCount(0)
  }, [])

  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    atBottomRef.current = atBottom
    if (atBottom) resumeFollowing()
  }, [resumeFollowing])

  const handleListHeightChange = useCallback(() => {
    if (
      followModeRef.current !== 'following'
      || followFrameRef.current !== null
    ) {
      return
    }

    followFrameRef.current = window.requestAnimationFrame(() => {
      followFrameRef.current = null
      if (followModeRef.current === 'following') {
        virtuosoRef.current?.autoscrollToBottom()
      }
    })
  }, [])

  const followOutput = useCallback((isAtBottom: boolean) => (
    followModeRef.current === 'following' && isAtBottom
      ? 'auto'
      : false
  ), [])

  const jumpToLatest = useCallback(() => {
    resumeFollowing()
    virtuosoRef.current?.scrollToIndex({
      index: Math.max(0, itemCount - 1),
      align: 'end',
      behavior: 'auto',
    })
  }, [itemCount, resumeFollowing])

  useEffect(() => {
    const added = itemCount - previousItemCountRef.current
    if (added > 0 && followModeRef.current === 'reviewing') {
      setUnseenTurnCount((count) => count + added)
    }
    previousItemCountRef.current = itemCount
  }, [itemCount])

  useEffect(() => {
    if (!scroller) return

    let touchStartY: number | null = null
    let pointerDown = false
    let pointerStartScrollTop = scroller.scrollTop

    const pointerFinished = () => {
      pointerDown = false
    }
    const onPointerDown = (event: PointerEvent) => {
      pointerDown = true
      pointerStartScrollTop = scroller.scrollTop

      const rect = scroller.getBoundingClientRect()
      const gutter = Math.max(0, scroller.offsetWidth - scroller.clientWidth)
      const inScrollbarGutter =
        gutter > 0
        && (
          event.clientX <= rect.left + gutter + 2
          || event.clientX >= rect.right - gutter - 2
        )

      if (event.button === 1 || inScrollbarGutter) {
        reviewHistory()
      }
    }
    const onScroll = () => {
      if (
        pointerDown
        && Math.abs(scroller.scrollTop - pointerStartScrollTop) > 1
      ) {
        reviewHistory()
      }
    }
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) reviewHistory()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) {
        reviewHistory()
      }
    }
    const onTouchStart = (event: TouchEvent) => {
      touchStartY = event.touches[0]?.clientY ?? null
    }
    const onTouchMove = (event: TouchEvent) => {
      const currentY = event.touches[0]?.clientY
      if (
        touchStartY !== null
        && currentY !== undefined
        && currentY > touchStartY + 8
      ) {
        reviewHistory()
      }
    }

    scroller.addEventListener('pointerdown', onPointerDown)
    scroller.addEventListener('scroll', onScroll, { passive: true })
    scroller.addEventListener('wheel', onWheel, { passive: true })
    scroller.addEventListener('keydown', onKeyDown)
    scroller.addEventListener('touchstart', onTouchStart, { passive: true })
    scroller.addEventListener('touchmove', onTouchMove, { passive: true })
    window.addEventListener('pointerup', pointerFinished)
    window.addEventListener('pointercancel', pointerFinished)

    return () => {
      scroller.removeEventListener('pointerdown', onPointerDown)
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('wheel', onWheel)
      scroller.removeEventListener('keydown', onKeyDown)
      scroller.removeEventListener('touchstart', onTouchStart)
      scroller.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('pointerup', pointerFinished)
      window.removeEventListener('pointercancel', pointerFinished)
    }
  }, [reviewHistory, scroller])

  useEffect(() => () => {
    if (followFrameRef.current !== null) {
      window.cancelAnimationFrame(followFrameRef.current)
    }
  }, [])

  return {
    virtuosoRef,
    setScroller,
    followMode,
    unseenTurnCount,
    handleAtBottomChange,
    handleListHeightChange,
    followOutput,
    jumpToLatest,
  }
}
