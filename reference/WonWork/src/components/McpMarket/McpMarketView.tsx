import { useTranslation } from 'react-i18next'
import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { cn } from '@/utils'
import { useMcpMarketStore } from '@/stores/mcpMarketStore'
import { useCorridorStore } from '@/stores/corridorStore'
import { useChatStore } from '@/stores/chatStore'
import { mcpMarketApi, type McpEnvVarDecl, type McpMarketCard, type McpRuntimeInfo, type McpServerStatus } from '@/api/mcpMarketApi'
import { McpAppHost } from '@/mcp/apps/McpAppHost'
import { McpPackageImportPanel } from './McpPackageImportPanel'
import {
  Search,
  RefreshCw,
  AlertCircle,
  AlertTriangle,
  CloudOff,
  Package,
  X,
  ExternalLink,
  ChevronDown,
  ShieldAlert,
  Trash2,
  CheckCircle2,
  KeyRound,
  Undo2,
} from 'lucide-react'

/**
 * 能力房（能力页蓝图 v12「两个房间，一条走廊」，2026-08-07）：
 * 对话的隔壁房间——作为走廊覆盖层住在 MainLayout 的 .wf-room-cap 里，对话退后成左走廊。
 * 用户世界里没有「MCP」这个词，只有「能力」：发现间=货架（卡片网格真自适应），
 * 管理间=我的能力（行式列表，与对话列表共用阅读肌肉）。
 *
 * 视觉=蓝图原型 v12 温润卡片式（2026-08-07 用户拍板，底线无边框设计已全面抛弃）：
 * 暖墨四阶（底 #f7f7f5/卡 #fff/线 #e6e4df/文 #1a1d23·#5b6270·#9aa0ad），唯一蓝强调 #2563eb，
 * 盒卡 14px 圆角+双层暖阴影，输入描边盒式，档案与行同卡虚线分隔。
 *
 * 丝滑纪律（2026-08-08 三轮打磨）：
 * - 即时反应：点卡=抽屉带货架快照即时出内容（detail 在途只骨架凭据区）；开关/删除乐观先行
 * - 几何连续：两间常驻不卸载（hidden 切换，滚动/展开态存续）；骨架与真内容同形同位；
 *   抽屉承诺脚常驻锚定；行删除先退场动画落完再真删；抽屉卸载延迟 ≥ 滑出时长
 * - 诚实：等待只用假流动承担过程感（微光轨），状态翻转永远由真实数据收尾；
 *  「对话中」chip 从对话真实在执的 mcp__ 工具调用派生，不是装饰
 * - 安静：堆叠动效简化（卡底接线层已删，微光轨是接通态唯一动效信号）；
 *   全页动画 ≤.5s，无轮询
 * 设计文档：learn/05/strategy/Kimi_Agent_蓝图优化建议/wonwork-能力页蓝图-v12.md
 */

/** stdio 分发形态 → 所需运行时命令（与后端 McpMarketService/RuntimeProbe 同口径） */
const REGISTRY_TYPE_COMMAND: Record<string, string> = { pypi: 'uvx', nuget: 'dnx', oci: 'docker' }
const INSTALLABLE_REGISTRY_TYPES = ['npm', 'pypi', 'nuget', 'oci']

