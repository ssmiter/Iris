import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/utils'
import { useAuthStore } from '@/stores/authStore'
import { useChatStore } from '@/stores/chatStore'
import { useConversationStore } from '@/stores/conversationStore'
import { useFavoriteStore } from '@/stores/favoriteStore'
import { useFileStore } from '@/stores/fileStore'
import { usePermissionStore } from '@/stores/permissionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { syncFromConversations, useTitleRefreshStore } from '@/stores/conversationTitleStore'
import { useMainLoopRunStore } from '@/stores/mainLoopRuns'
import { useBrowseDirectoryStore } from '@/stores/browseDirectoryStore'
import { FEATURE_FLAGS, isFeatureHidden } from '@/config/product'
import {
  MessageSquare,
  Users,
  CalendarClock,
  Settings,
  Languages,
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  Star,
  Wrench,
  Puzzle,
  Boxes,
  BookOpenCheck,
  Sparkles,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Loader2,
  Check,
  X,
  Search,
  FolderOpen,
} from 'lucide-react'

// ── types ──────────────────────────────────────────────

interface NavItem {
  id: string
  labelKey: string
  icon: React.ReactNode
  feature?: string
}

/** 核心导航（始终可见，不超过 3 个；browse=文件浏览浮层开关，由 MainLayout 拦截不走视图） */
const CORE_ITEMS = ['chat', 'browse'] as const

/** 更多工具（收入可展开面板） */
const MORE_ITEMS = [
  // 记忆入口已迁至顶栏"记忆微尘"（记忆之野 2026-07-31）——侧栏旧入口隐藏，nav id 保留防回流
  { id: 'cron', labelKey: 'layout.sidebar.cron', icon: <CalendarClock size={18} />, feature: FEATURE_FLAGS.cronScheduler },
  { id: 'skill', labelKey: 'layout.sidebar.skill', icon: <Wrench size={18} />, feature: FEATURE_FLAGS.skill },
  { id: 'agent-swarm', labelKey: 'layout.sidebar.agentSwarm', icon: <Users size={18} />, feature: FEATURE_FLAGS.agentSwarm },
  { id: 'plugin', labelKey: 'layout.sidebar.plugin', icon: <Puzzle size={18} />, feature: FEATURE_FLAGS.plugin },
  // 【Iris 迁移 2026-09 禁用】客户工具包（mescli-packages）是 MES 业务页面，Iris 无此场景。
  // 骨架保留（页面/组件/API 未删），入口隐藏；恢复时取消下行注释。
  // { id: 'mescli-packages', labelKey: 'layout.sidebar.mescliPackages', icon: <Boxes size={18} />, feature: undefined },
  { id: 'knowledge', labelKey: 'layout.sidebar.knowledge', icon: <BookOpenCheck size={18} />, feature: undefined, requiresKnowledge: true },
  // MCP 插件市场（2026-08-06）：不加 feature 字段恒可见，市场不可用（内网/standalone）时视图层自降级
  { id: 'mcp-market', labelKey: 'layout.sidebar.mcpMarket', icon: <Sparkles size={18} />, feature: undefined },
] as const

interface SidebarProps {
  activeView: string
  onNavigate: (view: string) => void
  isCollapsed: boolean
  onToggleCollapse: () => void
  onOpenSettings: () => void
  knowledgeEnabled: boolean
}

// ── Conversation context menu ──────────────────────────

