import { useEffect, useRef, useState, type CSSProperties, type ReactNode, Children } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/utils'
import { useSettingsOverlayStore } from '@/stores/settingsOverlayStore'
import { useSettingsStore, type ThemeMode, type ThemeHue } from '@/stores/settingsStore'
import { useAuthStore } from '@/stores/authStore'
import { useFileMemoryStore } from '@/stores/fileMemoryStore'
import { useMemoryDockStore } from '@/stores/memoryDockStore'
import { useUpdateStore } from '@/stores/updateStore'
import { useAdminStore } from '@/stores/adminStore'
import { useRuntimeConfigStore } from '@/stores/runtimeConfigStore'
import { applyAccent, applyHue, resolveTheme } from '@/utils/theme'
import { productDisplayName } from '@/config/product'
import { PERMISSION_MODE_OPTIONS } from '@/components/chat/InputArea'
import type { ExecutionMode } from '@/agent/types'

import { SecurityGatewaySettingsView } from './SecurityGatewaySettingsView'
import { UpdateSettingsView } from './UpdateSettingsView'
import { AdminSettingsView } from './AdminSettingsView'
import { DatabaseSettingsView } from './DatabaseSettingsView'
import { WorkspaceSettingsView } from './WorkspaceSettingsView'
import { ProviderProfilesView } from './ProviderProfilesView'

import { Sun, Globe, ShieldCheck, Brain, ChevronDown, ChevronRight, PanelTop, PanelRightOpen, MessagesSquare, ArrowDownToLine, Bot } from 'lucide-react'

interface SettingsOverlayProps {
  // 【Iris 2026-09】onOpenLogin 已随登录体系删除：本地个人版无登录入口
}

function ExpandableRow({
  icon,
  title,
  subtitle,
  right,
  open,
  onToggle,
  children,
  chevron = 'down',
}: {
  icon: ReactNode
  title: string
  subtitle?: string
  right?: ReactNode
  open?: boolean
  onToggle?: () => void
  children?: ReactNode
  chevron?: 'down' | 'right'
}) {
  return (
    <>
      <div className="wf-set-row wf-press" onClick={onToggle}>
        <span className="wf-set-row-ic">{icon}</span>
        <div>
          <div className="wf-set-row-nm">{title}</div>
          {subtitle && <div className="wf-set-row-sub">{subtitle}</div>}
        </div>
        <span className="wf-set-row-r">
          {right}
          {chevron === 'right' ? (
            <ChevronRight size={16} className="wf-set-chev" />
          ) : (
            <ChevronDown size={16} className={cn('wf-set-chev', open && 'open')} />
          )}
        </span>
      </div>
      {chevron === 'down' && children && (
        <div className={cn('wf-collapse', !open && 'wf-collapsed')}>
          <div className="wf-collapse-inner">{children}</div>
        </div>
      )}
    </>
  )
}

/** 行为开关行：wf-set-row + wf-switch，开关是唯一交互点（行本身不可点） */
function SwitchRow({
  icon,
  title,
  subtitle,
  checked,
  onChange,
}: {
  icon: ReactNode
  title: string
  subtitle?: string
  checked: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <div className="wf-set-row">
      <span className="wf-set-row-ic">{icon}</span>
      <div className="min-w-0">
        <div className="wf-set-row-nm">{title}</div>
        {subtitle && <div className="wf-set-row-sub">{subtitle}</div>}
      </div>
      <span className="wf-set-row-r">
        <button
          role="switch"
          aria-checked={checked}
          onClick={() => onChange(!checked)}
          className={cn('wf-switch', checked && 'on')}
        >
          <span className="knob" />
        </button>
      </span>
    </div>
  )
}

