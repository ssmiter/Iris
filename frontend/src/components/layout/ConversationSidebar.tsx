import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  Archive,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Settings,
  X,
} from 'lucide-react'
import {
  getConversationView,
  IrisApiError,
  renameConversation,
  setConversationArchived,
} from '@/api/irisApi'
import {
  useConversationStore,
  type ConversationSummary,
} from '@/stores/conversationStore'
import { useViewStateStore } from '@/stores/viewStateStore'
import { useShellOverlayStore } from '@/stores/shellOverlayStore'
import { useChatStore } from '@/stores/chatStore'
import { Button, notify } from '@/components/ui'
import { pushEscLayer } from '@/lib/escLayerStack'
import { cn } from '@/lib/cn'

/**
 * 侧栏会话管理（docs/07 §18.1）：目录，不是第二个工作区。
 * 选中 accent 左条、滚动渐变、行内重命名、右键菜单（重命名/归档）、
 * 底部设置入口；折叠时退化为窄 rail。
 */

interface MenuState {
  conversationId: string
  x: number
  y: number
}

function SidebarContent({ mobile = false }: { mobile?: boolean }) {
  const conversationOrder = useConversationStore(
    (state) => state.conversationOrder,
  )
  const conversationsById = useConversationStore(
    (state) => state.conversationsById,
  )
  const currentConversationId = useConversationStore(
    (state) => state.currentConversationId,
  )
  const setCurrentConversation = useConversationStore(
    (state) => state.setCurrentConversation,
  )
  const startNewConversation = useConversationStore(
    (state) => state.startNewConversation,
  )
  const resetConversation = useChatStore(
    (state) => state.resetConversation,
  )
  const setMobileSidebarOpen = useViewStateStore(
    (state) => state.setMobileSidebarOpen,
  )
  const setSettingsOpen = useShellOverlayStore(
    (state) => state.setSettingsOpen,
  )
  const setSearchOpen = useShellOverlayStore((state) => state.setSearchOpen)

  const [menu, setMenu] = useState<MenuState | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const listRef = useRef<HTMLElement>(null)
  const [scrollEdges, setScrollEdges] = useState({ up: false, down: false })

  // 列表上下渐变：仅在对应方向还有内容时出现
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const update = () =>
      setScrollEdges({
        up: list.scrollTop > 4,
        down: list.scrollTop + list.clientHeight < list.scrollHeight - 4,
      })
    update()
    list.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(list)
    return () => {
      list.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [])

  const newConversation = () => {
    startNewConversation()
    resetConversation()
    if (mobile) setMobileSidebarOpen(false)
  }

  const selectConversation = (conversationId: string) => {
    setCurrentConversation(conversationId, '')
    if (mobile) setMobileSidebarOpen(false)
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-[var(--topbar-height)] shrink-0 items-center justify-between gap-1 px-3">
        <span className="text-small font-semibold text-ink">对话</span>
        <span className="flex items-center">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="搜索对话（Ctrl+K）"
            title="搜索对话 · Ctrl+K"
            onClick={() => {
              setSearchOpen(true)
              if (mobile) setMobileSidebarOpen(false)
            }}
          >
            <Search aria-hidden="true" className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="新建对话"
            onClick={newConversation}
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
          </Button>
          {mobile && (
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <X aria-hidden="true" className="h-4 w-4" />
                <span className="sr-only">关闭对话列表</span>
              </Button>
            </Dialog.Close>
          )}
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
        <nav
          ref={listRef}
          aria-label="对话列表"
          className="scrollbar-subtle h-full space-y-0.5 overflow-y-auto px-2 py-1"
        >
          {conversationOrder.length === 0 && (
            <p className="px-3 py-6 text-center text-caption text-ink-muted">
              还没有对话，从下方输入框开始
            </p>
          )}
          {conversationOrder.map((conversationId) => {
            const conversation = conversationsById[conversationId]
            if (!conversation) return null
            return (
              <ConversationItem
                key={conversationId}
                conversation={conversation}
                active={conversationId === currentConversationId}
                editing={editingId === conversationId}
                onSelect={() => selectConversation(conversationId)}
                onMenu={(x, y) =>
                  setMenu({ conversationId, x, y })
                }
                onStartRename={() => setEditingId(conversationId)}
                onFinishRename={() => setEditingId(null)}
              />
            )
          })}
        </nav>
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 h-5 bg-gradient-to-b from-surface to-transparent transition-opacity duration-fast',
            scrollEdges.up ? 'opacity-100' : 'opacity-0',
          )}
        />
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-surface to-transparent transition-opacity duration-fast',
            scrollEdges.down ? 'opacity-100' : 'opacity-0',
          )}
        />
      </div>

      <div className="shrink-0 p-2">
        <button
          type="button"
          className={cn(
            'flex w-full items-center gap-2.5 rounded-sm px-3 py-2 text-left text-small text-ink-subtle',
            'transition-colors duration-fast hover:bg-surface-muted hover:text-ink',
            'focus-visible:outline-none focus-visible:shadow-focus motion-reduce:transition-none',
          )}
          onClick={() => {
            setSettingsOpen(true)
            if (mobile) setMobileSidebarOpen(false)
          }}
        >
          <Settings aria-hidden="true" className="h-4 w-4 shrink-0 text-ink-muted" />
          <span className="min-w-0 flex-1">
            <span className="block font-medium">设置</span>
            <span className="block truncate text-caption text-ink-muted">
              主题、动效与默认权限
            </span>
          </span>
        </button>
        <p className="px-3 pb-1 pt-2 text-caption text-ink-muted">
          本地工作集 · 历史不会因归档而删除
        </p>
      </div>

      {menu && (
        <ConversationMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onRename={() => {
            setEditingId(menu.conversationId)
            setMenu(null)
          }}
        />
      )}
    </div>
  )
}

