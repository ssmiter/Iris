import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArchiveRestore,
  Boxes,
  CloudDownload,
  Download,
  Loader2,
  Package,
  RefreshCw,
  RotateCcw,
  Search,
  ServerCog,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { cn } from '@/utils'
import { useMescliPackageStore } from '@/stores/mescliPackageStore'
import type { MescliPackageListItem } from '@/types/mescliPackage'

export function MescliPackageManagerView() {
  const { t } = useTranslation()
  const store = useMescliPackageStore()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [dragging, setDragging] = useState(false)
  // Code 只活在视图内存：不落 store、不持久化，刷新页面即清
  const [pullCode, setPullCode] = useState('')
  const canPull = pullCode.trim().length > 0 && !store.isLoading
  const pull = () => { if (canPull) void store.pull(pullCode.trim()) }

  useEffect(() => {
    void Promise.all([store.load(), store.loadSystems(), store.checkUpdates()])
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const filtered = store.packages.filter((item) =>
      `${item.displayName} ${item.packageId} ${item.systemCode}`.toLowerCase().includes(query.trim().toLowerCase()))
    return Object.values(filtered.reduce<Record<string, MescliPackageListItem[]>>((result, item) => {
      ;(result[item.packageId] ??= []).push(item)
      return result
    }, {}))
  }, [store.packages, query])

  const install = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      await store.install(file)
    } finally {
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  // 拖入安装：只在携带文件时接管拖拽；扩展名不合法由 store.install 走错误条如实告知
  const onDragOver = (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    setDragging(true)
  }
  const onDrop = (event: React.DragEvent) => {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files?.[0]
    if (file) void store.install(file)
  }

  return (
    /* flex-1 min-w-0 是 ww-main-content（row flex）直子的存活条件（Skill/MCP 管理页同款教训） */
    <div
      className="wf-pkg relative flex flex-col h-full flex-1 min-w-0 wf-chat-bg"
      onDragOver={onDragOver}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false) }}
      onDrop={onDrop}
    >
      {/* 拖放蒙层：不遮挡指针（pointer-events-none），松手即装 */}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-[var(--wf-accent,#6366f1)] wf-pkg-card-bg px-10 py-8 shadow-lg">
            <Upload size={22} className="wf-pkg-sub" />
            <span className="text-[13px] font-medium wf-pkg-ink">{t('mescliPackage.dropHint')}</span>
          </div>
        </div>
      )}
      {/* 滚动容器 = 页头 + 内容（scrollbar-gutter 治理，Skill 管理页同款） */}
      <div className="flex-1 overflow-y-auto wf-room-scroll">
        {/* sticky 页头：图标块+标题副标题左置，刷新/安装右置；统计行+搜索住进同槽 */}
        <div className="sticky top-0 z-10 wf-chat-bg max-w-[1200px] w-full mx-auto px-8 pt-7">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="wf-pkg-icon wf-pkg-icon-lg">
                <Boxes size={17} />
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-[20px] font-bold wf-pkg-ink">{t('mescliPackage.title')}</h1>
                  <span className="text-[10px] font-medium wf-pkg-sub wf-pkg-mono-bg wf-pkg-bline rounded-full px-2 py-0.5">
                    {t('mescliPackage.localOnly')}
                  </span>
                </div>
                <p className="text-[13px] wf-pkg-mut mt-1">{t('mescliPackage.subtitle')}</p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-1 flex-wrap">
              {/* Code 一键拉取（2026-08-20）：填了 Code 才点亮，只认点击/回车这类显式动作，绝不自动拉取。
                  2026-09-07 起这是获取/更新专属工具包的唯一客户端路径（官网下载页已下线）。 */}
              <input
                value={pullCode}
                onChange={(event) => setPullCode(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') pull() }}
                placeholder={t('mescliPackage.pullCodePlaceholder')}
                className="wf-ink-input w-28"
              />
              <button
                onClick={pull}
                disabled={!canPull}
                className="wf-mini-btn wf-press"
                title={t('mescliPackage.pull')}
              >
                <CloudDownload size={12} />
                {t('mescliPackage.pull')}
              </button>
              <button
                onClick={() => void Promise.all([store.load(), store.checkUpdates()])}
                className="wf-mini-btn wf-press"
                title={t('mescliPackage.refresh')}
              >
                <RefreshCw size={12} className={cn(store.isLoading && 'animate-spin')} />
                {t('mescliPackage.refresh')}
              </button>
              <input ref={inputRef} type="file" accept=".wwtool" className="hidden" onChange={install} />
              <button
                onClick={() => inputRef.current?.click()}
                disabled={store.isLoading}
                className="wf-cta wf-press"
              >
                {store.isLoading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                {t('mescliPackage.install')}
              </button>
            </div>
          </div>

          {/* 统计 Metric 行 + 搜索（Skill 页同款底部细分隔）
              2026-08-12 用户反馈重排：去掉挤在左上角的缝隙小格，改宽松 stat 组——
              图标+上下两排（标签 11px mut / 数值 16px 半粗 ink），组间 gap-8 */}
          <div className="flex items-center justify-between gap-4 mt-5 pb-4 border-b wf-pkg-bhair">
            <div className="flex items-center gap-8 px-1">
              <Metric icon={<ServerCog size={15} />} label={t('mescliPackage.systems')} value={store.systems.filter((s) => s.isEnabled).length} />
              <Metric icon={<Boxes size={15} />} label={t('mescliPackage.packages')} value={new Set(store.packages.map((p) => p.packageId)).size} />
              <Metric icon={<Download size={15} />} label={t('mescliPackage.updates')} value={store.updates.length} accent={store.updates.length > 0} />
            </div>
            <div className="relative w-72 flex-none">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 wf-pkg-mut pointer-events-none" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('mescliPackage.search')}
                className="wf-ink-input w-full !pl-8"
              />
            </div>
          </div>
        </div>

        {/* 通知条：语义色保留（amber 重启 / red 错误），卡片式新风格 */}
        {store.restartRequired && (
          <div className="max-w-[1200px] w-full mx-auto px-8 mt-4">
            <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-[var(--wf-warn-bg)] border border-[var(--wf-warn-line)] rounded-xl text-xs text-[var(--wf-warn-ink)]">
              <div className="flex items-center gap-2">
                <RotateCcw size={14} className="text-[var(--wf-warn-ink)] flex-none" />
                {t('mescliPackage.restartRequired')}
              </div>
              <button onClick={store.clearRestartNotice} aria-label={t('mescliPackage.dismiss')} className="wf-pkg-ghost wf-press"><X size={14} /></button>
            </div>
          </div>
        )}
        {store.error && (
          <div className="max-w-[1200px] w-full mx-auto px-8 mt-4">
            <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-[var(--wf-err-bg)] border border-[var(--wf-err-line)] rounded-xl text-xs text-[var(--wf-err-ink)]">
              <span>{store.error}</span>
              <button onClick={store.clearError} aria-label={t('mescliPackage.dismiss')} className="wf-pkg-ghost wf-press"><X size={14} /></button>
            </div>
          </div>
        )}

        <main className="max-w-[1200px] w-full mx-auto px-8 py-6">
          {groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center gap-3">
              <ArchiveRestore size={44} strokeWidth={1.25} className="wf-pkg-mut" />
              <p className="text-[13px] font-medium wf-pkg-ink">{t('mescliPackage.empty')}</p>
              <p className="text-[12px] wf-pkg-mut">{t('mescliPackage.emptyHint')}</p>
              <p className="text-[11px] wf-pkg-faint">{t('mescliPackage.pullHint')}</p>
              {/* 空态=新客户最可能的状态：主引导是 Code 拉取，拖入安装作线下交付兜底 */}
              <button onClick={() => inputRef.current?.click()} disabled={store.isLoading} className="wf-cta wf-press mt-2">
                <Upload size={13} />
                {t('mescliPackage.emptyInstall')}
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2 items-start">
              {groups.map((versions) => <PackageCard key={versions[0].packageId} versions={versions} />)}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

function Metric({ icon, label, value, accent = false }: { icon: React.ReactNode; label: string; value: number; accent?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className={cn('wf-pkg-mut flex-none', accent && 'text-[var(--wf-warn-ink)]')}>{icon}</span>
      <div className="flex flex-col gap-px">
        <span className="text-[11px] leading-4 wf-pkg-mut">{label}</span>
        <strong className={cn('text-[16px] leading-5 font-semibold wf-pkg-ink tabular-nums', accent && 'text-[var(--wf-warn-ink)]')}>{value}</strong>
      </div>
    </div>
  )
}

function PackageCard({ versions }: { versions: MescliPackageListItem[] }) {
  const { t } = useTranslation()
  const store = useMescliPackageStore()
  const active = versions.find((item) => item.state === 'Active') ?? versions[0]
  const previous = versions.find((item) => item.state === 'Previous')
  const update = store.updates.find((item) => item.packageId === active.packageId)
  return (
    <article className="wf-pkg-card">
      <div className="flex items-start justify-between gap-4 p-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="wf-pkg-icon wf-pkg-icon-sm">
              <Package size={15} />
            </span>
            <h2 className="truncate text-sm font-semibold wf-pkg-ink">{active.displayName}</h2>
            <span className="rounded-md wf-pkg-mono-bg wf-pkg-bline px-1.5 py-0.5 font-mono text-[10px] wf-pkg-sub">{active.systemCode}</span>
            {/* 有更新：accent 徽章，引导在页头输入 Code 拉取（2026-09-07 起替代旧"跳官网下载页"绕路） */}
            {update && (
              <span
                className="rounded-md px-1.5 py-0.5 text-[10px] font-medium text-[var(--wf-accent,#6366f1)] border border-[var(--wf-accent,#6366f1)]/40"
              >
                {t('mescliPackage.updateAvailable', { version: update.version })}
              </span>
            )}
          </div>
          <p className="mt-2 font-mono text-[11px] wf-pkg-mut">{active.packageId}</p>
        </div>
        <button
          role="switch"
          aria-checked={active.isEnabled}
          onClick={() => void store.setEnabled(active.packageId, !active.isEnabled)}
          className={cn('wf-switch wf-press', active.isEnabled && 'on')}
          title={active.isEnabled ? t('mescliPackage.disable') : t('mescliPackage.enable')}
        >
          <span className="knob" />
        </button>
      </div>
      <div className="grid grid-cols-2 border-y wf-pkg-bhair wf-pkg-mono-bg px-5 py-3 text-xs">
        <div className="wf-pkg-mut">{t('mescliPackage.activeVersion')}<strong className="ml-2 font-mono wf-pkg-ink">v{active.version}</strong></div>
        <div className="wf-pkg-mut">{t('mescliPackage.previousVersion')}<strong className="ml-2 font-mono wf-pkg-ink">{previous ? `v${previous.version}` : '—'}</strong></div>
      </div>
      <div className="flex items-center justify-between px-5 py-3">
        <span className="text-[10px] wf-pkg-faint">{new Date(active.installedAtUtc).toLocaleString()}</span>
        <div className="flex items-center gap-1">
          <button
            disabled={!previous}
            onClick={() => previous && void store.rollback(active.packageId)}
            className="wf-pkg-ghost wf-press"
          ><ArchiveRestore size={12} />{t('mescliPackage.rollback')}</button>
          <button
            onClick={() => confirm(t('mescliPackage.uninstallConfirm', { name: active.displayName })) && void store.uninstall(active.packageId)}
            className="wf-pkg-ghost wf-pkg-danger wf-press"
          ><Trash2 size={12} />{t('mescliPackage.uninstall')}</button>
        </div>
      </div>
    </article>
  )
}