/** 「对话体验」组：顶栏自动隐藏 + 右缘悬停显示进展入口 + 滚动跟随模式（读写 settingsStore，已 persist，即时生效） */
function ChatExperienceRows() {
  const { t } = useTranslation()
  const topbarAutoHide = useSettingsStore((s) => s.topbarAutoHide)
  const rightPanelEdgeHover = useSettingsStore((s) => s.rightPanelEdgeHover)
  const scrollFollow = useSettingsStore((s) => s.scrollFollow)
  const setTopbarAutoHide = useSettingsStore((s) => s.setTopbarAutoHide)
  const setRightPanelEdgeHover = useSettingsStore((s) => s.setRightPanelEdgeHover)
  const setScrollFollow = useSettingsStore((s) => s.setScrollFollow)

  return (
    <>
      <SwitchRow
        icon={<ArrowDownToLine size={16} />}
        title={t('settings.overlay.scrollFollowAuto')}
        subtitle={t('settings.overlay.scrollFollowAutoSub')}
        checked={scrollFollow === 'auto'}
        onChange={(on) => setScrollFollow(on ? 'auto' : 'manual')}
      />
      <SwitchRow
        icon={<PanelTop size={16} />}
        title={t('settings.overlay.topbarAutoHide')}
        subtitle={t('settings.overlay.topbarAutoHideSub')}
        checked={topbarAutoHide}
        onChange={setTopbarAutoHide}
      />
      <SwitchRow
        icon={<PanelRightOpen size={16} />}
        title={t('settings.overlay.rightPanelEdgeHover')}
        subtitle={t('settings.overlay.rightPanelEdgeHoverSub')}
        checked={rightPanelEdgeHover}
        onChange={setRightPanelEdgeHover}
      />
    </>
  )
}

function Group({ title, children, bare }: { title: string; children: ReactNode; bare?: boolean }) {
  const items = Children.toArray(children).filter(Boolean)
  if (items.length === 0) return null
  // bare=内容自带卡片形态（ProviderProfilesView 等自带白卡列表、旧设置卡经 wf-set-embed 归一），
  // 不再外包 gcard，避免卡中卡；行式内容（ThemeRow 等）仍统一进 gcard
  return (
    <div className="wf-set-group">
      <div className="wf-set-group-t">{title}</div>
      {bare ? <div className="wf-set-embed">{items}</div> : <div className="wf-set-gcard">{items}</div>}
    </div>
  )
}

function AccountCard() {
  const { t } = useTranslation()
  // 【Iris 2026-09】恒为固定本地身份：无登录态/多身份徽标，卡片只读展示
  const { user } = useAuthStore()

  const avatarChar = user.realName?.[0] || user.userName?.[0] || '?'
  const displayName = user.realName || user.userName || ''
  const subtitle = user.systemCode === 'local' ? 'Iris Local' : `${user.userName} · ${user.systemCode}`

  return (
    <div className="wf-set-acct">
      <div className={cn('wf-set-acct-avatar')}>{avatarChar}</div>
      <div className="wf-set-acct-id">
        <div className="wf-set-acct-nm" title={displayName}>
          <span className="wf-set-acct-name">{displayName}</span>
        </div>
        <div className="wf-set-acct-sub" title={subtitle}>{subtitle}</div>
      </div>
    </div>
  )
}

