import { useCallback, useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/utils'
import { toast } from 'sonner'
import {
  ApiError,
  securityGatewayApi,
  type SecurityGatewayAuditEvent,
  type SecurityGatewayPreference,
  type SecurityGatewayRule,
  type SecurityGatewayStats,
} from '@/api/client'
import { useSecurityGatewayViewStore } from '@/stores/securityGatewayViewStore'
import {
  Building2,
  ChevronRight,
  Contact,
  CreditCard,
  Info,
  KeyRound,
  Lock,
  Mail,
  ShieldCheck,
  Smartphone,
} from 'lucide-react'

type IconComp = ComponentType<{ size?: number | string; className?: string }>

/** 六类固定规则图标（按类型中文名映射；未知类型回退盾牌） */
const RULE_ICONS: Record<string, IconComp> = {
  身份证: Contact,
  信用代码: Building2,
  手机号: Smartphone,
  银行卡: CreditCard,
  邮箱: Mail,
  凭据: KeyRound,
}

/** 旧版后端（404）时页面结构兜底：六类默认规则（与后端 builtin 顺序一致，仅占位展示，禁用态） */
const FALLBACK_RULES: SecurityGatewayRule[] = [
  { type: '身份证', enabled: true, sample: '⟦身份证_7F3E9A21⟧' },
  { type: '信用代码', enabled: true, sample: '⟦信用代码_91MA5K⟧' },
  { type: '手机号', enabled: true, sample: '⟦手机号_A1B2C3D4⟧' },
  { type: '银行卡', enabled: true, sample: '⟦银行卡_62E8F0A9⟧' },
  { type: '邮箱', enabled: false, sample: '⟦邮箱_Q8W3ER5T⟧' },
  { type: '凭据', enabled: true, sample: '⟦凭据_K2Q9X7⟧' },
]

/** 后端 UTC "yyyy-MM-dd HH:mm:ss" → 本地 "MM-DD HH:mm"（语言无关数字排版） */
function formatUtcToLocal(utc: string): string {
  const d = new Date(utc.replace(' ', 'T') + 'Z')
  if (Number.isNaN(d.getTime())) return utc
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404
}

/**
 * 数据安全网关仪表盘（第三层覆盖层，2026-08-11）。
 *
 * 契约见 learn/05/workshop/数据安全网关仪表盘-前端设计交接-2026-08-10.md。
 * 五态：normal / empty（正常但无命中）/ guest（未登录 MES）/ admin（管理员关闭）/ legacy（旧版后端 404）。
 * 开关权威全在后端：进页 GET 一次，乐观翻转 + 失败回滚 + toast；canEnable/reason 完全由后端裁决。
 */
export function SecurityGatewayView() {
  const { t } = useTranslation()
  const isOpen = useSecurityGatewayViewStore((s) => s.isOpen)
  const close = useSecurityGatewayViewStore((s) => s.close)

  const [loading, setLoading] = useState(true)
  const [legacy, setLegacy] = useState(false)
  const [pref, setPref] = useState<SecurityGatewayPreference | null>(null)
  const [rules, setRules] = useState<SecurityGatewayRule[]>([])
  const [events, setEvents] = useState<SecurityGatewayAuditEvent[]>([])
  const [stats, setStats] = useState<SecurityGatewayStats | null>(null)
  const [savingMaster, setSavingMaster] = useState(false)
  const [savingRuleType, setSavingRuleType] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setLoading(true)
    setLegacy(false)

    const load = async () => {
      const settled = await Promise.allSettled([
        securityGatewayApi.getPreference(),
        securityGatewayApi.getRules(),
        securityGatewayApi.getAudit(20),
        securityGatewayApi.getStats(),
      ])
      if (cancelled) return
      // 任一读端点 404 → 旧版后端，整页降级锁定
      if (settled.some((r) => r.status === 'rejected' && isNotFound(r.reason))) {
        setLegacy(true)
        setLoading(false)
        return
      }
      const [p, r, a, s] = settled
      if (p.status === 'fulfilled') setPref(p.value)
      if (r.status === 'fulfilled') setRules(r.value.rules ?? [])
      if (a.status === 'fulfilled') setEvents(a.value.events ?? [])
      if (s.status === 'fulfilled') setStats(s.value)
      setLoading(false)
    }
    void load()

    return () => {
      cancelled = true
    }
  }, [isOpen])

  const enabled = pref?.enabled ?? false
  const canEnable = pref?.canEnable ?? false
  const scene: 'normal' | 'guest' | 'admin' | 'legacy' = legacy
    ? 'legacy'
    : pref?.reason === 'gateway_disabled'
      ? 'admin'
      : !canEnable
        ? 'guest'
        : 'normal'

  // guest/admin/legacy 下全部控件禁用（含总开关与规则行开关）
  const controlsDisabled = legacy || scene === 'guest' || scene === 'admin' || !pref

  const bannerText =
    scene === 'legacy'
      ? t('settings.gateway.legacyBanner')
      : scene === 'guest'
        ? t('settings.gateway.guestBanner')
        : scene === 'admin'
          ? t('settings.gateway.adminBanner')
          : null

  const displayRules = rules.length > 0 ? rules : FALLBACK_RULES

  // 规则类型名：后端返回固定中文类型名（icon 映射也按它匹配），展示层按当前语言翻译，未知类型原样透传
  const ruleTypeLabel = useCallback(
    (type: string) => t(`settings.gateway.ruleTypes.${type}`, { defaultValue: type }),
    [t]
  )

  // 命中区空态：网关当前为关（含 guest/admin/legacy 未启用态）→ 提示期间未脱敏；开但无记录 → 首次命中
  const hitsEmptyText =
    !enabled || controlsDisabled
      ? t('settings.gateway.hitsWhileOff')
      : t('settings.gateway.hitsEmpty')

  const todayDisplay = legacy ? '—' : String(stats?.today ?? 0)
  const totalDisplay = legacy ? '—' : String(stats?.total ?? 0)
  const lastDisplay = legacy || !stats?.lastHitAt ? '—' : formatUtcToLocal(stats.lastHitAt)

  const handleMasterToggle = useCallback(async () => {
    if (controlsDisabled || savingMaster || !pref) return
    const next = !pref.enabled
    setSavingMaster(true)
    setPref({ ...pref, enabled: next }) // 乐观翻转
    try {
      const saved = await securityGatewayApi.setPreference(next)
      setPref(saved)
      toast(
        next
          ? t('settings.gateway.enabledToast', { defaultValue: '数据安全网关已开启' })
          : t('settings.gateway.disabledToast', { defaultValue: '数据安全网关已关闭' })
      )
    } catch {
      setPref((prev) => (prev ? { ...prev, enabled: !next } : prev)) // 失败回滚
      toast.error(t('settings.gateway.saveFailedToast', { defaultValue: '设置失败，请重试' }))
    } finally {
      setSavingMaster(false)
    }
  }, [controlsDisabled, savingMaster, pref, t])

  const handleRuleToggle = useCallback(
    async (rule: SecurityGatewayRule) => {
      if (controlsDisabled || !enabled || savingRuleType !== null) return
      const next = !rule.enabled
      setSavingRuleType(rule.type)
      setRules((prev) => prev.map((r) => (r.type === rule.type ? { ...r, enabled: next } : r))) // 乐观翻转
      try {
        const saved = await securityGatewayApi.setRule(rule.type, next)
        setRules(saved.rules ?? [])
      } catch {
        setRules((prev) => prev.map((r) => (r.type === rule.type ? { ...r, enabled: !next } : r))) // 失败回滚
        toast.error(t('settings.gateway.saveFailedToast', { defaultValue: '设置失败，请重试' }))
      } finally {
        setSavingRuleType(null)
      }
    },
    [controlsDisabled, enabled, savingRuleType, t]
  )

  if (!isOpen) return null

  // 规则行开关：guest/admin/legacy 或总开关关闭时禁用（总开关关=整网关不工作，单类开关无意义）
  const ruleSwitchLocked = controlsDisabled || !enabled

  return (
    <div className={cn('wf-gw-overlay', legacy && 'locked')}>
      <div className="wf-gw-head">
        <div className="wf-gw-head-in">
          <button className="wf-set-back wf-press" onClick={close}>
            <ChevronRight size={16} style={{ transform: 'rotate(180deg)' }} />
            {t('settings.overlay.back')}
          </button>
          <span className="wf-set-title">{t('settings.gateway.title')}</span>
          <div className="wf-gw-master">
            <span className={cn('wf-gw-master-txt', enabled && 'on')}>
              {enabled ? t('settings.gateway.masterOn') : t('settings.gateway.masterOff')}
            </span>
            <button
              role="switch"
              aria-checked={enabled}
              aria-label={t('settings.gateway.title')}
              disabled={controlsDisabled || savingMaster}
              onClick={handleMasterToggle}
              className={cn('wf-switch', enabled && 'on')}
            >
              <span className="knob" />
            </button>
          </div>
        </div>
      </div>

      <div className="wf-gw-page">
        {bannerText && (
          <div className="wf-gw-banner">
            <Info size={14} />
            <span>{bannerText}</span>
          </div>
        )}

        <section className="wf-gw-card">
          {loading ? (
            <div className="wf-gw-stats">
              {[0, 1, 2].map((i) => (
                <div className="wf-gw-stat" key={i}>
                  <div className="wf-gw-sk" style={{ width: 64, height: 30 }} />
                  <div className="wf-gw-sk" style={{ width: 52, height: 12, marginTop: 8 }} />
                </div>
              ))}
            </div>
          ) : (
            <div className="wf-gw-stats">
              <div className="wf-gw-stat">
                <div className="wf-gw-stat-v">
                  {todayDisplay}
                  {!legacy && <small>{t('settings.gateway.itemUnit')}</small>}
                </div>
                <div className="wf-gw-stat-l">{t('settings.gateway.todayHits')}</div>
              </div>
              <div className="wf-gw-stat">
                <div className="wf-gw-stat-v">
                  {totalDisplay}
                  {!legacy && <small>{t('settings.gateway.itemUnit')}</small>}
                </div>
                <div className="wf-gw-stat-l">{t('settings.gateway.totalHits')}</div>
              </div>
              <div className="wf-gw-stat">
                <div className="wf-gw-stat-v time">{lastDisplay}</div>
                <div className="wf-gw-stat-l">{t('settings.gateway.lastHit')}</div>
              </div>
            </div>
          )}
        </section>

        <section className="wf-gw-card">
          <div className="wf-gw-card-h">
            <span className="wf-gw-card-t">{t('settings.gateway.rulesTitle')}</span>
            <span className="wf-gw-card-note">{t('settings.gateway.rulesNote')}</span>
          </div>
          {loading ? (
            <div className="wf-gw-rules">
              {Array.from({ length: 6 }).map((_, i) => (
                <div className="wf-gw-rule" key={i}>
                  <div className="wf-gw-sk" style={{ width: 22, height: 22, borderRadius: 6 }} />
                  <div className="wf-gw-sk" style={{ flex: 1, height: 14 }} />
                  <div className="wf-gw-sk" style={{ width: 36, height: 20, borderRadius: 999 }} />
                </div>
              ))}
            </div>
          ) : (
            <div className="wf-gw-rules">
              {displayRules.map((rule) => {
                const Icon = RULE_ICONS[rule.type] ?? ShieldCheck
                return (
                  <div key={rule.type} className={cn('wf-gw-rule', !rule.enabled && 'off')}>
                    <span className="wf-gw-rule-ic">
                      <Icon size={15} />
                    </span>
                    <div className="wf-gw-rule-id">
                      <div className="wf-gw-rule-nm">{ruleTypeLabel(rule.type)}</div>
                      <div className={cn('wf-gw-rule-st', !rule.enabled && 'off')}>
                        {rule.enabled
                          ? t('settings.gateway.ruleEnabled')
                          : t('settings.gateway.ruleDisabled')}
                      </div>
                    </div>
                    <button
                      role="switch"
                      aria-checked={rule.enabled}
                      aria-label={`${ruleTypeLabel(rule.type)} · ${t('settings.gateway.rulesTitle')}`}
                      disabled={ruleSwitchLocked || savingRuleType !== null}
                      onClick={() => void handleRuleToggle(rule)}
                      className={cn('wf-switch', rule.enabled && 'on')}
                    >
                      <span className="knob" />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <section className="wf-gw-card">
          <div className="wf-gw-card-h">
            <span className="wf-gw-card-t">{t('settings.gateway.hitsTitle')}</span>
            <span className="wf-gw-card-note">
              <Lock size={12} />
              {t('settings.gateway.hitsNote')}
            </span>
          </div>
          {loading ? (
            <div className="wf-gw-hits">
              {Array.from({ length: 4 }).map((_, i) => (
                <div className="wf-gw-hit" key={i}>
                  <div className="wf-gw-sk" style={{ width: 70, height: 13 }} />
                  <div className="wf-gw-sk" style={{ flex: 1, height: 13 }} />
                </div>
              ))}
            </div>
          ) : events.length === 0 ? (
            <div className="wf-gw-empty">{hitsEmptyText}</div>
          ) : (
            <div className="wf-gw-hits">
              {events.map((e, i) => (
                <div
                  className="wf-gw-hit"
                  key={i}
                  title={t('settings.gateway.noRawTitle')}
                >
                  <span className="wf-gw-hit-t">{formatUtcToLocal(e.time)}</span>
                  <span className="wf-gw-hit-chips">
                    {Object.entries(e.hitTypes).map(([type, count]) => (
                      <span className="wf-gw-chip" key={type}>
                        {ruleTypeLabel(type)} ×{count}
                      </span>
                    ))}
                  </span>
                  <span className="wf-gw-hit-m">{e.model || e.provider || ''}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
