import { useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquare, Search } from 'lucide-react'
import { useConversationStore } from '@/stores/conversationStore'
import { useShellOverlayStore } from '@/stores/shellOverlayStore'
import { pushEscLayer } from '@/lib/escLayerStack'
import { cn } from '@/lib/cn'

/**
 * Ctrl+K 搜索浮层（docs/07 §18.2）：居中偏上、背景轻虚化、全键盘可达。
 * 搜索范围是已加载会话的标题与最近预览——目录检索，不是全文引擎。
 */
export function SearchPalette() {
  const open = useShellOverlayStore((state) => state.searchOpen)
  const setOpen = useShellOverlayStore((state) => state.setSearchOpen)
  const conversationOrder = useConversationStore(
    (state) => state.conversationOrder,
  )
  const conversationsById = useConversationStore(
    (state) => state.conversationsById,
  )
  const setCurrentConversation = useConversationStore(
    (state) => state.setCurrentConversation,
  )
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const results = useMemo(() => {
    const all = conversationOrder
      .map((id) => conversationsById[id])
      .filter((item) => Boolean(item))
    const needle = query.trim().toLowerCase()
    if (!needle) return all
    return all.filter((item) =>
      (item.title + '\n' + (item.lastVisibleText ?? ''))
        .toLowerCase()
        .includes(needle),
    )
  }, [conversationOrder, conversationsById, query])

  // 打开时重置并聚焦；注册 Esc 层（关自己，不波及下层）
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    const frame = window.requestAnimationFrame(() =>
      inputRef.current?.focus(),
    )
    const pop = pushEscLayer({ id: 'search-palette', close: () => setOpen(false) })
    return () => {
      window.cancelAnimationFrame(frame)
      pop()
    }
  }, [open, setOpen])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  // 让高亮项保持可见
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (!open) return null

  const choose = (index: number) => {
    const target = results[index]
    if (!target) return
    setCurrentConversation(target.conversationId, '')
    setOpen(false)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-ink/12 pt-[16vh] backdrop-blur-[3px] animate-overlay-in motion-reduce:animate-none"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false)
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="搜索对话"
        className="flex h-fit max-h-[min(26rem,60vh)] w-[min(34rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-border/70 bg-surface-raised shadow-floating animate-node-enter motion-reduce:animate-none"
      >
        <div className="flex items-center gap-2.5 border-b border-border/60 px-4">
          <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-ink-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex((index) =>
                  Math.min(index + 1, results.length - 1),
                )
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex((index) => Math.max(index - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                choose(activeIndex)
              }
            }}
            placeholder="搜索对话标题或最近内容…"
            aria-label="搜索对话"
            className="h-12 min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-muted"
          />
          <kbd className="shrink-0 rounded-xs border border-border bg-surface-muted px-1.5 py-0.5 text-caption text-ink-muted">
            Esc
          </kbd>
        </div>

        <div
          ref={listRef}
          className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto p-1.5"
        >
          {results.length === 0 ? (
            <p className="px-3 py-8 text-center text-small text-ink-muted">
              没有匹配的对话
            </p>
          ) : (
            results.map((item, index) => (
              <button
                key={item.conversationId}
                type="button"
                data-index={index}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-sm px-3 py-2 text-left',
                  'transition-colors duration-instant motion-reduce:transition-none',
                  index === activeIndex
                    ? 'bg-surface-muted text-ink'
                    : 'text-ink-subtle',
                )}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(index)}
              >
                <MessageSquare
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-ink-muted"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-small font-medium">
                    {item.title}
                  </span>
                  {item.lastVisibleText && (
                    <span className="block truncate text-caption text-ink-muted">
                      {item.lastVisibleText}
                    </span>
                  )}
                </span>
                {(item.pendingAttentionCount ?? 0) > 0 && (
                  <span className="shrink-0 rounded-full bg-warning-soft px-1.5 py-0.5 text-caption text-warning-foreground">
                    {item.pendingAttentionCount} 待决定
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