/** registry 全名 → 缺省实例名（与后端安装翻译同口径：末段 sanitize 禁 __） */
function suggestedServerName(registryName: string): string {
  return (registryName.split('/').pop() ?? '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/__/g, '_')
}

/** 工具线名 → 展示名：剥掉 mcp__<server>__ 前缀（行/档案里上下文已给出归属） */
function displayToolName(wireName: string): string {
  return wireName.replace(/^mcp__.+?__/, '')
}

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

export function McpMarketView() {
  const { t } = useTranslation()
  // 窄订阅（2026-08-08 抽屉滑出延迟修复）：整店订阅会让任何 store 变化都重渲染根组件
  // （含货架网格），抽屉开合动画被重渲染拖到第三帧；拆成选择器订阅+tab 内容 memo 后，
  // 抽屉开合只重渲染抽屉子树（InstalledList/MarketBrowser 内部自带 store 订阅，数据不陈化）
  const detailName = useMcpMarketStore((s) => s.detailName)
  const closeDetail = useMcpMarketStore((s) => s.closeDetail)
  const loadServers = useMcpMarketStore((s) => s.loadServers)
  const servers = useMcpMarketStore((s) => s.servers)
  const hasSearched = useMcpMarketStore((s) => s.hasSearched)
  const search = useMcpMarketStore((s) => s.search)
  const tab = useCorridorStore((s) => s.tab)
  const setTab = useCorridorStore((s) => s.setTab)
  const focusName = useCorridorStore((s) => s.focusName)

  // 挂载时拉一次已安装列表（一次性，非常驻轮询）：tab 计数与市场卡「已学会」态需要它
  useEffect(() => {
    void loadServers()
  }, [loadServers])

  useEffect(() => {
    if (tab === 'manage') void loadServers()
  }, [tab, loadServers])

  // 发现间首访自动浏览全量（2026-08-08）：此前货架首访是空壳、必须用户先打字才有内容，
  // 蓝图=货架照常打开；search 同步置 hasSearched，不会重复触发
  useEffect(() => {
    if (tab === 'discover' && !hasSearched) void search('')
  }, [tab, hasSearched, search])

  // 打开协议意图：focusName=直达该能力的打量面板（触点②预埋），消费后立即清除
  const openDetail = useMcpMarketStore((s) => s.openDetail)
  useEffect(() => {
    if (!focusName) return
    void openDetail(focusName)
    useCorridorStore.getState().clearFocus()
  }, [focusName, openDetail])

  // 抽屉双向动画：detailName 清空后保留渲染 320ms 播滑出，再卸载。
  // 进出不对称（同 MainLayout 走廊 2026-08-08）：入场=两帧法（双 rAF 翻 drawerOpen）；
  // 出场=渲染直接联动（滑移条件含 detailName，点击当帧即播滑出，不经 effect 中转——
  // 否则 zustand→render→paint→effect→render 链多出 ~150-200ms 死时间）。
  const [renderName, setRenderName] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [showPackageImport, setShowPackageImport] = useState(false)
  useEffect(() => {
    if (detailName) {
      setRenderName(detailName)
      if (!drawerOpen) {
        let raf2 = 0
        const raf1 = requestAnimationFrame(() => {
          raf2 = requestAnimationFrame(() => setDrawerOpen(true))
        })
        return () => {
          cancelAnimationFrame(raf1)
          cancelAnimationFrame(raf2)
        }
      }
    } else {
      setDrawerOpen(false) // 复位入场旗（出场动画本身由 render 直接联动）
      // 卸载延迟必须 ≥ 滑出时长（380ms）——此前 320ms 会把最后 60ms 的滑移直接裁掉
      const timer = setTimeout(() => setRenderName(null), 400)
      return () => clearTimeout(timer)
    }
  }, [detailName, drawerOpen])

  // 页签滑动下划线：跟随激活页签的 left/width
  const manageTabRef = useRef<HTMLButtonElement>(null)
  const discoverTabRef = useRef<HTMLButtonElement>(null)
  const [indicator, setIndicator] = useState({ left: 0, width: 0 })
  useLayoutEffect(() => {
    const el = tab === 'manage' ? manageTabRef.current : discoverTabRef.current
    if (el) setIndicator({ left: el.offsetLeft, width: el.offsetWidth })
  }, [tab, servers.length])

  /** 页签 bump（微光落点反馈）：重挂 class 重启动画 */
  const bumpManageTab = () => {
    const el = manageTabRef.current
    if (!el || reducedMotion()) return
    el.classList.remove('wf-tab-bump')
    void el.offsetWidth
    el.classList.add('wf-tab-bump')
  }

  /**
   * 微光所有权转移（v12 验收 #6）：一粒微光从市场卡片抛物线飞入「我的能力」页签。
   * 卡片找不到（搜索词已变等）时静默降级为纯 bump+toast——动效是叙事，不是功能。
   */
  const flySpark = (registryName: string) => {
    bumpManageTab()
    if (reducedMotion()) return
    const card = document.querySelector(`.wf-room-cap [data-cap-card="${CSS.escape(registryName)}"]`)
    const tabEl = manageTabRef.current
    if (!card || !tabEl) return
    const r1 = card.getBoundingClientRect()
    const r2 = tabEl.getBoundingClientRect()
    const spark = document.createElement('div')
    spark.className = 'wf-spark'
    spark.style.left = `${r1.left + r1.width / 2}px`
    spark.style.top = `${r1.top + r1.height / 2}px`
    document.body.appendChild(spark)
    const dx = r2.left + r2.width / 2 - (r1.left + r1.width / 2)
    const dy = r2.top + r2.height / 2 - (r1.top + r1.height / 2)
    spark.animate(
      [
        { transform: 'translate(0,0) scale(1)', opacity: 1 },
        { transform: `translate(${dx * 0.45}px,${dy - 70}px) scale(.8)`, opacity: 0.9, offset: 0.55 },
        { transform: `translate(${dx}px,${dy}px) scale(.4)`, opacity: 0 },
      ],
      { duration: 850, easing: 'cubic-bezier(.3,.6,.3,1)' }
    ).onfinish = () => {
      spark.remove()
      bumpManageTab()
    }
  }

  /**
   * 安装成功闭环（v12 §4.3）：面板滑走 → 货架卡片变「已学会」（loadServers 落定后自然翻转）
   * → 微光飞入页签（计数 +1）→ toast 带「回到对话直接用」动作（关走廊+聚焦对话框）。
   */
  const handleInstalled = (registryName: string, serverName: string) => {
    closeDetail()
    // 等面板滑出再起飞，微光起点（卡片）不被面板遮挡
    setTimeout(() => flySpark(registryName), 260)
    toast.success(t('mcpMarket.installSuccess', { name: serverName }), {
      duration: 5200,
      action: {
        label: t('mcpMarket.backToChatAction'),
        onClick: () => {
          const corridor = useCorridorStore.getState()
          corridor.close()
          corridor.prefillComposer('')
        },
      },
    })
  }

  return (
    <div className="flex flex-col h-full bg-[var(--wf-bg)]">
      {/* 滚动容器 = 房间头 + 内容（scrollbar-gutter 治理 2026-08-08）：房间头 sticky 住进
          滚动容器，与内容同受 both-edges 滚动槽约束——若头留在外面，滚动条出现时内容列
          收窄而头不收窄，头身边缘左右错位；同住一槽则恒对齐（.wf-chat-scroll 同款先例） */}
      <div className="flex-1 overflow-y-auto wf-room-scroll">
        {/* 房间头：标题叙事 + 下划线页签（管理间/发现间）+ 右槽按 tab 切换 搜索/刷新 */}
        <div className="sticky top-0 z-10 bg-[var(--wf-bg)] max-w-[1200px] w-full mx-auto px-8 pt-7">
          {/* 字体阶统一（2026-08-08）：20/700 房标题 · 16/700 抽屉名 · 14/600 条目名与CTA ·
              13/400 正文（副标题/页签/抽屉描述）· 12/400 辅助（状态/meta/卡描述/小按钮）·
              11 微标签（段标/chip/计数，mono 只用于技术串）——不再用 13.5/11.5/10.8 零碎值 */}
          <h1 className="text-[20px] font-bold text-[var(--wf-ink)]">{t('mcpMarket.title')}</h1>
          <p className="text-[13px] text-[var(--wf-mut)] mt-1 mb-5">{t('mcpMarket.subtitle')}</p>
          <div className="flex items-end justify-between gap-4 border-b border-[var(--wf-line)]">
            <div className="relative flex gap-6">
              <button
                ref={manageTabRef}
                onClick={() => setTab('manage')}
                className={cn(
                  'pb-2 text-[13px] transition-colors duration-200',
                  tab === 'manage' ? 'text-[var(--wf-accent)] font-semibold' : 'text-[var(--wf-mut)] hover:text-[var(--wf-ink)]'
                )}
              >
                {t('mcpMarket.tabManage')}
                <span className="font-mono text-[11px] ml-1 opacity-70">{servers.length}</span>
              </button>
              <button
                ref={discoverTabRef}
                onClick={() => setTab('discover')}
                className={cn(
                  'pb-2 text-[13px] transition-colors duration-200',
                  tab === 'discover' ? 'text-[var(--wf-accent)] font-semibold' : 'text-[var(--wf-mut)] hover:text-[var(--wf-ink)]'
                )}
              >
                {t('mcpMarket.tabDiscover')}
              </button>
              {/* 滑动下划线：3px 高、向下多探 1.5px——须以 ≥0.5px 余量盖住容器的 1px 分隔线，
                  旧版 2px/-1px 是零余量覆盖，分数像素（125%/150% 系统缩放）下灰线从蓝条底下
                  漏出一条细影，看上去像"背后隐约有个矩形"（2026-08-08 用户实测） */}
              <i
                className="absolute -bottom-[1.5px] h-[3px] rounded-full bg-[var(--wf-accent)] transition-all duration-300"
                style={{ left: indicator.left, width: indicator.width, transitionTimingFunction: 'cubic-bezier(.32,.72,.24,1)' }}
              />
            </div>
            <div className="flex items-center gap-2 pb-1.5">
              {tab === 'discover' ? (
                <MarketSearch />
              ) : (
                <>
                  <button className="wf-mini-btn" onClick={() => setShowPackageImport(true)}>
                    <Package size={12} />
                    导入 MCP
                  </button>
                  <InstalledRefresh />
                </>
              )}
            </div>
          </div>
        </div>

        {/* 两间常驻不卸载（2026-08-08，对齐原型 hidden 切换）：此前 tabContent memo 互斥
            挂载，切 tab=整树重挂——滚动位置丢失、货架 stagger 每次重播、管理间展开态被清；
            常驻后切换只是 hidden 翻转，两列表内部各自订阅 store，数据照常新鲜 */}
        <div className={cn('max-w-[1200px] mx-auto px-8 py-6', tab !== 'manage' && 'hidden')}>
          <InstalledList />
        </div>
        <div className={cn('max-w-[1200px] mx-auto px-8 py-6', tab !== 'discover' && 'hidden')}>
          <MarketBrowser />
        </div>
      </div>

      {/* 打量面板（详情与安装同一面板，双向滑动画）：absolute 住进能力房内部
          （蓝图 .panel 同构）——遮罩只盖房间不盖全屏，侧栏与房间同框，消除割裂感；
          面板打开时 Esc/遮罩先关面板，层栈见 MainLayout） */}
      {renderName && (
        <div className="absolute inset-0 z-50">
          <div
            className={cn(
              'absolute inset-0 bg-black/20 transition-opacity duration-300',
              detailName && drawerOpen ? 'opacity-100' : 'opacity-0'
            )}
            onClick={closeDetail}
          />
          <div
            className={cn(
              'absolute inset-y-0 right-0 w-full max-w-[26rem] bg-[var(--wf-card-bg)] border-l border-[var(--wf-line)] flex flex-col transition-transform ease-out',
              detailName && drawerOpen ? 'translate-x-0' : 'translate-x-full'
            )}
            style={{
              boxShadow: '-16px 0 40px rgba(20,20,30,.10)',
              transitionDuration: '380ms',
              transitionTimingFunction: 'cubic-bezier(.32,.72,.24,1)',
            }}
          >
            {/* key=renderName：切换 server 时表单态整体重置 */}
            <DrawerPanel key={renderName} name={renderName} onInstalled={handleInstalled} />
          </div>
        </div>
      )}

      {showPackageImport && (
        <McpPackageImportPanel
          existingNames={servers.map((server) => server.name)}
          onClose={() => setShowPackageImport(false)}
          onInstalled={async (result) => {
            await loadServers()
            toast.success(`${result.serverName} 已安装并连接`)
          }}
        />
      )}
    </div>
  )
}

// ==================== 页签右槽 ====================

/** 发现间搜索（描边盒式）：防抖 400ms 自动搜索；空查询=浏览全量 */
function MarketSearch() {
  const { t } = useTranslation()
  const query = useMcpMarketStore((s) => s.query)
  const search = useMcpMarketStore((s) => s.search)
  const [input, setInput] = useState(query)

  useEffect(() => {
    const timer = setTimeout(() => {
      if (input !== query) void search(input)
    }, 400)
    return () => clearTimeout(timer)
  }, [input, query, search])

  return (
    <div className="relative w-56">
      <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--wf-mut)] pointer-events-none" />
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={t('mcpMarket.searchPlaceholder')}
        className="wf-ink-input pl-8"
      />
    </div>
  )
}

