import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/utils'
import { useAuthStore } from '@/stores/authStore'
import { useChatStore } from '@/stores/chatStore'
import { useConversationStore } from '@/stores/conversationStore'
import { useFavoriteStore } from '@/stores/favoriteStore'
import { useFileStore } from '@/stores/fileStore'
import { useLicenseStore } from '@/stores/licenseStore'
import { useQuotaStore } from '@/stores/quotaStore'
import { usePermissionStore } from '@/stores/permissionStore'
import { useConversationTitleStore } from '@/stores/conversationTitleStore'
import { isPreview, supportsLicenseActivation, FEATURE_FLAGS, isOnline, isFeatureHidden } from '@/config/product'
import {
  MessageSquare,
  Workflow,
  Brain,
  Users,
  CalendarClock,
  Settings,
  LogIn,
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  Star,
  Wrench,
  Globe,
  GitBranch,
  Puzzle,
  MoreHorizontal,
  Pencil,
  Check,
  X,
  Search,
} from 'lucide-react'

const IS_STANDALONE = import.meta.env.VITE_STANDALONE_MODE === 'true'

// ── types ──────────────────────────────────────────────

interface NavItem {
  id: string
  labelKey: string
  icon: React.ReactNode
  feature?: string
}

/** 核心导航（始终可见，不超过 3 个） */
const CORE_ITEMS: (keyof typeof FEATURE_FLAGS)[] = ['chat', 'workflow']

/** 更多工具（收入可展开面板） */
const MORE_ITEMS = [
  { id: 'memory', labelKey: 'layout.sidebar.memory', icon: <Brain size={18} />, feature: FEATURE_FLAGS.memory },
  { id: 'webbridge', labelKey: 'layout.sidebar.webbridge', icon: <Globe size={18} />, feature: FEATURE_FLAGS.webbridge },
  { id: 'cron', labelKey: 'layout.sidebar.cron', icon: <CalendarClock size={18} />, feature: FEATURE_FLAGS.cronScheduler },
  { id: 'skill', labelKey: 'layout.sidebar.skill', icon: <Wrench size={18} />, feature: FEATURE_FLAGS.skill },
  { id: 'dag-workflow', labelKey: 'layout.sidebar.dagWorkflow', icon: <GitBranch size={18} />, feature: FEATURE_FLAGS.dagWorkflow },
  { id: 'agent-swarm', labelKey: 'layout.sidebar.agentSwarm', icon: <Users size={18} />, feature: FEATURE_FLAGS.agentSwarm },
  { id: 'plugin', labelKey: 'layout.sidebar.plugin', icon: <Puzzle size={18} />, feature: FEATURE_FLAGS.plugin },
] as const

interface SidebarProps {
  activeView: string
  onNavigate: (view: string) => void
  isCollapsed: boolean
  onToggleCollapse: () => void
  onOpenLogin: () => void
}

// ── Conversation context menu ──────────────────────────

function ConvContextMenu({
  conv,
  open,
  position,
  onClose,
  onRename,
  onDelete,
  isActive,
}: {
  conv: { id: number; title: string }
  open: boolean
  position: { top: number; left: number }
  onClose: () => void
  onRename: (id: number) => void
  onDelete: (id: number) => void
  isActive: boolean
}) {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', h)
    document.addEventListener('keydown', k)
    return () => {
      document.removeEventListener('mousedown', h)
      document.removeEventListener('keydown', k)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      ref={menuRef}
      className="wf-conv-menu"
      style={{ top: position.top, left: position.left }}
    >
      <button onClick={() => { onRename(conv.id); onClose() }}>
        <Pencil size={13} /> {t('layout.sidebar.rename')}
      </button>
      <button
        onClick={() => { onDelete(conv.id); onClose() }}
        className="danger"
      >
        <Trash2 size={13} /> {t('layout.sidebar.delete')}
      </button>
    </div>
  )
}

// ── Inline rename input ────────────────────────────────

function InlineRename({
  value,
  onSave,
  onCancel,
}: {
  value: string
  onSave: (v: string) => void
  onCancel: () => void
}) {
  const [v, setV] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])

  return (
    <div className="wf-rename-row" onClick={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSave(v)
          if (e.key === 'Escape') onCancel()
        }}
        maxLength={60}
      />
      <button onClick={() => onSave(v)}><Check size={12} /></button>
      <button onClick={onCancel}><X size={12} /></button>
    </div>
  )
}

// ── 用户 ··· 菜单（设置 + 工具 + 快捷指令收纳，向上弹出） ──

