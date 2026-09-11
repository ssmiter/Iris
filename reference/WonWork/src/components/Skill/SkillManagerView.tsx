import { useTranslation } from 'react-i18next'
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { cn } from '@/utils'
import { useSkillStore } from '@/stores/skillStore'
import type { SkillManifest } from '@/types/skill'
import {
  Puzzle,
  Sparkles,
  FileText,
  Table,
  Presentation,
  ChevronDown,
  Search,
  Plus,
  Upload,
  Download,
  Edit3,
  RefreshCw,
  FolderOpen,
  AlertCircle,
} from 'lucide-react'

const IS_STANDALONE = import.meta.env.VITE_STANDALONE_MODE === 'true'

/**
 * Skill 管理页（2026-08-09 SKILL v2.1 全重写，MCP 页基准）
 *
 * 定位（用户拍板）：管理「可按需发现的技能」——模型按 whenToUse 自选加载，
 * 本页让人看清有什么、管得住开关；启停=从模型的元数据清单消失/出现。
 *
 * 丝滑四原则落点：乐观启停（EnableSwitch 本地先翻，失败回滚）/几何连续（wf-collapse
 * 就地档案、wf-row-leave 删除退场、骨架屏与真实行同几何）/诚实（source 溯源徽标、
 * 用量真统计）/安静（窄选择器订阅、删除两步就地确认不弹窗）。
 */

/** 图标名 → lucide 组件（frontmatter icon 字段；未知名回退 Puzzle） */
const ICON_MAP: Record<string, typeof Puzzle> = {
  Puzzle,
  Sparkles,
  FileText,
  Table,
  Presentation,
}
function skillIcon(skill: SkillManifest): typeof Puzzle {
  return ICON_MAP[skill.icon] ?? (skill.source === 'agent' ? Sparkles : Puzzle)
}

type SortMode = 'recent' | 'name'

/**
 * 域知识包技能（id 后缀 -domain-knowledge，如 aps-domain-knowledge）不对用户展示：
 * 内容是领域判断依据，只供模型经元数据清单发现、读文件加载；公网发布口径=领域知识不上货架。
 * 纯展示层过滤，skillStore 同步与模型注入链路不受影响。
 */
const isDomainPackSkill = (s: SkillManifest) => s.id.endsWith('-domain-knowledge')

