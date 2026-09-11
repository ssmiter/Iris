import { useState, useEffect, useCallback } from 'react'
import { cn } from '@/utils'
import { securityGatewayApi } from '@/api/client'
import { Lock, Loader2, ChevronDown, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { useSecurityGatewayViewStore } from '@/stores/securityGatewayViewStore'

/**
 * 数据安全网关设置行（2026-08-11 设置页重设计）。
 *
 * 数据逻辑逐行保留：canEnable/reason 完全由后端返回决定，enabled 不落 localStorage，
 * 开关乐观翻转 + 失败回滚 + toast；UI 改为行形态 + 就地展开。
 */
export function SecurityGatewaySettingsView() {
  const { t } = useTranslation()
  const [loaded, setLoaded] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [canEnable, setCanEnable] = useState(false)
  const [reason, setReason] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    securityGatewayApi
      .getPreference()
      .then((p) => {
        if (cancelled) return
        setEnabled(p.enabled)
        setCanEnable(p.canEnable)
        setReason(p.reason ?? null)
        setLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setLoadFailed(true)
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleToggle = useCallback(async () => {
    if (!canEnable || saving) return
    const next = !enabled
    setSaving(true)
    setEnabled(next)
    try {
      const saved = await securityGatewayApi.setPreference(next)
      setEnabled(saved.enabled)
      toast(
        next
          ? t('settings.gateway.enabledToast', { defaultValue: '数据安全网关已开启' })
          : t('settings.gateway.disabledToast', { defaultValue: '数据安全网关已关闭' })
      )
    } catch {
      setEnabled(!next)
      toast.error(
        t('settings.gateway.saveFailedToast', { defaultValue: '设置失败，请重试' })
      )
    } finally {
      setSaving(false)
    }
  }, [canEnable, saving, enabled, t])

  if (!loaded) {
    return (
      <div className="wf-set-row">
        <span className="wf-set-row-ic">
          <span
            className="wf-skel-fade"
            style={{
              width: 16,
              height: 16,
              borderRadius: '50%',
              background: 'var(--wf-hair)',
              display: 'inline-block',
            }}
          />
        </span>
        <div className="flex-1">
          <span
            className="wf-skel-fade"
            style={{
              width: 120,
              height: 14,
              borderRadius: 4,
              background: 'var(--wf-hair)',
              display: 'block',
              marginBottom: 6,
            }}
          />
          <span
            className="wf-skel-fade"
            style={{
              width: 180,
              height: 12,
              borderRadius: 4,
              background: 'var(--wf-hair)',
              display: 'block',
            }}
          />
        </div>
      </div>
    )
  }

  const disabled = !canEnable || loadFailed
  const statusSub = loadFailed
    ? t('settings.overlay.gatewayUnavailable')
    : !canEnable
      ? reason === 'gateway_disabled'
        ? t('settings.overlay.gatewayAdminOff')
        : t('settings.overlay.gatewayLoginRequired')
      : enabled
        ? t('settings.overlay.gatewayOnSub')
        : t('settings.overlay.gatewayOffSub')

  return (
    <>
      <div className="wf-set-row wf-press" onClick={() => setOpen((o) => !o)}>
        <span className="wf-set-row-ic">
          <Lock size={16} />
        </span>
        <div>
          <div className="wf-set-row-nm">
            {t('settings.gateway.title')}
          </div>
          <div className="wf-set-row-sub">{statusSub}</div>
        </div>
        <span className="wf-set-row-r">
          <span className={cn('wf-set-dot', !enabled && 'off')} />
          <span>{enabled ? t('settings.overlay.gatewayOn') : t('settings.overlay.gatewayOff')}</span>
          <ChevronDown size={16} className={cn('wf-set-chev', open && 'open')} />
        </span>
      </div>

      <div className={cn('wf-collapse', !open && 'wf-collapsed')}>
        <div className="wf-collapse-inner">
          <div className="wf-set-expand-pad">
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <button
                className="wf-gw-view-link"
                onClick={(e) => {
                  e.stopPropagation()
                  useSecurityGatewayViewStore.getState().open()
                }}
              >
                {t('settings.gateway.viewDetail', { defaultValue: '查看详情' })}
                <ChevronRight size={14} />
              </button>
              <button
                role="switch"
                aria-checked={enabled}
                disabled={disabled || saving}
                onClick={(e) => {
                  e.stopPropagation()
                  void handleToggle()
                }}
                className={cn('wf-switch', enabled && 'on')}
              >
                <span className="knob" />
              </button>
              {saving && (
                <Loader2
                  size={14}
                  className="animate-spin"
                  style={{ color: 'var(--wf-mut)', flexShrink: 0 }}
                />
              )}
            </div>
            {statusSub && (
              <p style={{ fontSize: 12, color: 'var(--wf-mut)', marginTop: 10, marginBottom: 0 }}>
                {statusSub}
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