function InstalledRefresh() {
  const { t } = useTranslation()
  const isLoadingServers = useMcpMarketStore((s) => s.isLoadingServers)
  const loadServers = useMcpMarketStore((s) => s.loadServers)
  return (
    <button className="wf-mini-btn" onClick={() => loadServers()}>
      <RefreshCw size={12} className={cn(isLoadingServers && 'animate-spin')} />
      {t('mcpMarket.refresh')}
    </button>
  )
}

// ==================== 发现间（货架=卡片网格） ====================

function MarketBrowser() {
  const { t } = useTranslation()
  // 窄订阅（2026-08-08）：整店订阅会让搜索输入/抽屉开合都重渲染整个货架网格
  const items = useMcpMarketStore((s) => s.items)
  const nextCursor = useMcpMarketStore((s) => s.nextCursor)
  const isSearching = useMcpMarketStore((s) => s.isSearching)
  const isLoadingMore = useMcpMarketStore((s) => s.isLoadingMore)
  const upstreamDown = useMcpMarketStore((s) => s.upstreamDown)
  const searchError = useMcpMarketStore((s) => s.searchError)
  const hasSearched = useMcpMarketStore((s) => s.hasSearched)
  const loadMore = useMcpMarketStore((s) => s.loadMore)
  const openDetail = useMcpMarketStore((s) => s.openDetail)
  const servers = useMcpMarketStore((s) => s.servers)
  const goManage = useCorridorStore((s) => s.goManage)

  // 已学会的货架卡可感知地区别（v12 留白问题 5）：按缺省实例名匹配——
  // 自定义实例名安装的卡匹配不上，降级为普通卡（启发式，不阻断任何流程）
  const installedNames = useMemo(() => new Set(servers.map((s) => s.name)), [servers])
  const isLearned = (card: McpMarketCard) => installedNames.has(suggestedServerName(card.name))

  return (
    <div>
      {searchError && (
        <p className="flex items-center gap-1.5 text-xs text-[var(--wf-err-ink)] mb-4">
          <AlertCircle size={13} className="flex-none" />
          {searchError}
        </p>
      )}
      {upstreamDown ? (
        <div className="flex flex-col items-center justify-center py-24 text-[var(--wf-mut)] gap-2">
          <CloudOff size={40} className="text-[var(--wf-faint)]" />
          <p className="text-[13px] text-[var(--wf-sub)]">{t('mcpMarket.upstreamDown')}</p>
          <p className="text-xs">{t('mcpMarket.upstreamDownHint')}</p>
        </div>
      ) : isSearching && items.length === 0 ? (
        /* 首载骨架（几何与真卡一致）：此前居中转圈→网格闪现，骨架让内容"长出来"而不是"跳出来" */
        <div className="wf-card-grid">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="wf-skel-card" style={{ animationDelay: `${i * 90}ms` }} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-[var(--wf-mut)] gap-2">
          <Package size={40} className="text-[var(--wf-faint)]" />
          <p className="text-[13px] text-[var(--wf-sub)]">{hasSearched ? t('mcpMarket.noResult') : t('mcpMarket.idleHint')}</p>
        </div>
      ) : (
        <>
          {/* 搜索中旧结果降透明（几何不变的静信号）：此前再搜索无任何反馈，然后整格硬换 */}
          <div
            className={cn(
              'wf-card-grid transition-opacity duration-200',
              isSearching && 'opacity-50 pointer-events-none'
            )}
          >
            {items.map((card, i) => (
              <MarketCard
                key={card.name}
                card={card}
                index={i}
                learned={isLearned(card)}
                onClick={() =>
                  isLearned(card) ? goManage(suggestedServerName(card.name)) : openDetail(card.name, card)
                }
              />
            ))}
          </div>
          {nextCursor && (
            <div className="flex justify-center mt-6">
              <button onClick={() => loadMore()} disabled={isLoadingMore} className="wf-mini-btn">
                {isLoadingMore && <RefreshCw size={12} className="animate-spin" />}
                {t('mcpMarket.loadMore')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** 货架卡：蓝软图标块 + 人读名 + mono 全名（异名才显示）+ 描述两行 + meta 纯文字
 * （唯一色彩=未验证琥珀）；已学会：整卡降饱和 + 绿点「已学会 · 去管理」（点击直达管理间展开该行） */
function MarketCard({
  card,
  index,
  learned,
  onClick,
}: {
  card: McpMarketCard
  index: number
  learned: boolean
  onClick: () => void
}) {
  const { t } = useTranslation()
  const title = card.title || card.name.split('/').pop()
  const showFullName = Boolean(card.title) && card.title !== card.name.split('/').pop()

  const meta: React.ReactNode[] = []
  if (card.runModes.includes('http')) meta.push(t('mcpMarket.modeRemote'))
  if (card.runModes.includes('stdio')) meta.push(t('mcpMarket.modeLocal'))
  if (card.version) meta.push(`v${card.version}`)
  if (card.requiredEnvCount > 0) meta.push(t('mcpMarket.needsCredential'))

  return (
    <button
      onClick={onClick}
      data-cap-card={card.name}
      className="wf-card text-left p-4 flex flex-col"
      style={{
        animationDelay: `${Math.min(index, 10) * 40}ms`,
        ...(learned ? { filter: 'saturate(.72)' } : undefined),
      }}
    >
      <div className="wf-card-icon">
        <Package size={18} />
      </div>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-[var(--wf-ink)] truncate">{title}</h3>
        {showFullName && <p className="text-xs text-[var(--wf-mut)] font-mono truncate mt-0.5">{card.name}</p>}
      </div>
      <p className="text-xs text-[var(--wf-sub)] mt-1.5 line-clamp-2 min-h-[2rem]">{card.description}</p>
      <p className="text-xs text-[var(--wf-mut)] mt-2.5 flex items-center gap-1.5 flex-wrap">
        {meta.map((m, i) => (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-[var(--wf-faint)]">·</span>}
            {m}
          </span>
        ))}
      </p>
      {learned && (
        <p className="flex items-center gap-1.5 text-xs text-[var(--wf-ok-ink)] mt-2">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--wf-ok-ink)] flex-none" />
          {t('mcpMarket.learnedGoManage')}
        </p>
      )}
    </button>
  )
}

// ==================== 打量面板（详情 + 安装） ====================

/**
 * 打量面板（蓝图 .panel 三段式）：面板头（蓝软图标块+名+一行）→ 滚动正文（它是什么/
 * 信任一句/运行时提示/凭据声明）→ 钉底承诺脚（promise 按钮+高级选项小字折叠）。
 * 安装是轻决策：prefer/serverName 两个技术选项后退到高级选项（默认值即正确答案）；
 * 可见域不暴露（2026-08-07 用户拍板：默认全域，域是部署/路由概念，不给用户增加心智负担）。
 * 承诺按钮是整个流程唯一的高强调实心色块，钉在面板脚不随正文滚动（蓝图 .p-foot）。
 */
function DrawerPanel({
  name,
  onInstalled,
}: {
  name: string
  onInstalled: (registryName: string, serverName: string) => void
}) {
  const { t } = useTranslation()
  const detail = useMcpMarketStore((s) => s.detail)
  const detailSnapshot = useMcpMarketStore((s) => s.detailSnapshot)
  const isLoadingDetail = useMcpMarketStore((s) => s.isLoadingDetail)
  const closeDetail = useMcpMarketStore((s) => s.closeDetail)
  const install = useMcpMarketStore((s) => s.install)

  const [prefer, setPrefer] = useState<'auto' | 'http' | 'stdio'>('auto')
  const [serverName, setServerName] = useState('')
  const [envValues, setEnvValues] = useState<Record<string, string>>({})
  const [headerValues, setHeaderValues] = useState<Record<string, string>>({})
  const [isInstalling, setIsInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)

  // 当前安装形态将用到的 env / headers 声明与所需运行时（与后端翻译选择同口径：auto 时 remote 优先）
  const installTarget = useMemo<{
    envDecls: McpEnvVarDecl[]
    headerDecls: McpEnvVarDecl[]
    runtimeCommand: string | null
  }>(() => {
    if (!detail) return { envDecls: [], headerDecls: [], runtimeCommand: null }
    const remote = prefer !== 'stdio'
      ? detail.remotes?.find((r) => r.type === 'streamable-http') ?? detail.remotes?.[0]
      : undefined
    if (remote) return { envDecls: [], headerDecls: remote.headers ?? [], runtimeCommand: null }
    const pkg = detail.packages?.find((p) => INSTALLABLE_REGISTRY_TYPES.includes(p.registryType))
    const runtimeCommand = pkg
      ? pkg.runtimeHint ?? REGISTRY_TYPE_COMMAND[pkg.registryType] ?? 'npx'
      : null
    return { envDecls: pkg?.environmentVariables ?? [], headerDecls: [], runtimeCommand }
  }, [detail, prefer])

  // stdio 形态的运行时探测（打开面板后一次，不轮询）：缺失不硬拦，装后在「我的能力」重连即可
  const [runtimes, setRuntimes] = useState<Record<string, McpRuntimeInfo> | null>(null)
  useEffect(() => {
    if (!installTarget.runtimeCommand || runtimes) return
    mcpMarketApi
      .runtimes()
      .then(({ runtimes: list }) => setRuntimes(Object.fromEntries(list.map((r) => [r.command, r]))))
      .catch(() => {})
  }, [installTarget.runtimeCommand, runtimes])

  const runtimeMissing =
    installTarget.runtimeCommand && runtimes && runtimes[installTarget.runtimeCommand]?.available === false
      ? runtimes[installTarget.runtimeCommand]
      : null

  const suggestedName = useMemo(() => suggestedServerName(name), [name])

  const handleInstall = async () => {
    setIsInstalling(true)
    setInstallError(null)
    try {
      const env: Record<string, string> = {}
      for (const d of installTarget.envDecls) if (envValues[d.name]?.trim()) env[d.name] = envValues[d.name].trim()
      const headers: Record<string, string> = {}
      for (const d of installTarget.headerDecls) if (headerValues[d.name]?.trim()) headers[d.name] = headerValues[d.name].trim()
      const installed = await install({
        name,
        serverName: serverName.trim() || undefined,
        prefer,
        env: Object.keys(env).length > 0 ? env : undefined,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      })
      onInstalled(name, installed)
    } catch (err: any) {
      setInstallError(err?.data?.error || err?.message || t('mcpMarket.installFailed'))
    } finally {
      setIsInstalling(false)
    }
  }

  return (
    <>
      {/* 面板头（蓝图 .p-head）：蓝软图标块 + 名 + 一行 mono 全名 */}
      <div className="flex items-center gap-3 px-5 pt-5 pb-4 border-b border-[var(--wf-line)] flex-none">
        <div className="wf-card-icon flex-none" style={{ width: 42, height: 42, borderRadius: 12 }}>
          <Package size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-bold text-[var(--wf-ink)] truncate">
            {detail?.title ?? detailSnapshot?.title ?? suggestedName}
          </h2>
          <p className="text-xs text-[var(--wf-mut)] font-mono truncate mt-0.5">{name}</p>
        </div>
        <button onClick={closeDetail} className="p-1 text-[var(--wf-mut)] hover:text-[var(--wf-sub)] rounded transition-colors flex-none">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto wf-panel-scroll px-5 py-4">
        {isLoadingDetail && !detailSnapshot ? (
          /* 无快照（触点②直达路径）：全骨架。占位形状非假数据——内容"长出来"而非"跳出来" */
          <DrawerSkeleton />
        ) : !detail && !isLoadingDetail ? (
          <div className="flex items-center justify-center min-h-[8rem] text-[var(--wf-mut)] text-[13px]">
            {t('mcpMarket.detailFailed')}
          </div>
        ) : (
          /* 分相渲染（2026-08-08）：点卡瞬间货架卡快照已把头/描述/版本摆好（真实数据），
             detail 往返期间只凭据声明区是骨架——用户读内容的零点几秒正好盖住网络等待 */
          <div className="space-y-5">
            {/* 它是什么 + 版本/仓库（快照先行，detail 到位补仓库链接） */}
            {(detail?.description ?? detailSnapshot?.description) && (
              <div>
                <p className="wf-sec-label mb-2">{t('mcpMarket.aboutSection')}</p>
                <p className="text-[13px] text-[var(--wf-ink)]">{detail?.description ?? detailSnapshot?.description}</p>
                <div className="flex items-center gap-2 mt-2 text-xs text-[var(--wf-mut)]">
                  {(detail?.version ?? detailSnapshot?.version) && <span>v{detail?.version ?? detailSnapshot?.version}</span>}
                  {(detail?.version ?? detailSnapshot?.version) && detail?.repository?.url && <span className="text-[var(--wf-faint)]">·</span>}
                  {detail?.repository?.url && (
                    <a
                      href={detail.repository.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 text-[var(--wf-accent)] hover:text-[var(--wf-accent)] transition-colors"
                    >
                      <ExternalLink size={11} />
                      {t('mcpMarket.repository')}
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* 信任一句（静态文案，快照阶段即可显示） */}
            <p className="flex items-start gap-1.5 text-xs text-[var(--wf-warn-ink)]">
              <ShieldAlert size={13} className="mt-px flex-none" />
              {t('mcpMarket.trustNotice')}
            </p>

            {isLoadingDetail ? (
              /* 快照已给出真实描述，等待的只是凭据声明——骨架占位 */
              <div className="wf-skel-fade space-y-2.5 pt-1">
                <SkelBar w="30%" h={9} />
                <SkelBar w="100%" h={30} />
                <SkelBar w="100%" h={30} />
              </div>
            ) : (
              <>
                {runtimeMissing && (
                  <p className="flex items-start gap-1.5 text-xs text-[var(--wf-warn-ink)]">
                    <AlertTriangle size={13} className="mt-px flex-none" />
                    {t('mcpMarket.runtimeMissing', { command: runtimeMissing.command, hint: runtimeMissing.installHint })}
                  </p>
                )}

                {/* 凭据声明（轻决策：只有凭据+承诺按钮，技术选项全部后退） */}
                <div className="space-y-4">
                  {/* env 声明（stdio 形态） */}
                  {installTarget.envDecls.length > 0 && (
                    <div className="space-y-3">
                      <p className="wf-sec-label">{t('mcpMarket.envSection')}</p>
                      {installTarget.envDecls.map((d) => (
                        <label key={d.name} className="block">
                          <span className="flex items-center gap-1.5 text-xs text-[var(--wf-sub)]">
                            <span className="font-mono">{d.name}</span>
                            {d.isRequired && <span className="text-[var(--wf-err-ink)]">*</span>}
                          </span>
                          <input
                            type={d.isSecret ? 'password' : 'text'}
                            value={envValues[d.name] ?? ''}
                            onChange={(e) => setEnvValues((v) => ({ ...v, [d.name]: e.target.value }))}
                            placeholder={d.description || d.default || ''}
                            className="wf-ink-input mt-1"
                          />
                        </label>
                      ))}
                    </div>
                  )}

                  {/* headers 声明（remote 形态） */}
                  {installTarget.headerDecls.length > 0 && (
                    <div className="space-y-3">
                      <p className="wf-sec-label">{t('mcpMarket.headersSection')}</p>
                      {installTarget.headerDecls.map((d) => (
                        <label key={d.name} className="block">
                          <span className="flex items-center gap-1.5 text-xs text-[var(--wf-sub)]">
                            <span className="font-mono">{d.name}</span>
                            {d.isRequired && <span className="text-[var(--wf-err-ink)]">*</span>}
                          </span>
                          <input
                            type={d.isSecret ? 'password' : 'text'}
                            value={headerValues[d.name] ?? ''}
                            onChange={(e) => setHeaderValues((v) => ({ ...v, [d.name]: e.target.value }))}
                            placeholder={d.description || ''}
                            className="wf-ink-input mt-1"
                          />
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* 承诺脚（蓝图 .p-foot）：钉底不随正文滚动——错误一行 + promise 按钮 + 高级选项小字折叠。
          常驻锚定（2026-08-08）：detail 在途时按钮 disabled 占位而非到位后弹出（排版零跳变） */}
      {(detail || (isLoadingDetail && detailSnapshot)) && (
        <div className="flex-none border-t border-[var(--wf-line)] px-5 pt-3.5 pb-5">
          {installError && (
            <p className="flex items-start gap-1.5 text-xs text-[var(--wf-err-ink)] mb-2.5">
              <AlertCircle size={13} className="mt-px flex-none" />
              {installError}
            </p>
          )}

          {/* 承诺按钮：整个流程唯一的高强调实心色块（蓝图 .promise：蓝光阴影+hover 微浮起） */}
          <button onClick={handleInstall} disabled={!detail || isInstalling} className="wf-promise">
            {isInstalling && <RefreshCw size={13} className="animate-spin" />}
            {t('mcpMarket.install')}
          </button>

          {/* 高级选项（折叠：prefer/serverName/技术细节，默认值即正确答案；蓝图 .p-detail 在按钮下） */}
          {detail && (
            <>
              <button
                onClick={() => setShowAdvanced((v) => !v)}
                className="mt-3 flex items-center gap-1.5 text-xs text-[var(--wf-mut)] hover:text-[var(--wf-ink)] transition-colors"
              >
                <ChevronDown size={13} className={cn('transition-transform duration-300', !showAdvanced && '-rotate-90')} />
                {t('mcpMarket.advancedOptions')}
              </button>
              <div className={cn('wf-collapse', !showAdvanced && 'wf-collapsed')}>
                <div className="wf-collapse-inner">
                  <div className="pt-4 space-y-4">
                    <label className="block">
                      <span className="text-xs text-[var(--wf-mut)]">{t('mcpMarket.prefer')}</span>
                      <select
                        value={prefer}
                        onChange={(e) => setPrefer(e.target.value as typeof prefer)}
                        className="wf-ink-select mt-1"
                      >
                        <option value="auto">{t('mcpMarket.preferAuto')}</option>
                        <option value="http">{t('mcpMarket.modeRemote')}</option>
                        <option value="stdio">{t('mcpMarket.modeLocal')}</option>
                      </select>
                    </label>

                    <label className="block">
                      <span className="text-xs text-[var(--wf-mut)]">{t('mcpMarket.serverName')}</span>
                      <input
                        type="text"
                        value={serverName}
                        onChange={(e) => setServerName(e.target.value)}
                        placeholder={suggestedName}
                        className="wf-ink-input mt-1 font-mono"
                      />
                    </label>

                    {((detail.remotes?.length ?? 0) > 0 || (detail.packages?.length ?? 0) > 0) && (
                      <div className="space-y-1.5">
                        <p className="wf-sec-label">{t('mcpMarket.techInfo')}</p>
                        {detail.remotes?.map((r, i) => (
                          <p key={`r${i}`} className="text-xs font-mono text-[var(--wf-sub)] break-all">
                            {r.type} · {r.url}
                          </p>
                        ))}
                        {detail.packages?.map((p, i) => (
                          <p key={`p${i}`} className="text-xs font-mono text-[var(--wf-sub)] break-all">
                            {p.registryType}{p.runtimeHint ? ` · ${p.runtimeHint}` : ''} · {p.identifier}{p.version ? `@${p.version}` : ''}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </>
  )
}

/** 骨架条：占位形状不是假数据——几何近似真实内容，内容"长出来"而不是"跳出来" */
function SkelBar({ w, h = 10 }: { w: string; h?: number }) {
  return <i className="block rounded-[5px] bg-[var(--wf-mono-bg)]" style={{ width: w, height: h }} />
}

/** 抽屉无快照路径（触点②直达）的全骨架：段标+描述三行+凭据两块 */
function DrawerSkeleton() {
  return (
    <div className="wf-skel-fade space-y-6 pt-1">
      <div className="space-y-2.5">
        <SkelBar w="22%" h={9} />
        <SkelBar w="100%" h={11} />
        <SkelBar w="88%" h={11} />
        <SkelBar w="42%" h={11} />
      </div>
      <div className="space-y-2.5">
        <SkelBar w="30%" h={9} />
        <SkelBar w="100%" h={30} />
        <SkelBar w="100%" h={30} />
      </div>
    </div>
  )
}

// ==================== 凭据补配面板 ====================

/**
 * 已学会能力的凭据补配（2026-08-07 P2）：按安装时持久化的 _decl 声明渲染。
 * 值只进不出（后端永不回传凭据值）：已配置键显示"已配置"态，输入新值=更换，垃圾桶=删除；
 * 保存走 PATCH 增量 merge，不用删除重装。
 */
function CredentialsPanel({ server: s }: { server: McpServerStatus }) {
  const { t } = useTranslation()
  const updateCredentials = useMcpMarketStore((st) => st.updateCredentials)
  const [values, setValues] = useState<Record<string, string>>({})
  const [toDelete, setToDelete] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // saved 提示的 setTimeout 必须随卸载清理（3 秒内切 tab 不 setState 已卸载组件）
  useEffect(() => {
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current)
    }
  }, [])

  const decls = useMemo(
    () => [
      ...(s.decl?.env ?? []).map((d) => ({ ...d, section: 'env' as const })),
      ...(s.decl?.headers ?? []).map((d) => ({ ...d, section: 'headers' as const })),
    ],
    [s.decl]
  )

  const configured = useMemo(() => new Set([...s.envKeys, ...s.headerKeys]), [s.envKeys, s.headerKeys])
  const missingCount = decls.filter((d) => !configured.has(d.name) || toDelete.has(d.name)).length
  const dirty = Object.values(values).some((v) => v.trim()) || toDelete.size > 0

  const handleSave = async () => {
    const env: Record<string, string> = {}
    const headers: Record<string, string> = {}
    for (const d of decls) {
      const target = d.section === 'env' ? env : headers
      if (toDelete.has(d.name)) target[d.name] = ''
      else if (values[d.name]?.trim()) target[d.name] = values[d.name].trim()
    }
    setSaving(true)
    setError(null)
    try {
      await updateCredentials(s.name, {
        env: Object.keys(env).length > 0 ? env : undefined,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      })
      setValues({})
      setToDelete(new Set())
      setSaved(true)
      savedTimer.current = setTimeout(() => setSaved(false), 3000)
    } catch (err: any) {
      setError(err?.data?.error || err?.message || t('mcpMarket.actionFailed'))
    } finally {
      setSaving(false)
    }
  }

  if (decls.length === 0) return null

  return (
    <div>
      <p className="wf-sec-label flex items-center gap-1.5">
        <KeyRound size={12} className="text-[var(--wf-mut)]" />
        {t('mcpMarket.credentials')}
        {missingCount > 0 && (
          <span className="text-[var(--wf-warn-ink)] tracking-normal">{t('mcpMarket.credentialsMissing', { count: missingCount })}</span>
        )}
      </p>
      <div className="space-y-3">
        {decls.map((d) => {
          const markedDelete = toDelete.has(d.name)
          const isConfigured = configured.has(d.name) && !markedDelete
          return (
            <div key={`${d.section}-${d.name}`}>
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-xs text-[var(--wf-ink)]">{d.name}</span>
                {d.isRequired && <span className="text-[var(--wf-err-ink)] text-xs">*</span>}
                {isConfigured && <span className="text-xs text-[var(--wf-ok-ink)]">{t('mcpMarket.configured')}</span>}
                {markedDelete && <span className="text-xs text-[var(--wf-err-ink)]">{t('mcpMarket.markedDelete')}</span>}
                {configured.has(d.name) && (
                  <button
                    onClick={() =>
                      setToDelete((prev) => {
                        const next = new Set(prev)
                        if (markedDelete) next.delete(d.name)
                        else next.add(d.name)
                        return next
                      })
                    }
                    className="ml-auto p-0.5 text-[var(--wf-mut)] hover:text-[var(--wf-err-ink)] transition-colors"
                    title={markedDelete ? t('mcpMarket.undoDelete') : t('mcpMarket.removeCredential')}
                  >
                    {markedDelete ? <Undo2 size={12} /> : <Trash2 size={12} />}
                  </button>
                )}
              </div>
              {d.description && (
                <p className="text-xs text-[var(--wf-mut)] truncate mt-0.5" title={d.description}>
                  {d.description}
                </p>
              )}
              {!markedDelete && (
                <input
                  type={d.isSecret ? 'password' : 'text'}
                  value={values[d.name] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [d.name]: e.target.value }))}
                  placeholder={isConfigured ? t('mcpMarket.configuredPlaceholder') : d.placeholder || ''}
                  className="wf-ink-input mt-1.5"
                />
              )}
            </div>
          )
        })}
      </div>
      {error && <p className="text-xs text-[var(--wf-err-ink)] mt-2">{error}</p>}
      {saved && (
        <p className="flex items-center gap-1 text-xs text-[var(--wf-ok-ink)] mt-2">
          <CheckCircle2 size={12} />
          {t('mcpMarket.credentialsSaved')}
        </p>
      )}
      <div className="flex items-center gap-3 mt-2.5">
        <button onClick={handleSave} disabled={saving || !dirty} className="wf-cta">
          {saving && <RefreshCw size={12} className="animate-spin" />}
          {t('mcpMarket.saveCredentials')}
        </button>
      </div>
    </div>
  )
}

// ==================== 管理间（我的能力=行式列表） ====================

const STATE_DOT: Record<McpServerStatus['state'], string> = {
  Connected: 'connected',
  Connecting: 'connecting',
  Failed: 'failed',
  Disconnected: 'off',
}
const STATE_TEXT_KEY: Record<McpServerStatus['state'], string> = {
  Connected: 'stateConnected',
  Connecting: 'stateConnecting',
  Failed: 'stateFailed',
  Disconnected: 'stateDisabled',
}
const STATE_TEXT_COLOR: Record<McpServerStatus['state'], string> = {
  Connected: 'var(--wf-ok-ink)',
  Connecting: 'var(--wf-warn-ink)',
  Failed: 'var(--wf-err-ink)',
  Disconnected: 'var(--wf-mut)',
}

const EMPTY_SET: ReadonlySet<string> = new Set()

function InstalledList() {
  const { t } = useTranslation()
  const servers = useMcpMarketStore((s) => s.servers)
  const isLoadingServers = useMcpMarketStore((s) => s.isLoadingServers)
  const items = useMcpMarketStore((s) => s.items)
  const focusInstalled = useCorridorStore((s) => s.focusInstalled)
  const setTab = useCorridorStore((s) => s.setTab)

  // 展开态提升到列表级：支持「已学会 · 去管理」深链定位展开
  const [expandedName, setExpandedName] = useState<string | null>(null)

  useEffect(() => {
    if (!focusInstalled) return
    if (!servers.some((s) => s.name === focusInstalled)) return // 状态未落定，等下一轮
    setExpandedName(focusInstalled)
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-server-row="${CSS.escape(focusInstalled)}"]`)
        ?.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' })
    })
    useCorridorStore.getState().clearFocus()
  }, [focusInstalled, servers])

  // 「对话中」实况（蓝图验收 #8，2026-08-08）：从对话正在执行的工具调用反查能力——
  // 消息 toolCallStatus='calling' 且工具名带 mcp__<server>__ 前缀，即该能力正被对话使用。
  // 只扫消息尾部窗口（calling 只可能发生在最近轮次，旧轮次的 calling 残留反而是错误信号）；
  // Set 比对守卫：流式 chunk 高频触发 subscribe，派生结果没变就不 setState
  const [liveServers, setLiveServers] = useState<ReadonlySet<string>>(EMPTY_SET)
  useEffect(() => {
    const derive = () => {
      const msgs = useChatStore.getState().messages
      const next = new Set<string>()
      for (let i = msgs.length - 1; i >= 0 && i > msgs.length - 40; i--) {
        const m = msgs[i]
        if (m.toolCallStatus === 'calling' && m.toolCallName?.startsWith('mcp__')) {
          const mm = /^mcp__(.+?)__/.exec(m.toolCallName)
          if (mm) next.add(mm[1])
        }
      }
      setLiveServers((prev) =>
        prev.size === next.size && [...next].every((x) => prev.has(x)) ? prev : next
      )
    }
    derive()
    return useChatStore.subscribe(derive)
  }, [])

  // 货架卡弱匹配（渐进增强）：安装时持久化的 registryName → 货架的人读名/官方描述。
  // 真实数据不硬造：逛过货架（含安装路径）就能匹配上，匹配不上退回运行方式/工具数 meta
  const cardByRegistry = useMemo(() => new Map(items.map((c) => [c.name, c])), [items])
  const matchCard = (s: McpServerStatus): McpMarketCard | undefined =>
    s.decl?.registryName ? cardByRegistry.get(s.decl.registryName) : undefined

  // 无常驻轮询（2026-08-06 用户拍板）：切到本 tab / 点刷新 / 重连动作时才拉状态

  if (isLoadingServers && servers.length === 0) {
    /* 首载骨架（几何与真行一致）：此前居中转圈→行列表闪现；2026-08-09 与真行同双列网格 */
    return (
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2.5 items-start">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="wf-skel-row" style={{ animationDelay: `${i * 120}ms` }} />
        ))}
      </div>
    )
  }
  if (servers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-[var(--wf-mut)] gap-2">
        <Package size={40} className="text-[var(--wf-faint)]" />
        <p className="text-[13px] text-[var(--wf-sub)]">{t('mcpMarket.noInstalled')}</p>
        <button className="wf-mini-btn mt-1.5" onClick={() => setTab('discover')}>
          {t('mcpMarket.goDiscover')}
        </button>
      </div>
    )
  }
  return (
    /* 宽屏双列（2026-08-09 对齐技能/定时页）：行卡自含开关，items-start 网格
       让展开只撑高自己所在格，不拉扯邻居 */
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-2.5 items-start">
      {servers.map((s) => (
        <InstalledRow
          key={s.name}
          server={s}
          card={matchCard(s)}
          live={liveServers.has(s.name)}
          expanded={expandedName === s.name}
          onToggle={() => setExpandedName((v) => (v === s.name ? null : s.name))}
        />
      ))}
    </div>
  )
}

/**
 * 我的能力行卡（原型 .caprow：行头与就地档案同卡一体，2026-08-08 两行规格重做）：
 * 行头=状态点+定宽状态文字 | 名（货架人读名优先，正被对话调用时带「对话中」chip）
 *      / 副行（接通中微光轨 + 官方描述或运行方式·工具数） | 裸开关 | chevron。
 * 档案四段（v12 §3.2）：它会做 / 密钥 / 连接与设置 / 删除（删除在最深处，就地两步）。
 * 删除退场：确认后行先收高+淡出+位移，动画落完才真删，失败行回来+红字。
 */
function InstalledRow({
  server: s,
  card,
  live,
  expanded,
  onToggle,
}: {
  server: McpServerStatus
  card?: McpMarketCard
  live: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const deleteServer = useMcpMarketStore((st) => st.deleteServer)
  const reconnectServer = useMcpMarketStore((st) => st.reconnectServer)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [openAppUri, setOpenAppUri] = useState<string | null>(null)
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 两步删除的撤回计时随卸载清理（退场计时器故意不清——删除是已确认意图，关房间也应完成）
  useEffect(() => {
    return () => {
      if (deleteTimer.current) clearTimeout(deleteTimer.current)
    }
  }, [])

  // 详情浮层（v13）：点外/Esc 关闭。点浮层内按钮不关（contains 天然覆盖）；
  // 点行头让给 onToggle 自己收（toggle 语义保持）——否则 mousedown 关+click 开会双触发重开
  const popupRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!expanded) return
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popupRef.current?.contains(t)) return
      if (headerRef.current?.contains(t)) return
      onToggle()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onToggle()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [expanded, onToggle])

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true)
    setActionError(null)
    try {
      await action()
    } catch (err: any) {
      setActionError(err?.data?.error || err?.message || t('mcpMarket.actionFailed'))
    } finally {
      setBusy(false)
    }
  }

  /** 两步内联删除：首击变实心红"再点一次确认删除"，3 秒无二次点击自动撤回。
   *  确认→行先安静退场（400ms 动画），动画落完才调 API；失败则行回来+红字——
   *  几何连续优先，但绝不假装删除成功 */
  const handleDelete = () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      deleteTimer.current = setTimeout(() => setConfirmingDelete(false), 3000)
      return
    }
    if (deleteTimer.current) clearTimeout(deleteTimer.current)
    setConfirmingDelete(false)
    setLeaving(true)
    setTimeout(async () => {
      try {
        await deleteServer(s.name)
      } catch (err: any) {
        setLeaving(false)
        setActionError(err?.data?.error || err?.message || t('mcpMarket.actionFailed'))
      }
    }, 400)
  }

  // 行 meta：运行方式 · 工具数（可见域不暴露——2026-08-07 用户拍板，默认全域，徒增复杂度）
  const meta = [
    s.type === 'http' ? t('mcpMarket.modeRemote') : t('mcpMarket.modeLocal'),
    t('mcpMarket.toolCount', { count: s.toolCount }),
  ].join(' · ')

  // 名=货架人读名优先（用户世界没有协议名），副行=官方描述优先、meta 兜底
  const displayName = card?.title || s.name
  const subline = card?.description ?? meta

  return (
    <div className={cn('wf-row-leave wf-rowpop-anchor', leaving && 'leaving')}>
      <div className="wf-row-leave-inner">
        <div className="wf-caprow" data-server-row={s.name}>
          {/* 行头：高度恒定，点击展开/收起；按压反馈 wf-press */}
          <div className="wf-list-row wf-press" ref={headerRef} onClick={onToggle}>
            <span className={cn('wf-state-dot', STATE_DOT[s.state])} />
            {/* 定宽列按最长态文案「正在接通…」取 72px，状态翻转时行内元素零横跳（原 64px 装不下会溢出） */}
            <span className="text-xs flex-none w-[72px]" style={{ color: STATE_TEXT_COLOR[s.state] }}>
              {t(`mcpMarket.${STATE_TEXT_KEY[s.state]}`)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-[var(--wf-ink)] truncate">{displayName}</span>
                {live && <span className="wf-live-chip">{t('mcpMarket.liveInChat')}</span>}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                {/* 接通中微光轨：与压缩条同语言（假流动），落定后随状态文字一起翻转收尾 */}
                {s.state === 'Connecting' && (
                  <span className="wf-conn-track" aria-hidden="true">
                    <span className="wf-conn-glow" />
                  </span>
                )}
                <span className="text-xs text-[var(--wf-mut)] truncate">{subline}</span>
              </div>
            </div>
            <EnableSwitch server={s} />
            <ChevronDown
              size={14}
              className={cn('flex-none text-[var(--wf-mut)] transition-transform duration-300', !expanded && '-rotate-90')}
            />
          </div>
        </div>
      </div>

      {/* 详情浮层（v13）：absolute 弹出覆盖下方内容，不参与排版——行卡与网格行高度恒定 */}
      {expanded && (
        <div className="wf-rowpop" ref={popupRef}>
          <div className="space-y-4">
            {s.state === 'Failed' && s.error && <p className="text-xs text-[var(--wf-err-ink)] pt-2">{s.error}</p>}

            {/* 档案一段：它会做（chip 云，剥掉 mcp__ 前缀的技术名） */}
            {s.tools.length > 0 && (
              <div className="pt-2">
                <p className="wf-sec-label">{t('mcpMarket.itCanDo', { count: s.tools.length })}</p>
                <div className="flex flex-wrap gap-1.5">
                  {s.tools.map((tool) => (
                    <span key={tool} className="wf-chip" title={tool}>
                      {displayToolName(tool)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {s.apps.length > 0 && (
              <div>
                <p className="wf-sec-label">业务应用</p>
                <div className="flex flex-wrap gap-2">
                  {s.apps.map((app) => (
                    <button key={app.uri} className="wf-mini-btn wf-press" onClick={() => setOpenAppUri(app.uri)}>
                      打开{app.title}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 档案二段：凭据（值只进不出） */}
            <CredentialsPanel server={s} />

            {/* 档案三段：连接与策略 */}
            <div>
              <p className="wf-sec-label">{t('mcpMarket.connAndPolicy')}</p>
              <div className="flex items-center gap-3 flex-wrap">
                {s.enabled ? (
                  <button
                    className="wf-mini-btn wf-press"
                    onClick={() => void runAction(() => reconnectServer(s.name))}
                    disabled={busy}
                  >
                    <RefreshCw size={11} className={cn(busy && 'animate-spin')} />
                    {t('mcpMarket.reconnect')}
                  </button>
                ) : (
                  <span className="text-xs text-[var(--wf-mut)]">{t('mcpMarket.disabledHint')}</span>
                )}
                {actionError && <span className="text-xs text-[var(--wf-err-ink)]">{actionError}</span>}
                <ApprovalSwitch server={s} />
              </div>
            </div>

            {/* 档案四段：删除（删除在最深处，就地两步） */}
            <div className="border-t border-[var(--wf-hair)] pt-3">
              <p className="wf-sec-label">{t('mcpMarket.farewell')}</p>
              <button
                className={cn('wf-mini-btn wf-press', confirmingDelete && 'armed')}
                onClick={handleDelete}
                disabled={busy}
              >
                {confirmingDelete ? t('mcpMarket.confirmDelete') : t('mcpMarket.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
      {openAppUri && (
        <section className="fixed inset-6 z-[80] flex flex-col overflow-hidden rounded-2xl border border-[var(--wf-line)] bg-white shadow-2xl">
          <header className="flex items-center justify-between border-b border-[var(--wf-line)] px-4 py-3">
            <strong className="text-sm text-[var(--wf-ink)]">
              {s.apps.find((app) => app.uri === openAppUri)?.title ?? 'MCP 应用'}
            </strong>
            <button className="wf-mini-btn" onClick={() => setOpenAppUri(null)} aria-label="关闭 MCP 应用">关闭</button>
          </header>
          <div className="min-h-0 flex-1">
            <McpAppHost serverName={s.name} resourceUri={openAppUri} allowedTools={s.tools} />
          </div>
        </section>
      )}
    </div>
  )
}

/**
 * 启用/停用开关（2026-08-07 v12 行开关，常驻行内一键可达）：
 * 关=下线该 server（工具立即从对话里注销，状态以 Disconnected「已停用」补投影）；
 * 开=恢复缺省启用（热重连自动接通，窗口期以 Connecting「正在接通…」补投影——条目永不消失）。
 * 乐观更新：点击立即翻转，store 层同步把行态置为 已停用/正在接通，失败回滚+红字提示。
 */
function EnableSwitch({ server: s }: { server: McpServerStatus }) {
  const { t } = useTranslation()
  const updateSettings = useMcpMarketStore((st) => st.updateSettings)
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const enabled = optimistic ?? s.enabled

  // 后端状态追平乐观值后解除乐观层（loadServers 落定）
  useEffect(() => {
    if (optimistic !== null && s.enabled === optimistic) setOptimistic(null)
  }, [optimistic, s.enabled])

  const handleToggle = async () => {
    const next = !enabled
    setOptimistic(next)
    setError(null)
    try {
      await updateSettings(s.name, { enabled: next ? null : false })
      toast(next ? t('mcpMarket.enabledToast') : t('mcpMarket.disabledToast'))
    } catch (err: any) {
      setOptimistic(null) // 失败回滚
      setError(err?.data?.error || err?.message || t('mcpMarket.actionFailed'))
    }
  }

  return (
    // 行点击=展开/收起，开关区域须阻断冒泡；裸开关（蓝图行规格）——态语义由左侧状态文字承担
    <span className="flex items-center gap-2 flex-none" onClick={(e) => e.stopPropagation()}>
      {error && <span className="text-xs text-[var(--wf-err-ink)] truncate max-w-[10rem]" title={error}>{error}</span>}
      <button
        role="switch"
        aria-checked={enabled}
        onClick={handleToggle}
        title={t('mcpMarket.enabledHint')}
        className={cn('wf-switch', enabled && 'on')}
      >
        <span className="knob" />
      </button>
    </span>
  )
}

/**
 * 免审批开关（2026-08-07 用户拍板 opt-in；v12 后退到档案「连接与策略」段）：
 * 开启=该能力的工具调用不再逐次审批（metadata.requiresApproval=false 落盘，热重连生效）；
 * 关闭=移除覆盖恢复缺省 fail-closed。乐观更新：点击立即翻转，失败回滚+红字提示。
 */
function ApprovalSwitch({ server: s }: { server: McpServerStatus }) {
  const { t } = useTranslation()
  const updateSettings = useMcpMarketStore((st) => st.updateSettings)
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const noApproval = optimistic ?? (s.requiresApprovalOverride === false)

  // 后端状态追平乐观值后解除乐观层（loadServers 落定）
  useEffect(() => {
    if (optimistic !== null && (s.requiresApprovalOverride === false) === optimistic) setOptimistic(null)
  }, [optimistic, s.requiresApprovalOverride])

  const handleToggle = async () => {
    const next = !noApproval
    setOptimistic(next)
    setError(null)
    try {
      await updateSettings(s.name, { requiresApproval: next ? false : null })
    } catch (err: any) {
      setOptimistic(null) // 失败回滚
      setError(err?.data?.error || err?.message || t('mcpMarket.actionFailed'))
    }
  }

  return (
    <span className="flex items-center gap-2 flex-none ml-auto">
      {error && <span className="text-xs text-[var(--wf-err-ink)] truncate max-w-[10rem]" title={error}>{error}</span>}
      <span className="text-xs text-[var(--wf-sub)]">{t('mcpMarket.noApproval')}</span>
      <button
        role="switch"
        aria-checked={noApproval}
        onClick={handleToggle}
        title={t('mcpMarket.noApprovalHint')}
        className={cn('wf-switch', noApproval && 'on')}
      >
        <span className="knob" />
      </button>
    </span>
  )
}