function ConvContextMenu({
  conv,
  open,
  position,
  onClose,
  onRename,
  onRefreshTitle,
  onDelete,
  isActive,
}: {
  conv: { id: number; title: string }
  open: boolean
  position: { top: number; left: number }
  onClose: () => void
  onRename: (id: number) => void
  onRefreshTitle: (id: number) => void
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
      <button onClick={() => { onRefreshTitle(conv.id); onClose() }}>
        <RefreshCw size={13} /> {t('layout.sidebar.refreshTitle')}
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

// ── 用户上弹菜单（设置 + 工具 + 快捷指令 + 语言二级页） ──

function UserMenu({
  open,
  position,
  onClose,
  onOpenSettings,
  onNavigate,
  moreItems,
  favorites,
  onSendFavorite,
  onDeleteFavorite,
}: {
  open: boolean
  position: { bottom: number; left: number; width?: number }
  onClose: () => void
  onOpenSettings: () => void
  onNavigate: (view: string) => void
  moreItems: readonly { id: string; labelKey: string; icon: React.ReactNode }[]
  favorites: { id: number; title: string; prompt: string }[]
  onSendFavorite: (prompt: string) => void
  onDeleteFavorite: (id: number) => void
}) {
  const { t, i18n } = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)
  const [p2, setP2] = useState(false)

  useEffect(() => {
    if (!open) return
    setP2(false)
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

  const handleSetLanguage = (lang: 'zh-CN' | 'en-US') => {
    useSettingsStore.getState().setLanguage(lang)
  }

  if (!open) return null

  const langName = i18n.language === 'en-US' ? 'English' : '简体中文'

  return (
    <div
      ref={menuRef}
      className={cn('wf-umenu', open && 'open')}
      style={{
        bottom: position.bottom,
        left: position.left,
        ...(position.width != null ? { width: position.width, minWidth: 0 } : {}),
      }}
    >
      <div className={cn('wf-umenu-slide', p2 && 'p2')}>
        {/* 一级页 */}
        <div className="wf-umenu-page">
          {/* 【Iris 2026-09】登录/MES 登录/登出入口已随登录体系删除——本地个人版无登录态概念 */}

          <button
            className="wf-umenu-row wf-press"
            onClick={() => setP2(true)}
          >
            <span className="wf-umenu-ic"><Languages size={14} /></span>
            <span>{t('layout.usermenu.language')}</span>
            <span className="wf-umenu-val">{langName}</span>
            <ChevronRight size={14} className="wf-umenu-chev" />
          </button>

          <div className="wf-umenu-sep" />

          <button
            className="wf-umenu-row wf-press"
            onClick={() => { onClose(); onOpenSettings() }}
          >
            <span className="wf-umenu-ic"><Settings size={14} /></span>
            <span>{t('layout.usermenu.settings')}</span>
          </button>

          {moreItems.length > 0 && (
            <>
              <div className="wf-umenu-sep" />
              <div className="wf-umenu-cap">{t('layout.usermenu.tools')}</div>
              {moreItems.map((item) => (
                <button
                  key={item.id}
                  data-testid={item.id === 'knowledge' ? 'knowledge-account-menu-button' : undefined}
                  className="wf-umenu-row wf-press"
                  onClick={() => { onClose(); onNavigate(item.id) }}
                >
                  <span className="wf-umenu-ic">{item.icon}</span>
                  <span>{t(item.labelKey)}</span>
                </button>
              ))}
            </>
          )}

          {favorites.length > 0 && (
            <>
              <div className="wf-umenu-sep" />
              <div className="wf-umenu-cap">{t('layout.sidebar.quickCommands')}</div>
              {favorites.slice(0, 4).map((fav) => (
                <div key={fav.id} className="wf-menu-fav-row">
                  <button onClick={() => { onClose(); onSendFavorite(fav.prompt) }} title={fav.prompt}>
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

          {/* 【Iris 2026-09】登出按钮已删除：本地个人版恒为本地身份，无登录态可退出 */}
        </div>

        {/* 二级页：语言 */}
        <div className="wf-umenu-page">
          <button
            className="wf-umenu-row wf-press"
            onClick={() => setP2(false)}
          >
            <span className="wf-umenu-ic"><ChevronLeft size={14} /></span>
            <span>{t('layout.usermenu.language')}</span>
          </button>
          <div className="wf-umenu-sep" />
          <button
            className={cn('wf-umenu-row wf-press', i18n.language === 'zh-CN' && 'on')}
            onClick={() => handleSetLanguage('zh-CN')}
          >
            <span>简体中文</span>
            {i18n.language === 'zh-CN' && <Check size={14} className="wf-umenu-check" />}
          </button>
          <button
            className={cn('wf-umenu-row wf-press', i18n.language === 'en-US' && 'on')}
            onClick={() => handleSetLanguage('en-US')}
          >
            <span>English</span>
            {i18n.language === 'en-US' && <Check size={14} className="wf-umenu-check" />}
          </button>
        </div>
      </div>
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

export function Sidebar({ activeView, onNavigate, isCollapsed, onToggleCollapse, onOpenSettings, knowledgeEnabled }: SidebarProps) {
  const { t } = useTranslation()
  // 【Iris 2026-09】本地个人版恒为本地身份：无多身份徽标/副标题，展示固定本地用户
  const { user } = useAuthStore()

  const badge = null
  const subtitle = 'Iris Local'

  const permissions = usePermissionStore((s) => s.permissions)

  // ── nav items ──
  const coreIconMap: Record<string, React.ReactNode> = {
    chat: <MessageSquare size={20} />,
    browse: <FolderOpen size={20} />,
  }
  // 文件浏览浮层的"选中"态=窗口开着且未最小化（它不是视图，activeView 永不等于它）
  const browseVisible = useBrowseDirectoryStore((s) => s.isOpen && !s.minimized)
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
    if ('requiresKnowledge' in item && item.requiresKnowledge && !knowledgeEnabled) return false
    // 【Iris】requiresMes 入口隐藏：Iris 无 MES 登录，企业数据项恒不可用
    if ('requiresMes' in item && item.requiresMes) return false
    if (isFeatureHidden(item.feature)) return false
    if (!item.feature) return true
    // 【Iris 2026-09】License/额度闸已随付费体系删除——按后端权限过滤
    return permissions ? permissions.features.includes(item.feature) : true
  }
  const moreItems = MORE_ITEMS.filter(isMoreAvailable)

  // ── stores ──
  const {
    conversations,
    currentConversationId,
    loadConversations,
    createConversation,
    deleteConversation,
    updateConversationTitle,
  } = useConversationStore()

  const {
    favorites,
    loadFavorites,
    deleteFavorite,
  } = useFavoriteStore()

  // 2026-08-12 用户拍板：内联搜索框撤掉（很少用；logo 右侧搜索图标 + Ctrl+K 浮层足够），
  // 会话列表永远渲染全量，「对话」字样只保留必要的按钮。
  // 2026-09-01 二阶段：任务会话（parentConversationId 有值）不进主列表——
  // 入口=父会话任务卡；旧数据/IndexedDB 存量该字段为 undefined，== null 放行。
  const visibleConversations = conversations.filter((c) => c.parentConversationId == null)

  // 标题刷新进行中集合（手动刷新/自动生成的 spinner 都据此渲染）
  const titleRefreshingIds = useTitleRefreshStore((s) => s.refreshingIds)

  // 2026-07-31 订阅风暴修复：整店订阅导致侧栏随每个流式 chunk 重渲染；
  // messages 本就从未使用，六个 action 引用稳定，逐个精准订阅。
  const sendMessage = useChatStore((s) => s.sendMessage)
  const clearMessages = useChatStore((s) => s.clearMessages)
  const detachConversationView = useChatStore((s) => s.detachConversationView)
  const attachConversationView = useChatStore((s) => s.attachConversationView)
  // 2026-09-04 会话后台化：运行中会话的"安静徽标"数据源（有主 loop 在跑的会话 id）
  const runningConversationIds = useMainLoopRunStore((s) => s.runningIds)

  useEffect(() => {
    // 【Iris】恒已登录：启动即加载会话与快捷指令
    loadConversations()
    loadFavorites()
  }, [loadConversations, loadFavorites])

  useEffect(() => {
    syncFromConversations(conversations)
  }, [conversations])

  // ── local state ──
  const [ctxMenu, setCtxMenu] = useState<{ conv: { id: number; title: string }; x: number; y: number } | null>(null)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [userMenuPos, setUserMenuPos] = useState<{ bottom: number; left: number; width?: number } | null>(null)

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
  // 2026-09-04 会话后台化：切换=detach/attach（有 run 的会话视图入 stash，loop 继续后台跑），
  // 不再 stopStreaming——进不进会话只是渲染差别，agent 逻辑一直在跑和落库。
  const handleSelectConversation = (id: number) => {
    if (activeView !== 'chat') onNavigate('chat')
    if (id === currentConversationId) return
    detachConversationView()
    attachConversationView(id)
  }

  const handleNewConversation = async () => {
    if (activeView !== 'chat') onNavigate('chat')
    detachConversationView()
    const id = await createConversation(t('chat.chatView.newConversation'))
    if (id) {
      attachConversationView(id)
      useFileStore.getState().clearPendingFiles()
    } else {
      // 创建失败（toast 已提示）：视图已清空，重载当前会话消息恢复视图
      const cur = useConversationStore.getState().currentConversationId
      if (cur != null) attachConversationView(cur)
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

  // 手动刷新标题（2026-08-14 恢复入口）：复用 store 的 refreshConversationTitle，
  // 非当前会话也会从存储层取用户消息组合，不会张冠李戴。标题写回即反馈。
  const handleRefreshTitle = (id: number) => {
    void useChatStore.getState().refreshConversationTitle(id)
  }

  const handleRenameSave = (id: number, newTitle: string) => {
    const trimmed = newTitle.trim()
    if (trimmed) updateConversationTitle(id, trimmed)
    setRenamingId(null)
  }

  const handleDeleteConv = (id: number) => {
    const conv = conversations.find((c) => c.id === id)
    const running = runningConversationIds.includes(id)
    // 简单确认（同卸载包 confirm 先例）；运行中会话多一句警示
    const message = running
      ? t('layout.sidebar.deleteRunningConfirm', { title: conv?.title ?? '' })
      : t('layout.sidebar.deleteConfirm', { title: conv?.title ?? '' })
    if (!confirm(message)) {
      setCtxMenu(null)
      return
    }
    if (currentConversationId === id) clearMessages()
    // 删除会先停掉该会话的后台 run（conversationStore 内），完成后同步视图流式态
    void deleteConversation(id).then(() => useChatStore.getState().syncStreaming())
    setCtxMenu(null)
  }

  const handlePaletteSelect = (id: number) => {
    setPaletteOpen(false)
    handleSelectConversation(id)
  }

  const handleToggleUserMenu = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (userMenuPos) {
      setUserMenuPos(null)
      return
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (isCollapsed) {
      // 折叠态侧栏仅 56px，物理装不下整宽菜单：保持现状，从头像锚点向右展开（不越界）
      setUserMenuPos({ bottom: window.innerHeight - rect.top + 8, left: rect.left + 8 })
      return
    }
    // 展开态（248px）：菜单宽度=侧栏内宽（左右各 12px），严格隶属侧栏（蓝图 .usermenu）
    const sideEl = (e.currentTarget as HTMLElement).closest('.wf-sidebar')
    const sideRect = sideEl?.getBoundingClientRect()
    if (!sideRect) {
      setUserMenuPos({ bottom: window.innerHeight - rect.top + 8, left: rect.right - 220 })
      return
    }
    setUserMenuPos({
      bottom: window.innerHeight - rect.top + 8,
      left: sideRect.left + 12,
      width: sideRect.width - 24,
    })
  }

  const handleUserMenuNavigate = (view: string) => {
    setUserMenuPos(null)
    onNavigate(view)
  }

  const handleUserMenuFavorite = (prompt: string) => {
    setUserMenuPos(null)
    handleSendFavorite(prompt)
  }

  const handleGearClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setUserMenuPos(null)
    onOpenSettings()
  }

  return (
    <aside className={cn('wf-sidebar', isCollapsed && 'collapsed')}>
      {/* ── Logo ── */}
      <div className="wf-sidebar-logo">
        <div
          className={cn('wf-sidebar-brand', isCollapsed && 'clickable')}
          onClick={isCollapsed ? onToggleCollapse : undefined}
          title={isCollapsed ? t('layout.sidebar.expand') : undefined}
        >
          <img src="/iris-logo.png" alt="Iris" className="wf-sidebar-ico" />
          {!isCollapsed && <span>Iris</span>}
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

      {/* ── 新建对话（2026-08-08 侧栏稳定化：全视图常驻，不再随视图撤掉——
          撤掉会导致导航行上下跳动；handleNewConversation 内部自带回 chat 导航） ── */}
      <div className={cn('wf-sidebar-new-conv', isCollapsed && 'collapsed')}>
        <button onClick={handleNewConversation}>
          <Plus size={isCollapsed ? 20 : 17} />
          {!isCollapsed && t('layout.sidebar.newConversation')}
        </button>
      </div>

      {/* ── 导航：核心 + 工具，全部扁平 ── */}
      <nav className={cn('wf-sidebar-nav', isCollapsed && 'collapsed')}>
        {coreItems.map((item) => {
          const isActive = item.id === 'browse' ? browseVisible : activeView === item.id
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

      {/* ── 收起态：设置 + 工具以图标按钮平铺（与核心导航同款） ── */}
      {isCollapsed && (
        <nav className="wf-sidebar-nav collapsed wf-sidebar-nav-tools">
          <button
            onClick={onOpenSettings}
            className="wf-sidebar-nav-item"
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

      {/* ── 对话历史（占满剩余空间，上下淡化提示可滚动；全视图常驻=跨视图快切器，
          切会话/新建内部都会先回 chat 再执行，走廊开着点会话也会关走廊回家） ── */}
      {!isCollapsed && (
        <div className="wf-sidebar-conversations">
          <div className="wf-sidebar-conv-wrap">
            <div className={cn('wf-conv-fade top', convScroll.canUp && 'show')} />
            <div
              ref={convListRef}
              className="wf-sidebar-conv-scroll"
              onScroll={updateConvScroll}
            >
              <div className="wf-sidebar-conv-list">
                {visibleConversations.length === 0 && (
                  <p className="wf-sidebar-empty">{t('layout.sidebar.noConversations')}</p>
                )}
                {visibleConversations.map((conv) => {
                  const isActive = currentConversationId === conv.id
                  const isRunning = runningConversationIds.includes(conv.id)

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
                      className={cn('wf-sidebar-conv-item', isActive && 'active', isRunning && 'running')}
                    >
                      <span className="wf-sidebar-conv-title">
                        {titleRefreshingIds.has(conv.id) && (
                          <Loader2 size={11} className="wf-sidebar-conv-spinner animate-spin" />
                        )}
                        <span className="wf-sidebar-conv-title-text">{conv.title}</span>
                      </span>
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

      {/* spacer：收起态把底部用户行推到底（展开态由对话历史 flex-1 承担） */}
      {isCollapsed && <div className="flex-1 min-h-0" />}

      {/* ── 底部：用户块 + 上弹菜单 ── */}
      <div className={cn('wf-sidebar-bottom', isCollapsed && 'collapsed')}>
        <div
          className={cn('wf-ublock', isCollapsed && 'collapsed', !isCollapsed && 'wf-press')}
          onClick={!isCollapsed ? handleToggleUserMenu : undefined}
        >
          {isCollapsed ? (
            <button
              className={cn('wf-ublock-avatar', 'logged-in', 'wf-press')}
              onClick={handleToggleUserMenu}
              title={user.realName}
            >
              <span>{user.realName.charAt(0)}</span>
            </button>
          ) : (
            <>
              <div className={cn('wf-ublock-avatar', 'logged-in')}>
                <span>{user.realName.charAt(0)}</span>
              </div>
              <div className="wf-ublock-id">
                <div className="wf-ublock-nm" title={user.realName}>
                  <span>{user.realName}</span>
                  {badge && <span className="wf-ublock-badge">{badge}</span>}
                </div>
                <div className="wf-ublock-sub" title={subtitle}>{subtitle}</div>
              </div>
              <button
                className="wf-ublock-gear wf-press"
                onClick={handleGearClick}
                title={t('layout.usermenu.settings')}
              >
                <Settings size={16} />
              </button>
            </>
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
        onRefreshTitle={handleRefreshTitle}
        onDelete={handleDeleteConv}
        isActive={ctxMenu?.conv.id === currentConversationId}
      />

      {/* ── 用户上弹菜单 ── */}
      <UserMenu
        open={!!userMenuPos}
        position={userMenuPos ?? { bottom: 0, left: 0 }}
        onClose={() => setUserMenuPos(null)}
        onOpenSettings={onOpenSettings}
        onNavigate={handleUserMenuNavigate}
        moreItems={moreItems}
        favorites={favorites}
        onSendFavorite={handleUserMenuFavorite}
        onDeleteFavorite={deleteFavorite}
      />

      {/* ── 对话搜索浮层（Ctrl+K） ── */}
      <SearchPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        conversations={visibleConversations}
        currentId={currentConversationId}
        onSelect={handlePaletteSelect}
      />
    </aside>
  )
}
