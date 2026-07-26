import * as Dialog from '@radix-ui/react-dialog'
import { MessageSquare, Plus, X } from 'lucide-react'
import { useConversationStore } from '@/stores/conversationStore'
import { useViewStateStore } from '@/stores/viewStateStore'
import { useChatStore } from '@/stores/chatStore'
import { Button } from '@/components/ui'
import { cn } from '@/lib/cn'

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

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-[var(--topbar-height)] items-center justify-between px-3">
        <span className="text-small font-semibold text-ink">对话</span>
        {mobile ? (
          <Dialog.Close asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <X aria-hidden="true" className="h-4 w-4" />
              <span className="sr-only">关闭对话列表</span>
            </Button>
          </Dialog.Close>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="新建对话"
            onClick={() => {
              startNewConversation()
              resetConversation()
            }}
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
          </Button>
        )}
      </div>

      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2 subtle-scrollbar">
        {conversationOrder.map((conversationId) => {
          const conversation = conversationsById[conversationId]
          if (!conversation) return null
          const active = conversationId === currentConversationId
          return (
            <button
              key={conversationId}
              type="button"
              className={cn(
                'flex w-full items-start gap-2.5 rounded-sm px-3 py-2.5 text-left',
                'transition-colors duration-fast focus-visible:outline-none focus-visible:shadow-focus',
                active
                  ? 'bg-surface-muted text-ink'
                  : 'text-ink-subtle hover:bg-surface-muted hover:text-ink',
                'motion-reduce:transition-none',
              )}
              aria-current={active ? 'page' : undefined}
              onClick={() => {
                setCurrentConversation(conversationId, '')
                if (mobile) setMobileSidebarOpen(false)
              }}
            >
              <MessageSquare
                aria-hidden="true"
                className={cn(
                  'mt-0.5 h-4 w-4 shrink-0',
                  active ? 'text-primary' : 'text-ink-muted',
                )}
              />
              <span className="min-w-0">
                <span className="block truncate text-small font-medium">
                  {conversation.title}
                </span>
                <span className="mt-0.5 block text-caption text-ink-muted">
                  {conversation.activeTurnCount > 0
                    ? `${conversation.activeTurnCount} 个任务进行中`
                    : '最近更新'}
                </span>
              </span>
            </button>
          )
        })}
      </nav>

      <div className="px-4 py-3 text-caption text-ink-muted">
        本地工作集 · 历史不会因收起而删除
      </div>
    </div>
  )
}

export function DesktopConversationSidebar() {
  const sidebarOpen = useViewStateStore((state) => state.sidebarOpen)
  if (!sidebarOpen) return null

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