export function SkillManagerView() {
  const { t } = useTranslation()
  // 窄选择器（安静原则）：整店订阅会让每次启停都重渲整页
  const skills = useSkillStore((s) => s.skills)
  const usageStats = useSkillStore((s) => s.usageStats)
  const activeSkillIds = useSkillStore((s) => s.activeSkillIds)
  const isLoading = useSkillStore((s) => s.isLoading)
  const hasLoaded = useSkillStore((s) => s.hasLoaded)
  const isWorkspaceConnected = useSkillStore((s) => s.isWorkspaceConnected)
  const isFallbackMode = useSkillStore((s) => s.isFallbackMode)
  const init = useSkillStore((s) => s.init)
  const pickWorkspace = useSkillStore((s) => s.pickWorkspace)
  const importFromFile = useSkillStore((s) => s.importFromFile)

  const [searchQuery, setSearchQuery] = useState('')
  const [domainFilter, setDomainFilter] = useState<string | null>(null)
  const [sortMode, setSortMode] = useState<SortMode>('recent')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // 抽屉：null=关闭；'new'=新建；否则为编辑对象的 id（对象从 store 实时取，编辑期间启停不失真）
  const [drawerTarget, setDrawerTarget] = useState<string | 'new' | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    init()
  }, [init])

  // 抽屉进出不对称动画（MCP 同款）：mount 后下一帧开，关时先滑出再卸载
  useEffect(() => {
    if (drawerTarget) {
      const raf = requestAnimationFrame(() => setDrawerOpen(true))
      return () => cancelAnimationFrame(raf)
    }
  }, [drawerTarget])
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false)
    setTimeout(() => setDrawerTarget(null), 380)
  }, [])

  const handleImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      try {
        await importFromFile(file)
        if (fileInputRef.current) fileInputRef.current.value = ''
      } catch (err) {
        alert(
          t('skill.skillManager.importFailed', {
            error: err instanceof Error ? err.message : t('skill.skillManager.unknownError'),
          })
        )
      }
    },
    [importFromFile, t]
  )

  // 统计头部：总数 / 已启用 / 域分布（域 chip 即筛选器）；域知识包技能不进统计口径
  const stats = useMemo(() => {
    const visible = skills.filter((s) => !isDomainPackSkill(s))
    const enabledCount = visible.filter((s) => s.enabled).length
    const domains = new Map<string, number>()
    for (const s of visible) domains.set(s.domain, (domains.get(s.domain) ?? 0) + 1)
    return { total: visible.length, enabledCount, domains: [...domains.entries()] }
  }, [skills])

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    let list = skills.filter((s) => {
      if (isDomainPackSkill(s)) return false
      if (domainFilter && s.domain !== domainFilter) return false
      if (!q) return true
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.keywords.some((k) => k.toLowerCase().includes(q))
      )
    })
    list = [...list].sort((a, b) => {
      if (sortMode === 'name') return a.name.localeCompare(b.name, 'zh-CN')
      // 最近使用：有用量在前按 lastUsedAt 倒序，未用过的垫底按名称
      const ua = usageStats[a.id]?.lastUsedAt
      const ub = usageStats[b.id]?.lastUsedAt
      if (ua && ub) return ub.localeCompare(ua)
      if (ua) return -1
      if (ub) return 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })
    return list
  }, [skills, searchQuery, domainFilter, sortMode, usageStats])

  // 域分组：保留排序后的首次出现顺序（最近使用排序下，最热的域自然浮头）
  const groups = useMemo(() => {
    const map = new Map<string, SkillManifest[]>()
    for (const s of filtered) {
      const arr = map.get(s.domain) ?? []
      arr.push(s)
      map.set(s.domain, arr)
    }
    return [...map.entries()]
  }, [filtered])

  const editingSkill = drawerTarget && drawerTarget !== 'new' ? skills.find((s) => s.id === drawerTarget) : undefined
  const showStandaloneConnect = IS_STANDALONE && !isWorkspaceConnected && !isFallbackMode

  return (
    // flex-1 min-w-0 是 ww-main-content（row flex）直子的存活条件（MCP 市场同款教训）：
    // 缺了宽度按内容固有值算——骨架无固有宽度先渲窄列（右侧空白），真行来了才撑满=闪帧根因
    <div className="relative flex flex-col h-full flex-1 min-w-0 bg-[var(--wf-bg)]">
      {/* 滚动容器 = 房间头 + 内容（scrollbar-gutter 治理，MCP 同款）：头住进滚动容器与内容同槽 */}
      <div className="flex-1 overflow-y-auto wf-room-scroll">
        <div className="sticky top-0 z-10 bg-[var(--wf-bg)] max-w-[1200px] w-full mx-auto px-8 pt-7">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-[20px] font-bold text-[var(--wf-ink)]">{t('skill.skillManager.title')}</h1>
              <p className="text-[13px] text-[var(--wf-mut)] mt-1 mb-4">{t('skill.skillManager.subtitle')}</p>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,text/markdown"
                className="hidden"
                onChange={handleImport}
              />
              <button className="wf-mini-btn wf-press" onClick={() => fileInputRef.current?.click()}>
                <Upload size={11} />
                {t('skill.skillManager.import')}
              </button>
              <button className="wf-cta wf-press" onClick={() => setDrawerTarget('new')}>
                <Plus size={13} />
                {t('skill.skillManager.newSkill')}
              </button>
            </div>
          </div>

          {/* 统计行 + 搜索/排序（统计即筛选：域 chip 点击过滤） */}
          <div className="flex items-center justify-between gap-4 pb-3 border-b border-[var(--wf-line)]">
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              <span className="text-[12px] text-[var(--wf-sub)]">
                {t('skill.skillManager.statsTotal', { total: stats.total, enabled: stats.enabledCount })}
              </span>
              {stats.domains.map(([domain, count]) => (
                <button
                  key={domain}
                  onClick={() => setDomainFilter(domainFilter === domain ? null : domain)}
                  className={cn('wf-chip wf-press transition-colors', domainFilter === domain && 'ring-1 ring-[var(--wf-accent)] text-[var(--wf-accent)]')}
                >
                  {domain} {count}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 flex-none">
              <div className="relative w-48">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--wf-mut)] pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('skill.skillManager.search')}
                  className="wf-ink-input w-full !pl-8"
                />
              </div>
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                className="wf-ink-select"
              >
                <option value="recent">{t('skill.skillManager.sortRecent')}</option>
                <option value="name">{t('skill.skillManager.sortName')}</option>
              </select>
            </div>
          </div>
        </div>

        <div className="max-w-[1200px] mx-auto px-8 py-6">
          {isFallbackMode && (
            <div className="flex items-center gap-2 mb-4 px-4 py-2.5 bg-[var(--wf-warn-bg)] border border-[var(--wf-warn-line)] rounded-xl">
              <AlertCircle size={14} className="text-[var(--wf-warn-ink)] flex-none" />
              <span className="text-[12px] text-[var(--wf-warn-ink)]">{t('skill.skillManager.fallbackWarning')}</span>
            </div>
          )}

          {/* 首帧几何由 hasLoaded 钉死（2026-08-09 闪帧根治）：从未加载→骨架（与真行同
              网格同几何）；已加载→直接铺存量行，后台静默刷新不再回骨架——杜绝进页面
              "空状态闪一帧→骨架→真行"的三段跳（右侧先空后铺满的根因） */}
          {!hasLoaded || (isLoading && skills.length === 0) ? (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-2.5 items-start">
              <div className="wf-skel-row" />
              <div className="wf-skel-row" />
              <div className="wf-skel-row" />
              <div className="wf-skel-row" />
            </div>
          ) : showStandaloneConnect ? (
            <div className="flex flex-col items-center justify-center py-24 text-[var(--wf-mut)] gap-3">
              <FolderOpen size={40} className="text-[var(--wf-faint)]" />
              <p className="text-[13px]">{t('skill.skillManager.notConnectedWorkspace')}</p>
              <p className="text-[12px] max-w-md text-center">{t('skill.skillManager.workspaceHint')}</p>
              <button className="wf-cta wf-press mt-2" onClick={() => pickWorkspace()}>
                {t('skill.skillManager.selectWorkspaceDir')}
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-[var(--wf-mut)] gap-2">
              <Puzzle size={40} className="text-[var(--wf-faint)]" />
              <p className="text-[13px]">
                {searchQuery || domainFilter ? t('skill.skillManager.noMatch') : t('skill.skillManager.noSkill')}
              </p>
              <p className="text-[12px]">{t('skill.skillManager.emptyHint')}</p>
            </div>
          ) : (
            groups.map(([domain, list]) => (
              <section key={domain} className="mb-6">
                <p className="wf-sec-label mb-2">{domain}</p>
                {/* 宽屏双列（MCP 发现页网格自适应同款思路）：行卡自含开关与就地档案，
                    items-start 让展开行只撑高自己所在网格行，不拉扯同排邻居 */}
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-2.5 items-start">
                  {list.map((skill) => (
                    <SkillRow
                      key={skill.id}
                      skill={skill}
                      pinned={activeSkillIds.includes(skill.id)}
                      usage={usageStats[skill.id]}
                      expanded={expandedId === skill.id}
                      onToggleExpand={() => setExpandedId(expandedId === skill.id ? null : skill.id)}
                      onEdit={() => setDrawerTarget(skill.id)}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>

      {/* 编辑/新建抽屉：absolute 住进页面内部（MCP 同款），遮罩只盖本页不盖全屏 */}
      {drawerTarget && (drawerTarget === 'new' || editingSkill) && (
        <div className="absolute inset-0 z-50">
          <div
            className={cn('absolute inset-0 bg-black/20 transition-opacity duration-300', drawerOpen ? 'opacity-100' : 'opacity-0')}
            onClick={closeDrawer}
          />
          <div
            className={cn(
              'absolute inset-y-0 right-0 w-full max-w-[30rem] bg-[var(--wf-card-bg)] border-l border-[var(--wf-line)] flex flex-col transition-transform ease-out',
              drawerOpen ? 'translate-x-0' : 'translate-x-full'
            )}
            style={{ boxShadow: '-16px 0 40px rgba(20,20,30,.10)', transitionDuration: '380ms', transitionTimingFunction: 'cubic-bezier(.32,.72,.24,1)' }}
          >
            <SkillEditorDrawer
              key={drawerTarget}
              skill={editingSkill}
              onClose={closeDrawer}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ==================== 行（同卡一体：行头 + 就地档案） ====================

function SkillRow({
  skill,
  pinned,
  usage,
  expanded,
  onToggleExpand,
  onEdit,
}: {
  skill: SkillManifest
  pinned: boolean
  usage?: { count: number; lastUsedAt: string }
  expanded: boolean
  onToggleExpand: () => void
  onEdit: () => void
}) {
  const { t } = useTranslation()
  const uninstallSkill = useSkillStore((s) => s.uninstallSkill)
  const exportToFile = useSkillStore((s) => s.exportToFile)
  const [leaving, setLeaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const Icon = skillIcon(skill)

  // 详情浮层（v13）：点外/Esc 关闭。点浮层内按钮不关（contains 天然覆盖）；
  // 点行头让给 onToggleExpand 自己收（toggle 语义保持）——否则 mousedown 关+click 开会双触发重开
  const popupRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!expanded) return
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popupRef.current?.contains(t)) return
      if (headerRef.current?.contains(t)) return
      onToggleExpand()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onToggleExpand()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [expanded, onToggleExpand])

  /** 两步内联删除 + 行退场动画（MCP 同款）：动画落完才调 API，失败行回来+红字 */
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
        await uninstallSkill(skill.id)
      } catch (err) {
        setLeaving(false)
        setActionError(err instanceof Error ? err.message : t('skill.skillManager.unknownError'))
      }
    }, 400)
  }

  const meta = [
    `v${skill.version}`,
    usage && usage.count > 0 ? t('skill.skillManager.usageCount', { count: usage.count }) : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className={cn('wf-row-leave wf-rowpop-anchor', leaving && 'leaving')}>
      <div className="wf-row-leave-inner">
        <div className="wf-caprow" data-skill-row={skill.id}>
          {/* 行头：高度恒定，点击展开/收起；按压反馈 wf-press */}
          <div className="wf-list-row wf-press" ref={headerRef} onClick={onToggleExpand}>
            <span className="w-8 h-8 rounded-lg bg-[var(--wf-mono-bg)] border border-[var(--wf-line)] flex items-center justify-center flex-none">
              <Icon size={15} className="text-[var(--wf-mut)]" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-semibold text-[var(--wf-ink)] truncate">{skill.name}</span>
                <SourceBadge source={skill.source} />
                {pinned && <span className="wf-live-chip">{t('skill.skillManager.pinnedChip')}</span>}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[12px] text-[var(--wf-mut)] truncate">{skill.description || skill.id}</span>
                <span className="text-[11px] text-[var(--wf-faint)] flex-none">{meta}</span>
              </div>
            </div>
            <SkillSwitch skill={skill} field="enabled" />
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
            {actionError && <p className="text-[12px] text-[var(--wf-err-ink)] pt-2">{actionError}</p>}

            {skill.whenToUse && (
              <div className="pt-2">
                <p className="wf-sec-label">{t('skill.skillManager.whenToUse')}</p>
                <p className="text-[13px] text-[var(--wf-sub)]">{skill.whenToUse}</p>
              </div>
            )}

            {skill.keywords.length > 0 && (
              <div>
                <p className="wf-sec-label">{t('skill.skillManager.keywords')}</p>
                <div className="flex flex-wrap gap-1.5">
                  {skill.keywords.map((k) => (
                    <span key={k} className="wf-chip">{k}</span>
                  ))}
                </div>
              </div>
            )}

            <div>
              <p className="wf-sec-label">{t('skill.skillManager.promptPreview')}</p>
              <pre className="text-[12px] text-[var(--wf-sub)] bg-[var(--wf-mono-bg)] border border-[var(--wf-line)] rounded-xl p-3 max-h-36 overflow-y-auto whitespace-pre-wrap font-mono">
                {skill.prompt.slice(0, 400)}{skill.prompt.length > 400 ? ' …' : ''}
              </pre>
            </div>

            {/* 设置段：斜杠菜单可见性（模型读技能文件不受此限） */}
            <div>
              <p className="wf-sec-label">{t('skill.skillManager.settings')}</p>
              <div className="flex items-center gap-4 flex-wrap">
                <SkillSwitch skill={skill} field="userInvocable" label={t('skill.skillManager.userInvocable')} />
                <span className="text-[11px] text-[var(--wf-mut)]">
                  {t('skill.skillManager.updatedAt', { time: formatTime(skill.updatedAt) })}
                </span>
              </div>
            </div>

            {/* 操作段：编辑/导出/删除（删除在最深处，就地两步；内置不可删——同步会拉回） */}
            <div className="border-t border-[var(--wf-hair)] pt-3 flex items-center gap-2">
              <button className="wf-mini-btn wf-press" onClick={onEdit}>
                <Edit3 size={11} />
                {t('skill.skillManager.edit')}
              </button>
              <button className="wf-mini-btn wf-press" onClick={() => exportToFile(skill.id)}>
                <Download size={11} />
                {t('skill.skillManager.export')}
              </button>
              {skill.source !== 'built-in' && (
                <button
                  className={cn('wf-mini-btn wf-press', confirmingDelete && 'armed')}
                  onClick={handleDelete}
                >
                  {confirmingDelete ? t('skill.skillManager.confirmDelete') : t('skill.skillManager.delete')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ==================== 乐观开关（启停 / 斜杠菜单可见性） ====================

/**
 * MCP EnableSwitch 同款乐观范式：点击立即翻转，store 落定后解除乐观层，失败回滚+红字。
 * field=enabled 时启停即「从模型的元数据清单消失/出现」。
 */
function SkillSwitch({ skill, field, label }: { skill: SkillManifest; field: 'enabled' | 'userInvocable'; label?: string }) {
  const { t } = useTranslation()
  const updateSkill = useSkillStore((s) => s.updateSkill)
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const value = optimistic ?? skill[field]

  useEffect(() => {
    if (optimistic !== null && skill[field] === optimistic) setOptimistic(null)
  }, [optimistic, skill, field])

  const handleToggle = async () => {
    const next = !value
    setOptimistic(next)
    setError(null)
    try {
      await updateSkill(skill.id, { [field]: next })
    } catch (err) {
      setOptimistic(null)
      setError(err instanceof Error ? err.message : t('skill.skillManager.unknownError'))
    }
  }

  return (
    <span className="flex items-center gap-2 flex-none" onClick={(e) => e.stopPropagation()}>
      {label && <span className="text-[12px] text-[var(--wf-sub)]">{label}</span>}
      {error && <span className="text-[12px] text-[var(--wf-err-ink)] truncate max-w-[10rem]" title={error}>{error}</span>}
      <button
        role="switch"
        aria-checked={value}
        onClick={handleToggle}
        title={field === 'enabled' ? t('skill.skillManager.enabledHint') : t('skill.skillManager.userInvocableHint')}
        className={cn('wf-switch', value && 'on')}
      >
        <span className="knob" />
      </button>
    </span>
  )
}

// ==================== source 溯源徽标 ====================

function SourceBadge({ source }: { source: SkillManifest['source'] }) {
  const { t } = useTranslation()
  // 溯源徽标统一中性单色（v13）：来源靠文字区分，不靠彩色填充
  return (
    <span className="text-[11px] px-1.5 py-0.5 rounded-md flex-none border border-[var(--wf-hair)] bg-[var(--wf-mono-bg)] text-[var(--wf-mut)]">
      {t(`skill.skillManager.source.${source}`)}
    </span>
  )
}

// ==================== 编辑/新建抽屉 ====================

function SkillEditorDrawer({ skill, onClose }: { skill?: SkillManifest; onClose: () => void }) {
  const { t } = useTranslation()
  const updateSkill = useSkillStore((s) => s.updateSkill)
  const createSkill = useSkillStore((s) => s.createSkill)
  const isNew = !skill
  const [form, setForm] = useState({
    id: skill?.id ?? '',
    name: skill?.name ?? '',
    description: skill?.description ?? '',
    whenToUse: skill?.whenToUse ?? '',
    domain: skill?.domain ?? 'general',
    keywords: (skill?.keywords ?? []).join(', '),
    prompt: skill?.prompt ?? '',
    userInvocable: skill?.userInvocable !== false,
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const handleSave = async () => {
    const keywords = form.keywords.split(/[,，]/).map((k) => k.trim()).filter(Boolean)
    setSaving(true)
    setSaveError(null)
    try {
      if (isNew) {
        const id = form.id.trim().toLowerCase()
        if (!/^[a-z][a-z0-9-]{2,39}$/.test(id)) {
          throw new Error(t('skill.skillManager.idInvalid'))
        }
        await createSkill({
          id,
          name: form.name.trim() || id,
          description: form.description.trim(),
          whenToUse: form.whenToUse.trim(),
          domain: form.domain.trim().toLowerCase() || 'general',
          keywords,
          prompt: form.prompt,
          // r309 合并：导师补的 userInvocable 表单字段并入 v2 保存流
          userInvocable: form.userInvocable,
        })
      } else {
        await updateSkill(skill.id, {
          name: form.name.trim(),
          description: form.description.trim(),
          whenToUse: form.whenToUse.trim(),
          domain: form.domain.trim().toLowerCase() || 'general',
          keywords,
          prompt: form.prompt,
          userInvocable: form.userInvocable,
        })
      }
      onClose()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('skill.skillManager.unknownError'))
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'wf-ink-input w-full'

  return (
    <>
      {/* 抽屉头（图标块头，蓝图三段式） */}
      <div className="flex items-center gap-3 px-6 pt-6 pb-4 border-b border-[var(--wf-hair)]">
        <span className="w-10 h-10 rounded-xl bg-[var(--wf-mono-bg)] border border-[var(--wf-line)] flex items-center justify-center flex-none">
          {isNew ? <Sparkles size={17} className="text-[var(--wf-mut)]" /> : <Puzzle size={17} className="text-[var(--wf-mut)]" />}
        </span>
        <div className="min-w-0">
          <h2 className="text-[16px] font-bold text-[var(--wf-ink)]">
            {isNew ? t('skill.skillManager.newSkill') : t('skill.skillManager.editSkill')}
          </h2>
          <p className="text-[13px] text-[var(--wf-mut)] mt-0.5">{t('skill.skillManager.drawerSubtitle')}</p>
        </div>
      </div>

      {/* 滚动正文 */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
        {isNew && (
          <div>
            <label className="wf-sec-label block mb-1.5">{t('skill.skillManager.idLabel')}</label>
            <input
              type="text"
              value={form.id}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              placeholder="my-report-skill"
              className={inputCls}
            />
          </div>
        )}
        <div>
          <label className="wf-sec-label block mb-1.5">{t('skill.skillManager.name')}</label>
          <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
        </div>
        <div>
          <label className="wf-sec-label block mb-1.5">{t('skill.skillManager.description')}</label>
          <input
            type="text"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder={t('skill.skillManager.descriptionPlaceholder')}
            className={inputCls}
          />
        </div>
        <div>
          <label className="wf-sec-label block mb-1.5">{t('skill.skillManager.whenToUse')}</label>
          <textarea
            value={form.whenToUse}
            onChange={(e) => setForm({ ...form, whenToUse: e.target.value })}
            placeholder={t('skill.skillManager.whenToUsePlaceholder')}
            rows={2}
            className={cn(inputCls, 'resize-y')}
          />
          <p className="text-[11px] text-[var(--wf-mut)] mt-1">{t('skill.skillManager.whenToUseHint')}</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="wf-sec-label block mb-1.5">{t('skill.skillManager.domain')}</label>
            <input
              type="text"
              value={form.domain}
              onChange={(e) => setForm({ ...form, domain: e.target.value })}
              placeholder="office / industrial / general"
              className={inputCls}
            />
          </div>
          <div>
            <label className="wf-sec-label block mb-1.5">{t('skill.skillManager.keywordSeparator')}</label>
            <input
              type="text"
              value={form.keywords}
              onChange={(e) => setForm({ ...form, keywords: e.target.value })}
              placeholder={t('skill.skillManager.keywordPlaceholder')}
              className={inputCls}
            />
          </div>

          <div className="flex items-start gap-2">
            <input
              type="checkbox"
              id="userInvocable"
              checked={form.userInvocable}
              onChange={(e) => setForm({ ...form, userInvocable: e.target.checked })}
              className="mt-0.5 rounded border-[var(--wf-line)] text-primary-500 focus:ring-[var(--wf-accent)]"
            />
            <label htmlFor="userInvocable" className="text-sm text-[var(--wf-sub)]">
              {t('skill.skillManager.userInvocable')}
              <span className="block text-[10px] text-[var(--wf-faint)] mt-0.5">
                {t('skill.skillManager.userInvocableHint')}
              </span>
            </label>
          </div>
        </div>
        <div>
          <label className="wf-sec-label block mb-1.5">{t('skill.skillManager.prompt')}</label>
          <textarea
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            rows={12}
            className={cn(inputCls, 'font-mono resize-y')}
          />
          <p className="text-[11px] text-[var(--wf-mut)] mt-1">{t('skill.skillManager.promptHint')}</p>
        </div>
        {saveError && <p className="text-[12px] text-[var(--wf-err-ink)]">{saveError}</p>}
      </div>

      {/* 钉底承诺脚（蓝图三段式） */}
      <div className="px-6 py-4 border-t border-[var(--wf-hair)] flex items-center justify-end gap-2">
        <button className="wf-mini-btn wf-press" onClick={onClose} disabled={saving}>
          {t('skill.skillManager.cancel')}
        </button>
        <button className="wf-promise" onClick={handleSave} disabled={saving}>
          {saving && <RefreshCw size={12} className="animate-spin" />}
          {isNew ? t('skill.skillManager.create') : t('skill.skillManager.save')}
        </button>
      </div>
    </>
  )
}

// ==================== 工具 ====================

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
