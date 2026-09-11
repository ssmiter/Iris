/**
 * 供应商预设库 —— 列表视图（2026-09-07 对齐 cc-switch，设置页二级页主体）
 *
 * 卡片 = 一个 ProviderProfile：名称/模型/协议徽标 + 在用态 + 探测行（连通性/额度）。
 * 探测只报事实：连通性=GET base_url 可达性+延迟；额度=URL 子串识别供应商，
 * 识别不了如实报"暂不支持"。
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Check, Pencil, Plus, RefreshCw, Trash2, Wifi } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/utils'
import { providerProbeApi, type ProbeUsageResult } from '@/api/client'
import { useProviderProfileStore } from '@/stores/providerProfileStore'
import {
  deriveProfileRuntime,
  PROFILE_PROVIDER_PREFIX,
  type ProviderProfile,
} from '@/types/providerProfile'
import { ProviderProfileEditPanel } from './ProviderProfileEditPanel'

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

interface CardProbe {
  ping?: { ok: boolean; latencyMs?: number; error?: string }
  usage?: ProbeUsageResult
  busy?: 'ping' | 'usage' | null
}

export function ProviderProfilesView() {
  const { t } = useTranslation()
  const profiles = useProviderProfileStore((s) => s.profiles)
  const activeId = useProviderProfileStore((s) => s.activeId)
  const loaded = useProviderProfileStore((s) => s.loaded)
  const { ensureLoaded, setActive, remove } = useProviderProfileStore.getState()

  // editing: null=列表；'new'=新增；否则=profile id
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [probes, setProbes] = useState<Record<string, CardProbe>>({})

  useEffect(() => {
    void ensureLoaded()
  }, [ensureLoaded])

  const setProbe = (id: string, patch: Partial<CardProbe>) =>
    setProbes((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))

  const handlePing = useCallback(async (profile: ProviderProfile) => {
    const derived = deriveProfileRuntime(profile)
    if (!derived) return
    setProbe(profile.id, { busy: 'ping' })
    try {
      const r = await providerProbeApi.ping(derived.baseUrl)
      setProbe(profile.id, { ping: { ok: r.ok, latencyMs: r.latencyMs, error: r.error }, busy: null })
    } catch (err) {
      setProbe(profile.id, { ping: { ok: false, error: String(err) }, busy: null })
    }
  }, [])

  const handleUsage = useCallback(async (profile: ProviderProfile) => {
    const derived = deriveProfileRuntime(profile)
    if (!derived) return
    if (!derived.apiKey) {
      toast.error(t('settings.providers.usageNeedKey'))
      return
    }
    setProbe(profile.id, { busy: 'usage' })
    try {
      const r = await providerProbeApi.usage({ baseUrl: derived.baseUrl, apiKey: derived.apiKey })
      setProbe(profile.id, { usage: r, busy: null })
    } catch (err) {
      setProbe(profile.id, {
        usage: { success: false, error: String(err) },
        busy: null,
      })
    }
  }, [t])

  const handleActivate = useCallback(async (profile: ProviderProfile) => {
    const derived = deriveProfileRuntime(profile)
    if (!derived) return
    await setActive(profile.id)
    // 兼容键：ChatView 激活恢复与旧路径都读 wonclaw_active_provider
    localStorage.setItem(
      'wonclaw_active_provider',
      JSON.stringify({ provider: PROFILE_PROVIDER_PREFIX + profile.id, model: derived.model, baseUrl: derived.baseUrl })
    )
    toast.success(t('settings.providers.activated', { name: profile.name }))
  }, [setActive, t])

  const handleDelete = useCallback(async (profile: ProviderProfile) => {
    if (!window.confirm(t('settings.providers.deleteConfirm', { name: profile.name }))) return
    await remove(profile.id)
  }, [remove, t])

  if (editing !== null) {
    return (
      <ProviderProfileEditPanel
        profileId={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
      />
    )
  }

  return (
    // 设计语言对齐能力页管理间（2026-09-07 打磨）：不再借用 wf-set-row 列表模板——
    // 每张供应商卡=独立白卡（14px 圆角/发丝边框/卡距 10px），段标 wf-sec-label，
    // 名称 14/600、副行 12px、协议徽标=mono 小 chip（技术串用 mono 呈现，不解释）、
    // 在用态=8px 状态点+文字（色彩只在点与小字，措辞承担信息）。
    <div>
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="wf-sec-label !mb-0">{t('settings.providers.sectionTitle')}</div>
        <button
          className="wf-mini-btn wf-press flex items-center gap-1"
          onClick={() => setEditing('new')}
        >
          <Plus size={12} />
          {t('settings.providers.add')}
        </button>
      </div>

      {!loaded ? (
        <div className="py-16 text-center text-[13px] text-[var(--wf-mut)]">{t('settings.providers.loading')}</div>
      ) : profiles.length === 0 ? (
        /* 空态与能力页同构：40px faint 图标 + 13px 主文 + 行动钮 */
        <div className="flex flex-col items-center justify-center py-16 gap-2">
          <Bot size={40} className="text-[var(--wf-faint)]" />
          <p className="text-[13px] text-[var(--wf-sub)]">{t('settings.providers.empty')}</p>
          <button
            className="wf-mini-btn wf-press mt-1.5 flex items-center gap-1"
            onClick={() => setEditing('new')}
          >
            <Plus size={12} />
            {t('settings.providers.add')}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {profiles.map((profile) => {
            const derived = deriveProfileRuntime(profile)
            const isActive = profile.id === activeId
            const probe = probes[profile.id]
            return (
              <div
                key={profile.id}
                className="flex items-center gap-3 rounded-[14px] border border-[var(--wf-line)] bg-[var(--wf-card-bg)] px-4 py-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-[var(--wf-ink)] truncate">{profile.name}</span>
                    <span className="font-mono text-[11px] px-1.5 py-px rounded-md border border-[var(--wf-line)] text-[var(--wf-mut)]">
                      {profile.meta.apiFormat === 'anthropic' ? 'Anthropic' : 'OpenAI'}
                    </span>
                    {isActive && (
                      <span className="flex items-center gap-1 text-xs text-[var(--wf-ok-ink)]">
                        <i className="w-1.5 h-1.5 rounded-full bg-[var(--wf-ok-ink)]" />
                        {t('settings.providers.inUse')}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[var(--wf-mut)] truncate mt-0.5">
                    {derived ? (
                      <><span className="font-mono">{derived.model}</span> · {hostOf(derived.baseUrl)}</>
                    ) : (
                      t('settings.providers.incomplete')
                    )}
                  </p>
                  {probe?.ping && (
                    <p className={cn('text-xs mt-1', probe.ping.ok ? 'text-[var(--wf-ok-ink)]' : 'text-[var(--wf-err-ink)]')}>
                      {probe.ping.ok
                        ? t('settings.providers.pingOk', { ms: probe.ping.latencyMs })
                        : t('settings.providers.pingFail', { error: probe.ping.error ?? '' })}
                    </p>
                  )}
                  {probe?.usage && (
                    <p className={cn('text-xs mt-1', probe.usage.success ? 'text-[var(--wf-ok-ink)]' : 'text-[var(--wf-faint)]')}>
                      {probe.usage.success
                        ? `${probe.usage.planName ?? ''} ${t('settings.providers.usageRemaining', {
                            remaining: formatAmount(probe.usage.remaining),
                            unit: probe.usage.unit ?? '',
                          })}`
                        : probe.usage.error}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {derived && (
                    <>
                      <IconBtn title={t('settings.providers.testPing')} onClick={() => void handlePing(profile)} spinning={probe?.busy === 'ping'}>
                        <Wifi size={14} />
                      </IconBtn>
                      <IconBtn title={t('settings.providers.queryUsage')} onClick={() => void handleUsage(profile)} spinning={probe?.busy === 'usage'}>
                        <RefreshCw size={14} />
                      </IconBtn>
                    </>
                  )}
                  {!isActive && derived && (
                    <button
                      className="wf-mini-btn wf-press"
                      onClick={() => void handleActivate(profile)}
                    >
                      {t('settings.providers.activate')}
                    </button>
                  )}
                  {isActive && <Check size={14} className="text-[var(--wf-ok-ink)] mx-1" />}
                  <IconBtn title={t('settings.providers.edit')} onClick={() => setEditing(profile.id)}>
                    <Pencil size={14} />
                  </IconBtn>
                  <IconBtn title={t('settings.providers.delete')} onClick={() => void handleDelete(profile)}>
                    <Trash2 size={14} />
                  </IconBtn>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 存储位置：白话一句 + 路径用 mono 呈现（技术串纪律） */}
      <div className="mt-3 px-1 text-[11px] text-[var(--wf-faint)]">
        {t('settings.providers.storageHint')}
        <span className="font-mono"> ~/.wonwork/providers.json</span>
      </div>
    </div>
  )
}

function IconBtn({
  title,
  onClick,
  spinning,
  children,
}: {
  title: string
  onClick: () => void
  spinning?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      className="wf-press p-1.5 rounded-md text-[var(--wf-mut)] hover:bg-[var(--wf-hover)] hover:text-[var(--wf-ink)] transition-colors"
      title={title}
      onClick={onClick}
      disabled={spinning}
    >
      <span className={cn('inline-block', spinning && 'animate-spin')}>{children}</span>
    </button>
  )
}

function formatAmount(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '-'
  return n % 1 === 0 ? String(n) : n.toFixed(2)
}