function ConversationItem({
  conversation,
  active,
  editing,
  onSelect,
  onMenu,
  onStartRename,
  onFinishRename,
}: {
  conversation: ConversationSummary
  active: boolean
  editing: boolean
  onSelect: () => void
  onMenu: (x: number, y: number) => void
  onStartRename: () => void
  onFinishRename: () => void
}) {
  const upsertConversation = useConversationStore(
    (state) => state.upsertConversation,
  )
  const [saving, setSaving] = useState(false)

  const commitRename = async (value: string) => {
    const title = value.trim()
    onFinishRename()
    if (!title || title === conversation.title) return
    const previous = conversation
    // 乐观更新；冲突/失败时回滚并提示
    upsertConversation({ ...conversation, title })
    setSaving(true)
    try {
      const version =
        conversation.version ??
        (await getConversationView(conversation.conversationId)).version
      const result = await renameConversation(
        conversation.conversationId,
        title,
        version,
      )
      upsertConversation({
        ...conversation,
        title: result.title,
        version: result.version,
        updatedAt: result.updatedAt,
      })
    } catch (error) {
      upsertConversation(previous)
      notify.error(
        error instanceof IrisApiError && error.status === 409
          ? '对话已有更新，重命名未生效'
          : '重命名失败',
        { description: (error as Error).message },
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="group relative">
      {/* accent 左条：选中事实的标记，scaleY 生长只播一次 */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary',
          'origin-center transition-transform duration-deliberate ease-flow motion-reduce:transition-none',
          active ? 'scale-y-100' : 'scale-y-0',
        )}
      />
      {editing ? (
        <input
          key={conversation.conversationId}
          defaultValue={conversation.title}
          autoFocus
          disabled={saving}
          aria-label="重命名对话"
          onFocus={(event) => event.target.select()}
          onBlur={(event) => void commitRename(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.blur()
            } else if (event.key === 'Escape') {
              event.stopPropagation()
              onFinishRename()
            }
          }}
          className="min-h-9 w-full rounded-sm border border-primary/40 bg-surface-raised px-3 py-1.5 text-small font-medium text-ink outline-none shadow-focus"
        />
      ) : (
        <button
          type="button"
          className={cn(
            'flex min-h-9 w-full items-start gap-2.5 rounded-sm py-2 pl-3.5 pr-2 text-left',
            'transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focus',
            active
              ? 'bg-surface-muted text-ink'
              : 'text-ink-subtle hover:bg-surface-muted hover:text-ink',
            'motion-reduce:transition-none',
          )}
          aria-current={active ? 'page' : undefined}
          onClick={onSelect}
          onDoubleClick={onStartRename}
          onContextMenu={(event) => {
            event.preventDefault()
            onMenu(event.clientX, event.clientY)
          }}
        >
          <MessageSquare
            aria-hidden="true"
            className={cn(
              'mt-0.5 h-4 w-4 shrink-0',
              active ? 'text-primary' : 'text-ink-muted',
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-small font-medium">
              {conversation.title}
            </span>
            <span className="mt-0.5 block truncate text-caption text-ink-muted">
              {conversation.activeTurnCount > 0
                ? `${conversation.activeTurnCount} 个任务进行中`
                : conversation.lastVisibleText || '最近更新'}
            </span>
          </span>
          {(conversation.pendingAttentionCount ?? 0) > 0 && (
            <span className="mt-0.5 shrink-0 rounded-full bg-warning-soft px-1.5 py-0.5 text-caption text-warning-foreground">
              {conversation.pendingAttentionCount} 项待决定
            </span>
          )}
        </button>
      )}
    </div>
  )
}

/** 右键菜单：固定定位、点外关闭、Esc 关闭（入层栈）。 */
function ConversationMenu({
  menu,
  onClose,
  onRename,
}: {
  menu: MenuState
  onClose: () => void
  onRename: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const conversation = useConversationStore(
    (state) => state.conversationsById[menu.conversationId],
  )
  const removeConversation = useConversationStore(
    (state) => state.removeConversation,
  )
  const [archiving, setArchiving] = useState(false)

  useEffect(() => {
    const pop = pushEscLayer({ id: 'conversation-menu', close: onClose })
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      pop()
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [onClose])

  if (!conversation) return null

  const archive = async () => {
    if (archiving) return
    setArchiving(true)
    try {
      const version =
        conversation.version ??
        (await getConversationView(conversation.conversationId)).version
      await setConversationArchived(conversation.conversationId, true, version)
      removeConversation(conversation.conversationId)
      notify.info('对话已归档', {
        description: '只是从列表收起，完整历史仍保留在本地。',
      })
    } catch (error) {
      notify.error('归档失败', { description: (error as Error).message })
    } finally {
      setArchiving(false)
      onClose()
    }
  }

  const itemClass = cn(
    'flex w-full items-center gap-2 rounded-xs px-2.5 py-1.5 text-left text-small text-ink',
    'transition-colors duration-instant hover:bg-surface-muted',
    'focus-visible:outline-none focus-visible:bg-surface-muted motion-reduce:transition-none',
    'disabled:pointer-events-none disabled:opacity-45',
  )

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="对话操作"
      className="fixed z-50 w-40 rounded-md border border-border/70 bg-surface-raised p-1 shadow-floating animate-node-enter motion-reduce:animate-none"
      style={{
        left: Math.min(menu.x, window.innerWidth - 176),
        top: Math.min(menu.y, window.innerHeight - 120),
      }}
    >
      <button type="button" role="menuitem" className={itemClass} onClick={onRename}>
        <Pencil aria-hidden="true" className="h-3.5 w-3.5 text-ink-muted" />
        重命名
      </button>
      <button
        type="button"
        role="menuitem"
        className={itemClass}
        disabled={archiving}
        onClick={() => void archive()}
      >
        <Archive aria-hidden="true" className="h-3.5 w-3.5 text-ink-muted" />
        {archiving ? '正在归档…' : '归档'}
      </button>
    </div>
  )
}

/** 折叠态窄 rail：新建 / 搜索 / 设置，标题属于展开态。 */
function ConversationRail() {
  const setSidebarOpen = useViewStateStore((state) => state.setSidebarOpen)
  const startNewConversation = useConversationStore(
    (state) => state.startNewConversation,
  )
  const resetConversation = useChatStore(
    (state) => state.resetConversation,
  )
  const setSearchOpen = useShellOverlayStore((state) => state.setSearchOpen)
  const setSettingsOpen = useShellOverlayStore(
    (state) => state.setSettingsOpen,
  )

  const iconClass = 'h-9 w-9'

  return (
    <aside className="hidden h-full w-12 shrink-0 flex-col items-center bg-surface py-2 md:flex">
      <Button
        variant="ghost"
        size="icon"
        className={iconClass}
        aria-label="展开对话列表"
        onClick={() => setSidebarOpen(true)}
      >
        <MessageSquare aria-hidden="true" className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={iconClass}
        aria-label="新建对话"
        onClick={() => {
          startNewConversation()
          resetConversation()
        }}
      >
        <Plus aria-hidden="true" className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={iconClass}
        aria-label="搜索对话（Ctrl+K）"
        onClick={() => setSearchOpen(true)}
      >
        <Search aria-hidden="true" className="h-4 w-4" />
      </Button>
      <span className="flex-1" />
      <Button
        variant="ghost"
        size="icon"
        className={iconClass}
        aria-label="设置"
        onClick={() => setSettingsOpen(true)}
      >
        <Settings aria-hidden="true" className="h-4 w-4" />
      </Button>
    </aside>
  )
}

export function DesktopConversationSidebar() {
  const sidebarOpen = useViewStateStore((state) => state.sidebarOpen)
  if (!sidebarOpen) return <ConversationRail />

  return (
    <aside className="hidden h-full w-[var(--sidebar-width)] shrink-0 md:block">
      <SidebarContent />
    </aside>
  )
}

export function MobileConversationSidebar() {
  const open = useViewStateStore((state) => state.mobileSidebarOpen)
  const setOpen = useViewStateStore((state) => state.setMobileSidebarOpen)

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/20 backdrop-blur-[2px] data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out motion-reduce:animate-none md:hidden" />
        <Dialog.Content className="fixed inset-y-0 left-0 z-50 w-[min(86vw,20rem)] bg-surface shadow-floating transition-transform duration-deliberate ease-standard data-[state=closed]:-translate-x-full data-[state=open]:translate-x-0 motion-reduce:transition-none md:hidden">
          <Dialog.Title className="sr-only">对话列表</Dialog.Title>
          <SidebarContent mobile />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
