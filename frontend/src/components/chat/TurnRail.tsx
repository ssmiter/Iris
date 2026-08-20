import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { List } from 'lucide-react'
import type { TurnView } from '@/domain/chat/models'
import { Button } from '@/components/ui'
import { cn } from '@/lib/cn'

interface TurnRailProps {
  turns: TurnView[]
  onScrollToTurn: (turnIndex: number) => void
}

const MIN_TURNS = 8
const LABEL_CHARS = 20
const FAR_JUMP_THRESHOLD_PX = 40
const FAR_JUMP_CORRECT_AFTER = 250
const FAR_JUMP_MAX_WAIT = 500

function firstLine(raw: string): string {
  const line = (raw || '').split('\n')[0].trim()
  const cleaned = line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/`/g, '')
    .replace(/[*_~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
  const chars = Array.from(cleaned)
  const cut = chars.slice(0, LABEL_CHARS)
  return chars.length > LABEL_CHARS ? cut.join('') + '…' : cut.join('')
}

export function TurnRail({ turns, onScrollToTurn }: TurnRailProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const activeRowRef = useRef<HTMLButtonElement>(null)
  const correctTimerRef = useRef<number | null>(null)
  const correctRafRef = useRef<number | null>(null)

  const turnList = useMemo(
    () =>
      turns.map((turn, index) => ({
        index,
        text: firstLine(turn.request.text),
      })),
    [turns],
  )

  // 目录打开时才挂载 IntersectionObserver/MutationObserver；关闭时彻底断开，
  // 避免后台轮次持续刷新时观测器不必要的计算。
  useEffect(() => {
    if (!open) return

    const scroller = document.querySelector<HTMLElement>('.conversation-scroll')
    if (!scroller) return

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => Number((entry.target as HTMLElement).dataset.turnIdx))
          .filter((n) => Number.isFinite(n))
        if (visible.length > 0) {
          setActiveIndex(Math.min(...visible))
        }
      },
      {
        root: scroller,
        rootMargin: '-20% 0px -55% 0px',
        threshold: 0,
      },
    )

    const observeAll = () => {
      scroller
        .querySelectorAll<HTMLElement>('[data-turn-idx]')
        .forEach((el) => observer.observe(el))
    }
    observeAll()

    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        observeAll()
      })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })

    const mo = new MutationObserver(observeAll)
    mo.observe(scroller, { childList: true, subtree: true })

    return () => {
      observer.disconnect()
      mo.disconnect()
      scroller.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [open, turns.length])

  // 目录打开时把当前行滚到可视区中央
  useEffect(() => {
    if (!open) return
    activeRowRef.current?.scrollIntoView({ block: 'center', behavior: 'auto' })
  }, [open])

  // Esc / 点外关闭（触发按钮除外）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null
      if (
        el &&
        (el.closest('[data-turnrail-panel]') ||
          el.closest('[data-turnrail-trigger]'))
      ) {
        return
      }
      setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  // 组件卸载时清掉远跳校正定时器，避免未完成的轮询把状态刷到别的会话。
  useEffect(() => () => {
    if (correctTimerRef.current) {
      window.clearTimeout(correctTimerRef.current)
      correctTimerRef.current = null
    }
    if (correctRafRef.current) {
      cancelAnimationFrame(correctRafRef.current)
      correctRafRef.current = null
    }
  }, [])

  const jumpToTurn = useCallback(
    (index: number) => {
      const scroller = document.querySelector<HTMLElement>('.conversation-scroll')
      const target = scroller?.querySelector<HTMLElement>(`[data-turn-idx="${index}"]`)

      // 近跳：目标已在 DOM，直接沿用现有行为。
      if (target || !scroller) {
        onScrollToTurn(index)
        return
      }

      // 远跳：先让 Virtuoso 滚到插值估算位，等渲染稳定后再对目标 DOM 精校一次。
      onScrollToTurn(index)

      if (correctTimerRef.current) {
        window.clearTimeout(correctTimerRef.current)
        correctTimerRef.current = null
      }
      if (correctRafRef.current) {
        cancelAnimationFrame(correctRafRef.current)
        correctRafRef.current = null
      }

      const startedAt = performance.now()
      const attempt = () => {
        const s = document.querySelector<HTMLElement>('.conversation-scroll')
        const el = s?.querySelector<HTMLElement>(`[data-turn-idx="${index}"]`)
        if (el && s) {
          const scrollerRect = s.getBoundingClientRect()
          const elRect = el.getBoundingClientRect()
          const desired =
            elRect.top - scrollerRect.top + s.scrollTop - 16
          if (Math.abs(s.scrollTop - desired) > FAR_JUMP_THRESHOLD_PX) {
            s.scrollTo({ top: Math.max(0, desired), behavior: 'auto' })
          }
          return
        }
        if (performance.now() - startedAt < FAR_JUMP_MAX_WAIT) {
          correctRafRef.current = requestAnimationFrame(attempt)
        }
      }

      correctTimerRef.current = window.setTimeout(() => {
        correctRafRef.current = requestAnimationFrame(attempt)
      }, FAR_JUMP_CORRECT_AFTER)
    },
    [onScrollToTurn],
  )

  if (turns.length < MIN_TURNS) return null

  return (
    <>
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="icon"
        data-turnrail-trigger
        aria-label="轮次目录"
        aria-expanded={open}
        className={cn(
          'h-8 w-8 transition-colors duration-fast',
          open && 'bg-surface-muted text-ink',
        )}
        onClick={() => setOpen((v) => !v)}
      >
        <List aria-hidden="true" className="h-4 w-4" />
      </Button>

      {open && (
        <div
          ref={panelRef}
          data-turnrail-panel
          role="navigation"
          aria-label="轮次目录"
          className={cn(
            'fixed z-50 w-64 overflow-hidden rounded-md border border-border bg-surface-raised shadow-floating',
            'animate-node-enter motion-reduce:animate-none',
          )}
          style={{
            top: 'calc(var(--topbar-height) + 8px)',
            right: 'var(--page-gutter)',
            maxHeight: 'calc(100dvh - var(--topbar-height) - 24px)',
          }}
        >
          <div className="border-b border-border/75 px-3 py-2 text-small font-medium text-ink">
            轮次目录
          </div>
          <div className="max-h-[min(420px,calc(100dvh-var(--topbar-height)-80px))] overflow-y-auto p-1.5 scrollbar-subtle">
            {turnList.map(({ index, text }) => (
              <button
                key={turns[index].turnId}
                ref={index === activeIndex ? activeRowRef : undefined}
                type="button"
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-small transition-colors duration-fast',
                  index === activeIndex
                    ? 'bg-primary-soft text-primary'
                    : 'text-ink-subtle hover:bg-surface-muted hover:text-ink',
                  'motion-reduce:transition-none',
                )}
                title={text || '…'}
                onClick={() => jumpToTurn(index)}
              >
                <span className="flex h-5 min-w-5 items-center justify-center rounded-xs bg-surface-muted text-caption font-medium text-ink-muted">
                  {index + 1}
                </span>
                <span className="min-w-0 truncate">
                  {text || '…'}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
