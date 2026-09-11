import { lazy, Suspense, useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/utils'
import { Sidebar } from './Sidebar'
import { ChatView } from '@/components/chat'
import { MemoryManagerView } from '@/components/Memory'
import { AgentSwarmView } from '@/components/AgentSwarm'
import { CronSchedulerView } from '@/components/CronScheduler'
import { SettingsOverlay } from '@/components/Settings/SettingsOverlay'
import { useSettingsOverlayStore } from '@/stores/settingsOverlayStore'
import { SecurityGatewayView } from '@/components/SecurityGateway/SecurityGatewayView'
import { useSecurityGatewayViewStore } from '@/stores/securityGatewayViewStore'
import { SkillManagerView } from '@/components/Skill'
import { PluginManagerView } from '@/components/Plugin'
import { MescliPackageManagerView } from '@/components/MescliPackage'
import { McpMarketView } from '@/components/McpMarket'
import { useCorridorStore } from '@/stores/corridorStore'
import { useMcpMarketStore } from '@/stores/mcpMarketStore'
import { useChatStore } from '@/stores/chatStore'
import { useConversationStore } from '@/stores/conversationStore'
import { ArtifactDock } from '@/components/chat/ArtifactDock'
import { useArtifactDockStore } from '@/stores/artifactDockStore'
import { BrowseDirectoryWindow } from '@/components/Browse/BrowseDirectoryWindow'
import { useBrowseDirectoryStore } from '@/stores/browseDirectoryStore'
import { MemoryDock } from '@/components/Memory/MemoryDock'
import { CapsuleTooltip } from '@/components/common/CapsuleTooltip'
import { useMemoryDockStore } from '@/stores/memoryDockStore'
import { BrowserPanel } from '@/components/Browser'
import { useCommercialNoticeStore } from '@/stores/commercialNoticeStore'
import { usePermissionStore } from '@/stores/permissionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useAdminStore } from '@/stores/adminStore'
import { useKnowledgeNavigationStore } from '@/stores/knowledgeNavigationStore'
import { useDevModeUnlock } from '@/hooks/useDevModeUnlock'
import { FEATURE_FLAGS } from '@/config/product'
import { Lock, AlertTriangle, Wrench } from 'lucide-react'

const KnowledgeWorkspace = lazy(() => import('@/components/Knowledge/KnowledgeWorkspace'))

const VIEW_FEATURES: Record<string, string | undefined> = {
  chat: FEATURE_FLAGS.chat,
  memory: FEATURE_FLAGS.memory,
  'agent-swarm': FEATURE_FLAGS.agentSwarm,
  cron: FEATURE_FLAGS.cronScheduler,
  skill: FEATURE_FLAGS.skill,
  plugin: FEATURE_FLAGS.plugin,
  'mescli-packages': undefined,
  settings: undefined,
}

export function MainLayout() {
  const { t } = useTranslation()
  const [activeView, setActiveView] = useState('chat')
  const [isCollapsed, setIsCollapsed] = useState(false)
  // 【Iris 2026-09】LoginModal 与登录入口已随登录体系删除——本地个人版无登录态概念
  const [guardMessage, setGuardMessage] = useState<string | null>(null)
  const [knowledgeEnabled, setKnowledgeEnabled] = useState(false)
  const permissions = usePermissionStore((s) => s.permissions)
  const commercialNotice = useCommercialNoticeStore((s) => s.notice)
  const dismissCommercialNotice = useCommercialNoticeStore((s) => s.dismiss)

  // 仅探测轻量 capability；完整知识工作区与其 CSS/Markdown 渲染器保持 lazy-load。
  useEffect(() => {
    let active = true
    void import('@/api/knowledgeApi')
      .then(({ knowledgeApi }) => knowledgeApi.capabilities())
      .then((capabilities) => { if (active) setKnowledgeEnabled(capabilities.enabled) })
      .catch(() => { if (active) setKnowledgeEnabled(false) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!knowledgeEnabled && activeView === 'knowledge') setActiveView('chat')
  }, [activeView, knowledgeEnabled])

  // 走廊（能力页蓝图 v12「两个房间，一条走廊」）：对话=常驻基底层永不卸载，
  // 能力房=覆盖层从右滑入全覆盖主舞台（对话退后作底层视差，打开后即被完全遮住）；
  // 回家路径=左缘「‹ 返回对话」竖排胶囊（蓝图 .corridor-hint）/ Esc / 侧栏"对话"。
  // 动画内核=纯 transform/opacity/filter（零 reflow），卸载延迟 520ms 播完滑出。
  // 进出不对称设计（2026-08-08 滑出死时间修复 + 入场丢失修复）：
  // - 入场=keyframes（wfCapIn/wfHintIn）：从非对话视图开走廊时整个舞台新挂载，
  //   重挂载下 mount 与 cap-open 翻转会同帧提交，transition 出生即终态（入场丢失）；
  //   keyframes 元素插入即播、免疫同帧提交。两帧法仍保留——它决定 cap-open 何时翻转
  //   （keyframes 随翻转开播 + 对话房退后 transition 需要先有 103% 的挂载帧）；
  // - 出场=渲染直接联动：cap-open 条件含 corridorOpen，点击当帧 render 即摘 class、
  //   滑出零死时间。若走 effect 中转（旧写法 setCapAnimOpen(false)），zustand→render→
  //   paint→effect→render 链会白白多出 ~150-200ms 死时间，用户视角=点了没反应。
  const corridorOpen = useCorridorStore((s) => s.isOpen)
  const [capRoomMounted, setCapRoomMounted] = useState(corridorOpen)
  const [capAnimOpen, setCapAnimOpen] = useState(corridorOpen)
  useEffect(() => {
    if (corridorOpen) {
      setCapRoomMounted(true)
      let raf2 = 0
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setCapAnimOpen(true))
      })
      return () => {
        cancelAnimationFrame(raf1)
        cancelAnimationFrame(raf2)
      }
    }
    setCapAnimOpen(false) // 复位入场旗，下次打开重新走两帧法（出场本身由 render 直接联动）
    if (!capRoomMounted) return
    const timer = setTimeout(() => setCapRoomMounted(false), 520)
    return () => clearTimeout(timer)
  }, [corridorOpen, capRoomMounted])

  // Esc 层栈（谁顶谁吃）：能力房内打量面板开 → 先关面板；否则关走廊。
  // 只在走廊打开时挂监听，避免与对话内既有 Esc 消费者（斜杠菜单/分支等）冲突。
  useEffect(() => {
    if (!corridorOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const market = useMcpMarketStore.getState()
      if (market.detailName) market.closeDetail()
      else useCorridorStore.getState().close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [corridorOpen])

  // 设置覆盖层（2026-08-11 设置页重构：activeView 分支→全覆盖层，对话不卸载）。
  // plain mount/unmount 无大动画（用户拍板：系统级动效关闭，滑入编排不做）。
  const settingsOpen = useSettingsOverlayStore((s) => s.isOpen)
  const openSettings = useCallback(() => {
    useCorridorStore.getState().close() // 与走廊互斥
    useSettingsOverlayStore.getState().open()
  }, [])

  // 数据安全网关仪表盘（第三层，2026-08-11）：从设置卡「查看详情」进入，覆盖在设置层之上。
  // Esc 层栈：网关开着时先关网关（设置层监听让位），再关设置。
  // stopImmediatePropagation：网关在设置之上，Esc 只关网关；设置层监听靠 isOpen 前置判断让位，
  // 双保险确保一次 Esc 不同帧关两层（网关监听后注册也只会停在网关这一层）。
  const gatewayOpen = useSecurityGatewayViewStore((s) => s.isOpen)
  useEffect(() => {
    if (!gatewayOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      useSecurityGatewayViewStore.getState().close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [gatewayOpen])

  // Esc 层栈加层：设置开着时 Esc 关设置（谁顶谁吃；与走廊 Esc 互斥，不会同时激活）
  useEffect(() => {
    if (!settingsOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 网关层在设置之上：Esc 先关网关，不落到设置
      if (useSecurityGatewayViewStore.getState().isOpen) return
      useSettingsOverlayStore.getState().close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [settingsOpen])

  // 开发者选项解锁：全局监听 ` 键连按 5 次；解锁瞬间给出底部提示
  useDevModeUnlock()
  // 管理员提权态：启动时恢复未过期 token / 清理过期 token
  useEffect(() => {
    useAdminStore.getState().clearExpired()
  }, [])
  const devModeUnlocked = useSettingsStore((s) => s.devModeUnlocked)
  const [showDevUnlockToast, setShowDevUnlockToast] = useState(false)
  const prevDevModeRef = useRef(devModeUnlocked)
  useEffect(() => {
    if (devModeUnlocked && !prevDevModeRef.current) {
      setShowDevUnlockToast(true)
      const timer = setTimeout(() => setShowDevUnlockToast(false), 4000)
      return () => clearTimeout(timer)
    }
    prevDevModeRef.current = devModeUnlocked
  }, [devModeUnlocked])

  const canNavigateTo = useCallback((view: string): { allowed: boolean; reason?: string } => {
    const feature = VIEW_FEATURES[view]
    if (!feature) return { allowed: true }
    // 【Iris 2026-09】License/额度闸已随付费体系删除——按后端权限过滤
    if (permissions && !permissions.features.includes(feature)) {
      return { allowed: false, reason: t('layout.gate.noFeaturePermission') }
    }
    return { allowed: true }
  }, [permissions, t])

  const handleNavigate = useCallback(
    (view: string) => {
      // 设置不再是视图：入口（对话页"管理 API 配置"等旧调用方）统一转覆盖层
      if (view === 'settings') {
        openSettings()
        return
      }
      // 记忆不再是独立页面：侧栏入口打开对话平面的记忆抽屉（2026-07-30 记忆可视化重构）
      if (view === 'memory') {
        setActiveView('chat')
        useMemoryDockStore.getState().open()
        return
      }
      // 文件浏览不是视图：侧栏入口开合浮层窗口（2026-09-04 浏览目录面板拍板形态），
      // 当前视图/对话状态一律不动
      if (view === 'browse') {
        useBrowseDirectoryStore.getState().toggle()
        return
      }
      // 能力页不是独立视图：走廊覆盖层（v12）。不在对话视图时先回对话再开走廊——
      // 走廊的语义基座是对话房，其他视图没有"隔壁房间"的叙事
      if (view === 'mcp-market') {
        useSettingsOverlayStore.getState().close() // 走廊与设置层互斥（两个全覆盖层不叠加）
        setActiveView('chat')
        useCorridorStore.getState().open()
        return
      }
      const { allowed, reason } = canNavigateTo(view)
      if (allowed) {
        setGuardMessage(null)
        if (view === 'knowledge') {
          const dock = useArtifactDockStore.getState()
          if (dock.isOpen && !dock.currentArtifactId) dock.close()
        }
        // 任何导航都收走廊（能力房全覆盖后，点侧栏"对话"是主要回家路径——
        // 此前 view==='chat' 分支不关，全覆盖后用户会被困在能力房只剩 Esc）
        useCorridorStore.getState().close()
        setActiveView(view)
      } else {
        setGuardMessage(reason || t('layout.gate.fallback'))
        setTimeout(() => setGuardMessage(null), 3000)
      }
    },
    [canNavigateTo, openSettings]
  )

  const pendingKnowledgeCitation = useKnowledgeNavigationStore((state) => state.pendingCitation)
  useEffect(() => {
    if (pendingKnowledgeCitation && knowledgeEnabled) handleNavigate('knowledge')
  }, [handleNavigate, knowledgeEnabled, pendingKnowledgeCitation])

  // 定时任务执行结果落库为会话 → 行内「查看结果」直达该会话（2026-08-08 闭环最后一步）。
  // 2026-09-04 会话后台化：detach/attach 取代 stopStreaming——切走不杀正在跑的 loop。
  const handleOpenConversation = useCallback((id: number) => {
    useCorridorStore.getState().close()
    setActiveView('chat')
    const chat = useChatStore.getState()
    if (id !== useConversationStore.getState().currentConversationId) {
      chat.detachConversationView()
    }
    chat.attachConversationView(id)
  }, [])

  const renderView = () => {
    switch (activeView) {
      case 'chat':
        return <ChatView onNavigate={handleNavigate} knowledgeEnabled={knowledgeEnabled} />
      case 'memory':
        return <MemoryManagerView />
      case 'agent-swarm':
        return <AgentSwarmView />
      case 'cron':
        return <CronSchedulerView onOpenConversation={handleOpenConversation} />
      case 'skill':
        return <SkillManagerView />
      case 'plugin':
        return <PluginManagerView />
      case 'mescli-packages':
        return <MescliPackageManagerView />
      case 'knowledge':
        return (
          <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-slate-500">{t('layout.loadingKnowledgeWorkspace')}</div>}>
            <KnowledgeWorkspace />
          </Suspense>
        )
      // 设置已迁覆盖层（SettingsOverlay），不再是 activeView 分支
      default:
        return <ChatView />
    }
  }

  // 对话房元素记忆化（2026-08-08 滑出延迟修复）：走廊开合会让 MainLayout 重渲染，
  // 非 memo 的 ChatView 整树跟着重渲染（dev 下 ~100ms），滑出动画被拖到第三帧才开始——
  // 元素身份不变则 reconciler 跳过整棵子树，走廊交互 render 保持 <1 帧。
  // ChatView 内部靠 store 订阅自更新，父级 memo 不影响其数据新鲜度。
  const chatElement = useMemo(
    () => <ChatView onNavigate={handleNavigate} knowledgeEnabled={knowledgeEnabled} />,
    [handleNavigate, knowledgeEnabled]
  )

  return (
    <div className="flex h-screen w-screen overflow-hidden wf-chat-bg" style={{ '--wf-sidebar-width': isCollapsed ? '56px' : '248px' } as React.CSSProperties}>
      <Sidebar
        activeView={corridorOpen ? 'mcp-market' : settingsOpen ? 'settings' : activeView}
        onNavigate={handleNavigate}
        isCollapsed={isCollapsed}
        onToggleCollapse={() => setIsCollapsed(!isCollapsed)}
        onOpenSettings={openSettings}
        knowledgeEnabled={knowledgeEnabled}
      />
      <main className="ww-app-main flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {guardMessage && (
          <div className="absolute top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 px-4 py-2 bg-[var(--wf-warn-bg)] border-b border-[var(--wf-warn-line)] text-[var(--wf-warn-ink)] text-xs">
            <Lock size={14} />
            {guardMessage}
          </div>
        )}
        {commercialNotice && (
          <div className="absolute top-0 left-0 right-0 z-50 flex items-center justify-between gap-2 px-4 py-2 bg-[var(--wf-err-bg)] border-b border-[var(--wf-err-line)] text-[var(--wf-err-ink)] text-xs">
            <div className="flex items-center gap-2">
              <AlertTriangle size={14} />
              {commercialNotice.message}
            </div>
            <button
              onClick={dismissCommercialNotice}
              className="text-[var(--wf-err-ink)] hover:text-[var(--wf-err-ink)] font-medium"
            >
              {t('layout.acknowledge')}
            </button>
          </div>
        )}
        <div className="ww-main-workspace">
          <div className="ww-main-content">
            {activeView === 'chat' ? (
              /* 对话房 + 走廊舞台（v12）：ChatView 常驻不卸载，流式/滚动/草稿存续白捡 */
              <div className={cn('wf-stage', corridorOpen && capAnimOpen && 'cap-open')}>
                <div className="wf-room-conv">{chatElement}</div>
                {capRoomMounted && (
                  <>
                    <div className="wf-room-cap">
                      <McpMarketView />
                    </div>
                    {/* 蓝图 .corridor-hint：能力房全覆盖后的回家小按钮（左缘竖排胶囊，随 cap-open 淡入） */}
                    <button
                      className="wf-corridor-hint"
                      onClick={() => useCorridorStore.getState().close()}
                    >
                      ‹ {t('corridor.backToChat')}
                    </button>
                  </>
                )}
              </div>
            ) : (
              renderView()
            )}
          </div>
          <BrowserPanel />
        </div>
      </main>
      <SettingsOverlay />
      <SecurityGatewayView />
      {showDevUnlockToast && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 bg-[var(--wf-capsule-bg)] text-[var(--wf-capsule-ink)] text-sm rounded-lg shadow-lg">
          <Wrench size={14} />
          {t('layout.devModeUnlocked')}
        </div>
      )}
      <ArtifactDock />
      <MemoryDock />
      <BrowseDirectoryWindow />
      {/* 全局胶囊停留显示：拦截所有原生 title 提示统一渲染（最顶层，无状态） */}
      <CapsuleTooltip />
    </div>
  )
}