function ThemeRow() {
  const { t } = useTranslation()
  const { theme, setTheme, hue, setHue, accent, setAccent } = useSettingsStore()
  const [open, setOpen] = useState(false)
  // 色调预览随当前生效明暗取 light/dark 组（auto 时跟随系统实时刷新）
  const [isDark, setIsDark] = useState(() => resolveTheme(theme) === 'dark')
  const colorInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (theme !== 'auto') {
      setIsDark(theme === 'dark')
      return
    }
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const sync = () => setIsDark(mql.matches)
    sync()
    mql.addEventListener('change', sync)
    return () => mql.removeEventListener('change', sync)
  }, [theme])

  const options: { value: ThemeMode; label: string }[] = [
    { value: 'light', label: t('settings.overlay.themeLight') },
    { value: 'dark', label: t('settings.overlay.themeDark') },
    { value: 'auto', label: t('settings.overlay.themeAuto') },
  ]
  const current = options.find((o) => o.value === theme) ?? options[2]

  const hueOptions: { value: ThemeHue; label: string }[] = [
    { value: 'neutral', label: t('settings.overlay.hueNeutral') },
    { value: 'warm', label: t('settings.overlay.hueWarm') },
    { value: 'cool', label: t('settings.overlay.hueCool') },
  ]

  // 蓝图 HUE_PV：三色调预览块（底块/顶条/文字条）按明暗两组
  const HUE_PV: Record<ThemeHue, { light: string[]; dark: string[] }> = {
    neutral: { light: ['#f9f9f9', '#ffffff', '#1c1c1c'], dark: ['#131313', '#1e1e1e', '#ececec'] },
    warm: { light: ['#f7f6f3', '#ffffff', '#1d1b17'], dark: ['#14120f', '#1f1c17', '#ece8e0'] },
    cool: { light: ['#f9f9f9', '#edf0f5', '#1c1c1c'], dark: ['#131313', '#232a35', '#ececec'] },
  }
  const group = isDark ? 'dark' : 'light'

  const ACCENT_PRESETS = ['#16a34a', '#2563eb', '#7c3aed', '#ea580c', '#db2777', '#0891b2']
  const accentHex = (accent || '#16a34a').toLowerCase()
  const presetHit = ACCENT_PRESETS.find((c) => c === accentHex)
  const isCustomAccent = !presetHit

  const pickCustom = () => colorInputRef.current?.click()

  return (
    <ExpandableRow
      icon={<Sun size={16} />}
      title={t('settings.overlay.theme')}
      right={<span className="wf-set-row-val">{current.label}</span>}
      open={open}
      onToggle={() => setOpen((o) => !o)}
    >
      <div className="wf-set-expand-pad">
        <div className="wf-set-opts">
          {options.map((opt) => (
            <button
              key={opt.value}
              className={cn('wf-set-opt', theme === opt.value && 'on')}
              onClick={() => setTheme(opt.value)}
            >
              <span className="r"></span>
              {opt.label}
            </button>
          ))}
        </div>

        <div className="wf-tune-row">
          <span className="wf-tune-lab">{t('settings.overlay.themeHue')}</span>
          <div className="wf-hues">
            {hueOptions.map((opt) => {
              const pv = HUE_PV[opt.value][group]
              return (
                <button
                  key={opt.value}
                  className={cn('wf-hue', hue === opt.value && 'on')}
                  onClick={() => {
                    setHue(opt.value)
                    applyHue(opt.value)
                  }}
                  style={{ '--hb': pv[0], '--hc': pv[1], '--ht': pv[2] } as CSSProperties}
                >
                  <i></i>
                  {opt.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="wf-tune-row">
          <span className="wf-tune-lab">{t('settings.overlay.accentColor')}</span>
          <div className="wf-hues">
            {ACCENT_PRESETS.map((c) => (
              <button
                key={c}
                className={cn('wf-swa', accentHex === c && 'on')}
                onClick={() => {
                  setAccent(c)
                  applyAccent(c)
                }}
                style={{ '--c': c } as CSSProperties}
                aria-label={c}
              />
            ))}
            <button
              className={cn('wf-swa', 'custom', isCustomAccent && 'on', isCustomAccent && 'user-set')}
              onClick={pickCustom}
              title={t('settings.overlay.accentCustom')}
              style={isCustomAccent ? ({ '--c': accentHex } as CSSProperties) : undefined}
            >
              {isCustomAccent ? '' : '+'}
            </button>
            <input
              ref={colorInputRef}
              type="color"
              hidden
              value={accentHex}
              onChange={(e) => {
                const v = e.target.value
                setAccent(v)
                applyAccent(v)
              }}
            />
          </div>
        </div>
      </div>
    </ExpandableRow>
  )
}

function LanguageRow() {
  const { t, i18n } = useTranslation()
  const { setLanguage } = useSettingsStore()
  const [open, setOpen] = useState(false)

  const currentLanguage = i18n.language as 'zh-CN' | 'en-US'
  const options: { value: 'zh-CN' | 'en-US'; label: string }[] = [
    { value: 'zh-CN', label: t('settings.settingsView.chinese', { defaultValue: '简体中文' }) },
    { value: 'en-US', label: t('settings.settingsView.english', { defaultValue: 'English' }) },
  ]
  const current = options.find((o) => o.value === currentLanguage) ?? options[0]

  return (
    <ExpandableRow
      icon={<Globe size={16} />}
      title={t('settings.overlay.language')}
      right={<span className="wf-set-row-val">{current.label}</span>}
      open={open}
      onToggle={() => setOpen((o) => !o)}
    >
      <div className="wf-set-expand-pad">
        <div className="wf-set-opts">
          {options.map((opt) => (
            <button
              key={opt.value}
              className={cn('wf-set-opt', currentLanguage === opt.value && 'on')}
              onClick={() => setLanguage(opt.value)}
            >
              <span className="r"></span>
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </ExpandableRow>
  )
}

function PermissionModeRow() {
  const { t } = useTranslation()
  const { permissionMode, setPermissionMode } = useSettingsStore()
  const [open, setOpen] = useState(false)

  const current = PERMISSION_MODE_OPTIONS.find((o) => o.value === permissionMode) ?? PERMISSION_MODE_OPTIONS[1]

  return (
    <ExpandableRow
      icon={<ShieldCheck size={16} />}
      title={t('settings.overlay.permissionMode')}
      right={<span className="wf-set-row-val">
        {t(current.labelKey, { defaultValue: current.fallback })}
      </span>}
      open={open}
      onToggle={() => setOpen((o) => !o)}
    >
      <div className="wf-set-expand-pad">
        <div className="wf-set-opts">
          {PERMISSION_MODE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={cn('wf-set-opt', permissionMode === opt.value && 'on')}
              onClick={() => setPermissionMode(opt.value as ExecutionMode)}
            >
              <span className="r"></span>
              {t(opt.labelKey, { defaultValue: opt.fallback })}
            </button>
          ))}
        </div>
        <p style={{ fontSize: 12, color: 'var(--wf-mut)', marginTop: 10, marginBottom: 0 }}>
          {t('settings.settingsView.permissionModeHint', {
            defaultValue:
              '全部自动模式下破坏性操作（删文件/删表）仍会请求确认；对话栏下拉可为单个会话临时覆盖',
          })}
        </p>
      </div>
    </ExpandableRow>
  )
}

function MemoryRow() {
  const { t } = useTranslation()
  // zustand 选择器必须返回原始值（对象字面量每次新引用会触发无限重渲染告警）
  const initialized = useFileMemoryStore((s) => s.initialized)
  const initialize = useFileMemoryStore((s) => s.initialize)
  const count = useFileMemoryStore((s) => s.entries.length)

  useEffect(() => {
    if (!initialized) {
      void initialize()
    }
  }, [initialized, initialize])

  return (
    <ExpandableRow
      icon={<Brain size={16} />}
      title={t('settings.overlay.memory')}
      right={<span className="wf-set-row-val">{t('settings.overlay.memoryCount', { count })}</span>}
      chevron="right"
      onToggle={() => {
        useSettingsOverlayStore.getState().close()
        useMemoryDockStore.getState().open()
      }}
    />
  )
}

export function SettingsOverlay(_props: SettingsOverlayProps) {
  const { t } = useTranslation()
  const isOpen = useSettingsOverlayStore((s) => s.isOpen)
  const { close } = useSettingsOverlayStore()
  const version = useUpdateStore((s) => s.currentVersion)
  const devModeUnlocked = useSettingsStore((s) => s.devModeUnlocked)
  const isElevated = useAdminStore((s) => s.isElevated)
  const runtimeCfg = useRuntimeConfigStore((s) => s.config)

  // 「对话体验」二级页（2026-08-13 用户拍板升级为独立页，后续对话页设置都进这里）。
  // 形态=滑入覆盖层（.wf-set-sub，fixed 铺满设置层上方右滑入），不采用用户菜单的
  // 200% 双栏滑移：设置主页很长，双栏会互相牵连滚动位置与容器高度；滑入层独立
  // 滚动，返回时主页滚动位置天然原样保留。
  const [chatExpPage, setChatExpPage] = useState(false)

  // 「模型与 API」二级页（2026-09-07 供应商预设库对齐 cc-switch）：
  // 供应商卡片列表 + 添加/编辑面板。
  const [providerPage, setProviderPage] = useState(false)

  // 设置层整个关闭后复位到主页，下次打开永远落在主页
  useEffect(() => {
    if (!isOpen) {
      setChatExpPage(false)
      setProviderPage(false)
    }
  }, [isOpen])

  if (!isOpen) return null

  // 【Iris 2026-09】付费体系已删除：Iris 无套餐/额度/支付，showPayment/manageContent 移除

  // 【Iris 2026-09 二轮】BYOK 多 Key 车道与内联 modelApiContent 已删除——
  // cc-switch 式供应商预设库（ProviderProfilesView）是唯一的 API 配置通道，
  // 经「模型与 API」二级页（providerPage）进入。

  const adminAvailable = devModeUnlocked && runtimeCfg.adminElevationAvailable === true
  const dbAvailable = devModeUnlocked && isElevated

  return (
    <div className="wf-set-overlay">
      <div className="wf-set-head">
        <div className="wf-set-head-in">
          <button className="wf-set-back wf-press" onClick={close}>
            <ChevronRight size={16} style={{ transform: 'rotate(180deg)' }} />
            {t('settings.overlay.back')}
          </button>
          <span className="wf-set-title">{t('settings.overlay.title')}</span>
        </div>
      </div>

      <div className="wf-set-page">
        <AccountCard />

        <Group title={t('settings.overlay.groupGeneral')}>
          <ThemeRow />
          <LanguageRow />
        </Group>

        <Group title={t('settings.overlay.groupSession')}>
          <PermissionModeRow />
        </Group>

        <Group title={t('settings.overlay.groupPersonal')}>
          <MemoryRow />
        </Group>

        <Group title={t('settings.overlay.groupChat')}>
          <ExpandableRow
            icon={<MessagesSquare size={16} />}
            title={t('settings.overlay.groupChat')}
            subtitle={t('settings.overlay.groupChatSub')}
            chevron="right"
            onToggle={() => setChatExpPage(true)}
          />
        </Group>

        <Group title={t('settings.overlay.groupWorkspace')}>
          <WorkspaceSettingsView />
        </Group>

        <Group title={t('settings.overlay.groupModel')}>
          <ExpandableRow
            icon={<Bot size={16} />}
            title={t('settings.overlay.groupModel')}
            subtitle={t('settings.overlay.groupModelSub')}
            chevron="right"
            onToggle={() => setProviderPage(true)}
          />
        </Group>

        {/* 【Iris 2026-09】付费管理组（额度/支付）已随付费体系删除 */}

        <Group title={t('settings.overlay.groupAbout')} bare>
          <UpdateSettingsView />
        </Group>

        {(adminAvailable || dbAvailable) && (
          <Group title={t('settings.overlay.groupDev')} bare>
            {adminAvailable && <AdminSettingsView />}
            {dbAvailable && <DatabaseSettingsView />}
          </Group>
        )}

        <div className="wf-set-foot">
          {productDisplayName} · v{version}
        </div>
      </div>

      {/* 「对话体验」二级页：常挂载 + class 切换，进出双向滑移；aria/pointer-events
          由 .wf-set-sub(:not(.open)) 的 visibility/pointer-events 关停。
          新增对话页设置项 → 往卡里追加行即可（当前保持两项）。 */}
      <div className={cn('wf-set-sub', chatExpPage && 'open')} aria-hidden={!chatExpPage}>
        <div className="wf-set-head">
          <div className="wf-set-head-in">
            <button className="wf-set-back wf-press" onClick={() => setChatExpPage(false)}>
              <ChevronRight size={16} style={{ transform: 'rotate(180deg)' }} />
              {t('settings.overlay.back')}
            </button>
            <span className="wf-set-title">{t('settings.overlay.groupChat')}</span>
          </div>
        </div>
        <div className="wf-set-page">
          <div className="wf-set-gcard">
            <ChatExperienceRows />
          </div>
        </div>
      </div>

      {/* 「模型与 API」二级页（2026-09-07 供应商预设库）：与对话体验同款滑入覆盖层。
          主体=供应商卡片列表（ProviderProfilesView 自带 gcard）。
          【Iris 2026-09 二轮】BYOK 多 Key 卡已删除，预设库是唯一配置通道。 */}
      <div className={cn('wf-set-sub', providerPage && 'open')} aria-hidden={!providerPage}>
        <div className="wf-set-head">
          <div className="wf-set-head-in">
            <button className="wf-set-back wf-press" onClick={() => setProviderPage(false)}>
              <ChevronRight size={16} style={{ transform: 'rotate(180deg)' }} />
              {t('settings.overlay.back')}
            </button>
            <span className="wf-set-title">{t('settings.overlay.groupModel')}</span>
          </div>
        </div>
        <div className="wf-set-page">
          <ProviderProfilesView />
        </div>
      </div>
    </div>
  )
}