function UserMenu({
  open,
  position,
  onClose,
  onNavigate,
  moreItems,
  activeView,
  favorites,
  onSendFavorite,
  onDeleteFavorite,
}: {
  open: boolean
  position: { bottom: number; left: number }
  onClose: () => void
  onNavigate: (view: string) => void
  moreItems: readonly { id: string; labelKey: string; icon: React.ReactNode }[]
  activeView: string
  favorites: { id: number; title: string; prompt: string }[]
  onSendFavorite: (prompt: string) => void
  onDeleteFavorite: (id: number) => void
}) {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', h)
    document.addEventListener('keydown', k)
    return () => {
      document.removeEventListener('mousedown', h)
      document.removeEventListener('keydown', k)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      ref={menuRef}
      className="wf-conv-menu wf-user-menu"
      style={{ bottom: position.bottom, left: position.left }}
    >
      <button
        onClick={() => onNavigate('settings')}
        className={activeView === 'settings' ? 'active' : undefined}
      >
        <Settings size={13} /> {t('layout.sidebar.settings')}
      </button>
      {moreItems.length > 0 && <div className="wf-menu-divider" />}
      {moreItems.map((item) => (
        <button
          key={item.id}
          onClick={() => onNavigate(item.id)}
          className={activeView === item.id ? 'active' : undefined}
        >
          <span className="wf-menu-ico">{item.icon}</span> {t(item.labelKey)}
        </button>
      ))}
      {favorites.length > 0 && (
        <>
          <div className="wf-menu-divider" />
          <div className="wf-menu-section">{t('layout.sidebar.quickCommands')}</div>
          {favorites.slice(0, 4).map((fav) => (
            <div key={fav.id} className="wf-menu-fav-row">
              <button onClick={() => onSendFavorite(fav.prompt)} title={fav.prompt}>
                <Star size={12} /> <span className="wf-menu-fav-title">{fav.title}</span>
              </button>
              <button
                className="wf-menu-fav-del"
                onClick={() => onDeleteFavorite(fav.id)}
                title={t('layout.sidebar.delete')}
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  )
}

// ── 对话搜索浮层（Ctrl+K，居中偏上，背景虚化） ──

function SearchPalette({
  open,
  onClose,
  conversations,
  currentId,
  onSelect,
}: {
  open: boolean
  onClose: () => void
  conversations: { id: number; title: string }[]
  currentId: number | null
  onSelect: (id: number) => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const q = query.trim().toLowerCase()
  // 空查询展示最近对话（原顺序即最近优先）；有查询按标题过滤，预留全文匹配扩展
  const results = q
    ? conversations.filter((c) => c.title.toLowerCase().includes(q))
    : conversations.slice(0, 8)

  // 打开时聚焦并重置
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIdx(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // 结果集变化时重置高亮
  useEffect(() => { setActiveIdx(0) }, [q])

  // 高亮项保持可见
  useEffect(() => {
    listRef.current
      ?.querySelector('.wf-palette-item.active')
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  if (!open) return null

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = results[activeIdx]
      if (target) onSelect(target.id)
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  return (
    <div className="wf-palette-backdrop" onClick={onClose}>
      <div className="wf-palette" onClick={(e) => e.stopPropagation()}>
        <div className="wf-palette-input-row">
          <Search size={15} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('layout.sidebar.searchConversations')}
          />
          {query && (
            <button onClick={() => setQuery('')} title={t('layout.sidebar.clearSearch')}>
              <X size={13} />
            </button>
          )}
        </div>
        <div ref={listRef} className="wf-palette-list">
          {results.length === 0 && (
            <p className="wf-palette-empty">{t('layout.sidebar.noMatchingConversations')}</p>
          )}
          {results.map((conv, idx) => (
            <div
              key={conv.id}
              className={cn(
                'wf-palette-item',
                idx === activeIdx && 'active',
                conv.id === currentId && 'current',
              )}
              onMouseEnter={() => setActiveIdx(idx)}
              onClick={() => onSelect(conv.id)}
            >
              <MessageSquare size={13} />
              <span className="wf-palette-title">{conv.title}</span>
              {conv.id === currentId && (
                <span className="wf-palette-current-tag">{t('layout.sidebar.currentConversation')}</span>
              )}
            </div>
          ))}
        </div>
        <div className="wf-palette-footer">
          <span>{t('layout.sidebar.paletteHints')}</span>
          <span className="wf-palette-scope">{t('layout.sidebar.paletteScope')}</span>
        </div>
      </div>
    </div>
  )
}

// ── Sidebar ────────────────────────────────────────────

export function Sidebar({ activeView, onNavigate, isCollapsed, onToggleCollapse, onOpenLogin }: SidebarProps) {
  const { t } = useTranslation()
  const { user, isLoggedIn, isMesLoggedIn, isCloudLoggedIn, isWebsiteLoggedIn, websiteAccount, cloudAccount } = useAuthStore()
  const license = useLicenseStore((s) => s.license)
  const usage = useQuotaStore((s) => s.usage)
  const permissions = usePermissionStore((s) => s.permissions)

  // ── nav items ──
  const coreIconMap: Record<string, React.ReactNode> = {
    chat: <MessageSquare size={20} />,
    workflow: <Workflow size={20} />,
  }
  const coreItems = CORE_ITEMS
    .filter((id) => {
      const feat = FEATURE_FLAGS[id as keyof typeof FEATURE_FLAGS]
      if (isFeatureHidden(feat)) return false
      return true
    })
    .map((id) => ({
      id,
      labelKey: `layout.sidebar.${id}` as const,
      icon: coreIconMap[id] ?? <MessageSquare size={20} />,
    }))

  const isMoreAvailable = (item: (typeof MORE_ITEMS)[number]): boolean => {
    if (isFeatureHidden(item.feature)) return false
    if (!item.feature) return true
    if (!isPreview && !supportsLicenseActivation) {
      return permissions ? permissions.features.includes(item.feature) : true
    }
    if (isPreview || !supportsLicenseActivation) return true
    // license 未加载（null）不应当作"无授权"而隐藏全部入口——
    // 否则 external Online 用户在 license 初始化前看不到任何工具。
    if (!license) return true
    if (license.status !== 'active' && license.status !== 'trial') return false
    if (!(license.features || []).includes(item.feature)) return false
    if (usage && usage.remainingTokens === 0) return false
    return true
  }
  const moreItems = MORE_ITEMS.filter(isMoreAvailable)

  // ── stores ──
  const {
    conversations,
    currentConversationId,
    loadConversations,
    createConversation,
    deleteConversation,
    setCurrentConversation,
    updateConversationTitle,
  } = useConversationStore()

  const {
    favorites,
    loadFavorites,
    deleteFavorite,
  } = useFavoriteStore()

  const {
    messages,
    sendMessage,
    clearMessages,
    loadMessages,
    setLoading,
    setStreaming,
    stopStreaming,
  } = useChatStore()

  useEffect(() => {
    if (!isLoggedIn) return
    loadConversations()
    loadFavorites()
  }, [isLoggedIn, loadConversations, loadFavorites])

  useEffect(() => {
    useConversationTitleStore.getState().syncFromConversations(conversations)
  }, [conversations])

  // ── local state ──
  const [ctxMenu, setCtxMenu] = useState<{ conv: { id: number; title: string }; x: number; y: number } | null>(null)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [userMenuPos, setUserMenuPos] = useState<{ bottom: number; left: number } | null>(null)

  // ── 历史对话：滚动淡化 ──
  const convListRef = useRef<HTMLDivElement>(null)
  const [convScroll, setConvScroll] = useState({ canUp: false, canDown: false })

  const updateConvScroll = useCallback(() => {
    const el = convListRef.current
    if (!el) return
    const canUp = el.scrollTop > 4
    const canDown = el.scrollTop + el.clientHeight < el.scrollHeight - 4
    setConvScroll((prev) => (prev.canUp === canUp && prev.canDown === canDown ? prev : { canUp, canDown }))
  }, [])

  // 列表内容变化（加载/删除）后重算淡化状态
  useEffect(() => {
    updateConvScroll()
  }, [conversations.length, updateConvScroll])

  // 切换当前对话时把它滚动到可视窗口内
  useEffect(() => {
    if (currentConversationId == null) return
    const el = convListRef.current?.querySelector('.wf-sidebar-conv-item.active')
    el?.scrollIntoView({ block: 'nearest' })
    updateConvScroll()
  }, [currentConversationId, updateConvScroll])

  // Ctrl/Cmd + K 打开对话搜索浮层
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  // ── handlers ──
  const handleSelectConversation = (id: number) => {
    if (activeView !== 'chat') onNavigate('chat')
    stopStreaming()
    setCurrentConversation(id)
    clearMessages()
    setLoading(false)
    setStreaming(false)
    loadMessages(id)
  }

  const handleNewConversation = async () => {
    if (activeView !== 'chat') onNavigate('chat')
    stopStreaming()
    setLoading(false)
    setStreaming(false)
    const id = await createConversation(t('chat.chatView.newConversation'))
    if (id) {
      clearMessages()
      useFileStore.getState().clearPendingFiles()
    }
  }

  const handleSendFavorite = (prompt: string) => {
    if (activeView !== 'chat') onNavigate('chat')
    sendMessage(prompt)
  }

  const handleOpenCtxMenu = (e: React.MouseEvent, conv: { id: number; title: string }) => {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setCtxMenu({ conv, x: rect.right - 8, y: rect.top - 4 })
  }

  const handleRename = (id: number) => {
    setRenamingId(id)
    setCtxMenu(null)
  }

  const handleRenameSave = (id: number, newTitle: string) => {
    const trimmed = newTitle.trim()
    if (trimmed) updateConversationTitle(id, trimmed)
    setRenamingId(null)
  }

  const handleDeleteConv = (id: number) => {
    if (currentConversationId === id) clearMessages()
    deleteConversation(id)
    setCtxMenu(null)
  }

  const handlePaletteSelect = (id: number) => {
    setPaletteOpen(false)
    handleSelectConversation(id)
  }

  const handleOpenUserMenu = (e: React.MouseEvent) => {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setUserMenuPos({ bottom: window.innerHeight - rect.top + 8, left: rect.right - 200 })
  }

  const handleUserMenuNavigate = (view: string) => {
    setUserMenuPos(null)
    onNavigate(view)
  }

  const handleUserMenuFavorite = (prompt: string) => {
    setUserMenuPos(null)
    handleSendFavorite(prompt)
  }

  const isChatActive = activeView === 'chat'

  return (
    <aside className={cn('wf-sidebar', isCollapsed && 'collapsed')}>
      {/* ── Logo ── */}
      <div className="wf-sidebar-logo">
        <div
          className={cn('wf-sidebar-brand', isCollapsed && 'clickable')}
          onClick={isCollapsed ? onToggleCollapse : undefined}
          title={isCollapsed ? t('layout.sidebar.expand') : undefined}
        >
          <img src="./iris-logo.svg" alt="Iris" className="wf-sidebar-ico" />
          {!isCollapsed && <span>Won<b>Work</b></span>}
        </div>
        {!isCollapsed && (
          <div className="wf-sidebar-logo-actions">
            <button
              onClick={() => setPaletteOpen(true)}
              className="wf-sidebar-collapse-btn"
              title={t('layout.sidebar.searchTooltip')}
            >
              <Search size={15} />
            </button>
            <button onClick={onToggleCollapse} className="wf-sidebar-collapse-btn" title={t('layout.sidebar.collapse')}>
              <ChevronLeft size={15} />
            </button>
          </div>
        )}
      </div>

      {isCollapsed && (
        <>
          <button onClick={onToggleCollapse} className="wf-sidebar-expand-btn" title={t('layout.sidebar.expand')}>
            <ChevronRight size={15} />
          </button>
          <button
            onClick={() => setPaletteOpen(true)}
            className="wf-sidebar-expand-btn"
            title={t('layout.sidebar.searchTooltip')}
          >
            <Search size={15} />
          </button>
        </>
      )}

      {/* ── 新建对话 ── */}
      {isChatActive && (
        <div className={cn('wf-sidebar-new-conv', isCollapsed && 'collapsed')}>
          <button onClick={handleNewConversation}>
            <Plus size={isCollapsed ? 20 : 17} />
            {!isCollapsed && t('layout.sidebar.newConversation')}
          </button>
        </div>
      )}

      {/* ── 导航：核心 + 工具，全部扁平 ── */}
      <nav className={cn('wf-sidebar-nav', isCollapsed && 'collapsed')}>
        {coreItems.map((item) => {
          const isActive = activeView === item.id
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={cn('wf-sidebar-nav-item', isActive && 'active')}
              title={isCollapsed ? t(item.labelKey) : undefined}
            >
              <span className="wf-sidebar-nav-icon">{item.icon}</span>
              {!isCollapsed && <span>{t(item.labelKey)}</span>}
            </button>
          )
        })}
      </nav>

      {/* ── 收起态：设置 + 工具以图标按钮平铺（与核心导航同款），替代 ··· 菜单 ── */}
      {isCollapsed && (
        <nav className="wf-sidebar-nav collapsed wf-sidebar-nav-tools">
          <button
            onClick={() => onNavigate('settings')}
            className={cn('wf-sidebar-nav-item', activeView === 'settings' && 'active')}
            title={t('layout.sidebar.settings')}
          >
            <span className="wf-sidebar-nav-icon"><Settings size={20} /></span>
          </button>
          {moreItems.map((item) => (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={cn('wf-sidebar-nav-item', activeView === item.id && 'active')}
              title={t(item.labelKey)}
            >
              <span className="wf-sidebar-nav-icon">{item.icon}</span>
            </button>
          ))}
        </nav>
      )}

      {/* ── 对话历史（占满剩余空间，上下淡化提示可滚动） ── */}
      {isChatActive && !isCollapsed && (
        <div className="wf-sidebar-conversations">
          <div className="wf-sidebar-conv-wrap">
            <div className={cn('wf-conv-fade top', convScroll.canUp && 'show')} />
            <div
              ref={convListRef}
              className="wf-sidebar-conv-scroll"
              onScroll={updateConvScroll}
            >
              <div className="wf-sidebar-conv-list">
                {conversations.length === 0 && (
                  <p className="wf-sidebar-empty">{t('layout.sidebar.noConversations')}</p>
                )}
                {conversations.map((conv) => {
                  const isActive = currentConversationId === conv.id

                  if (renamingId === conv.id) {
                    return (
                      <InlineRename
                        key={conv.id}
                        value={conv.title}
                        onSave={(v) => handleRenameSave(conv.id, v)}
                        onCancel={() => setRenamingId(null)}
                      />
                    )
                  }

                  return (
                    <div
                      key={conv.id}
                      onClick={() => handleSelectConversation(conv.id)}
                      className={cn('wf-sidebar-conv-item', isActive && 'active')}
                    >
                      <span className="wf-sidebar-conv-title">{conv.title}</span>
                      <button
                        className="wf-sidebar-conv-more"
                        onClick={(e) => handleOpenCtxMenu(e, conv)}
                        title={t('layout.sidebar.moreActions')}
                      >
                        <MoreHorizontal size={13} />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
            <div className={cn('wf-conv-fade bottom', convScroll.canDown && 'show')} />
          </div>
        </div>
      )}

      {/* spacer：非 chat 视图时把底部用户行推到底 */}
      {!(isChatActive && !isCollapsed) && <div className="flex-1 min-h-0" />}

      {/* ── 底部：用户 + ··· 菜单（设置/工具/快捷指令收纳） ── */}
      <div className={cn('wf-sidebar-bottom', isCollapsed && 'collapsed')}>
        <div className="wf-sidebar-user-row">
          <button onClick={onOpenLogin} className="wf-sidebar-user">
            <div className={cn('wf-sidebar-avatar', isLoggedIn && 'logged-in')}>
              <span>{isLoggedIn && user?.realName ? user.realName.charAt(0) : '?'}</span>
            </div>
            {!isCollapsed && (
              <div className="wf-sidebar-user-text">
                <p>{isLoggedIn && user?.realName ? user.realName : t('layout.sidebar.clickToLogin')}</p>
                <p>
                  {isWebsiteLoggedIn
                    ? (isMesLoggedIn ? 'Online' : 'Website')
                    : isCloudLoggedIn ? 'Wongoing'
                    : IS_STANDALONE ? 'Standalone'
                    : isMesLoggedIn ? 'MES' : t('layout.sidebar.notLoggedIn')}
                </p>
              </div>
            )}
            {!isCollapsed && !isLoggedIn && <LogIn size={12} />}
          </button>
          {!isCollapsed && (
            <button
              className="wf-sidebar-user-more"
              onClick={handleOpenUserMenu}
              title={t('layout.sidebar.moreActions')}
            >
              <MoreHorizontal size={15} />
            </button>
          )}
        </div>
      </div>

      {/* ── 对话右键菜单 ── */}
      <ConvContextMenu
        conv={ctxMenu?.conv ?? { id: 0, title: '' }}
        open={!!ctxMenu}
        position={ctxMenu ? { top: ctxMenu.y, left: ctxMenu.x } : { top: 0, left: 0 }}
        onClose={() => setCtxMenu(null)}
        onRename={handleRename}
        onDelete={handleDeleteConv}
        isActive={ctxMenu?.conv.id === currentConversationId}
      />

      {/* ── 用户 ··· 菜单：设置 + 工具 + 快捷指令 ── */}
      <UserMenu
        open={!!userMenuPos}
        position={userMenuPos ?? { bottom: 0, left: 0 }}
        onClose={() => setUserMenuPos(null)}
        onNavigate={handleUserMenuNavigate}
        moreItems={moreItems}
        activeView={activeView}
        favorites={favorites}
        onSendFavorite={handleUserMenuFavorite}
        onDeleteFavorite={deleteFavorite}
      />

      {/* ── 对话搜索浮层（Ctrl+K） ── */}
      <SearchPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        conversations={conversations}
        currentId={currentConversationId}
        onSelect={handlePaletteSelect}
      />
    </aside>
  )
}
