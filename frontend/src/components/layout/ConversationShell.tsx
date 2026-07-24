import { useEffect, type ReactNode } from 'react'
import { Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Button } from '@/components/ui'
import { useConversationStore } from '@/stores/conversationStore'
import { useViewStateStore } from '@/stores/viewStateStore'
import { applyTheme } from '@/theme/theme'
import {
  DesktopConversationSidebar,
  MobileConversationSidebar,
} from './ConversationSidebar'

interface ConversationShellProps {
  badge?: ReactNode
  headerActions?: ReactNode
  children: ReactNode
  composer: ReactNode
}

function BrandMark() {
  return (
    <span
      aria-hidden="true"
      className="brand-spectrum grid h-7 w-7 shrink-0 place-items-center rounded-full p-[3px] shadow-hairline"
    >
      <span className="h-full w-full rounded-full bg-surface-raised" />
    </span>
  )
}

export function ConversationShell({
  badge,
  headerActions,
  children,
  composer,
}: ConversationShellProps) {
  const currentConversationId = useConversationStore(
    (state) => state.currentConversationId,
  )
  const title = useConversationStore(
    (state) =>
      (currentConversationId &&
        state.conversationsById[currentConversationId]?.title) ||
      'Iris',
  )
  const sidebarOpen = useViewStateStore((state) => state.sidebarOpen)
  const theme = useViewStateStore((state) => state.theme)
  const setSidebarOpen = useViewStateStore((state) => state.setSidebarOpen)
  const setMobileSidebarOpen = useViewStateStore(
    (state) => state.setMobileSidebarOpen,
  )

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  return (
    <div className="flex h-screen min-h-[32rem] overflow-hidden bg-canvas text-ink">
      <DesktopConversationSidebar />
      <MobileConversationSidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="z-20 shrink-0 border-b border-border bg-canvas/90 backdrop-blur-md">
          <div className="flex h-[var(--topbar-height)] items-center justify-between gap-2 px-[var(--page-gutter)]">
            <div className="flex min-w-0 items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 md:hidden"
                aria-label="打开对话列表"
                onClick={() => setMobileSidebarOpen(true)}
              >
                <Menu aria-hidden="true" className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="hidden h-8 w-8 md:inline-flex"
                aria-label={sidebarOpen ? '收起对话列表' : '展开对话列表'}
                onClick={() => setSidebarOpen(!sidebarOpen)}
              >
                {sidebarOpen ? (
                  <PanelLeftClose aria-hidden="true" className="h-4 w-4" />
                ) : (
                  <PanelLeftOpen aria-hidden="true" className="h-4 w-4" />
                )}
              </Button>
              <BrandMark />
              <div className="min-w-0">
                <p className="truncate text-small font-semibold text-ink">
                  {title}
                </p>
              </div>
              <div className="hidden sm:block">{badge}</div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {headerActions}
            </div>
          </div>
        </header>

        {children}
        {composer}
      </div>
    </div>
  )
}
