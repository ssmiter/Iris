import { useEffect, type ReactNode } from 'react'
import { Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Button } from '@/components/ui'
import { useConversationStore } from '@/stores/conversationStore'
import { useViewStateStore } from '@/stores/viewStateStore'
import { useShellOverlayStore } from '@/stores/shellOverlayStore'
import {
  applyAccent,
  applyHue,
  applyMotionPreference,
  applyTheme,
} from '@/theme/theme'
import {
  DesktopConversationSidebar,
  MobileConversationSidebar,
} from './ConversationSidebar'
import { SearchPalette } from './SearchPalette'
import { SettingsOverlay } from './SettingsOverlay'

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
  const hue = useViewStateStore((state) => state.hue)
  const accent = useViewStateStore((state) => state.accent)
  const motionPreference = useViewStateStore(
    (state) => state.motionPreference,
  )
  const conversationWidth = useViewStateStore(
    (state) => state.conversationWidth,
  )
  const setSidebarOpen = useViewStateStore((state) => state.setSidebarOpen)
  const setMobileSidebarOpen = useViewStateStore(
    (state) => state.setMobileSidebarOpen,
  )
  const setSearchOpen = useShellOverlayStore((state) => state.setSearchOpen)

  useEffect(() => {
    applyTheme(theme)
  }, [theme])
  useEffect(() => {
    applyHue(hue)
  }, [hue])
  useEffect(() => {
    applyAccent(accent)
  }, [accent])
  useEffect(() => {
    applyMotionPreference(motionPreference)
  }, [motionPreference])

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--conversation-max',
      conversationWidth === 'narrow' ? '680px' : '820px',
    )
  }, [conversationWidth])

  // Ctrl/Cmd+K 全局打开搜索浮层（输入框内同样生效，与浏览器习惯一致）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setSearchOpen])

  return (
    <div className="flex h-dvh min-h-[32rem] overflow-hidden bg-canvas text-ink">
      <DesktopConversationSidebar />
      <MobileConversationSidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="z-20 shrink-0 bg-canvas/88 shadow-hairline backdrop-blur-md">
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

      <SearchPalette />
      <SettingsOverlay />
    </div>
  )
}
