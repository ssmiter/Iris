import { cn } from '@/utils'
import { useTranslation } from 'react-i18next'
import { useLicenseGuard } from '@/hooks/useLicenseGuard'
import { Lock, Sparkles } from 'lucide-react'

interface LicenseFeatureGateProps {
  feature: string
  children: React.ReactNode
  /** 为 true 时未授权不渲染任何内容 */
  hiddenWhenDisabled?: boolean
  /** 自定义未授权提示 */
  fallback?: React.ReactNode
  /** 点击升级按钮回调 */
  onUpgrade?: () => void
  className?: string
}

/**
 * 功能守卫包装组件
 *
 * 根据 License 与配额状态决定是否渲染子内容；未授权时显示升级提示或 fallback。
 */
export function LicenseFeatureGate({
  feature,
  children,
  hiddenWhenDisabled = false,
  fallback,
  onUpgrade,
  className,
}: LicenseFeatureGateProps) {
  const { t } = useTranslation()
  const { allowed, reason, showUpgrade } = useLicenseGuard(feature)

  if (allowed) {
    return <>{children}</>
  }

  if (hiddenWhenDisabled) {
    return null
  }

  if (fallback) {
    return <>{fallback}</>
  }

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--wf-mono-bg)] text-[var(--wf-mut)] text-xs',
        className
      )}
    >
      <Lock size={14} />
      <span className="flex-1 truncate">{reason || t('license.gate.unsupported')}</span>
      {showUpgrade && onUpgrade && (
        <button
          onClick={onUpgrade}
          className="flex items-center gap-1 text-primary-600 hover:text-primary-700 font-medium"
        >
          <Sparkles size={12} />
          {t('license.gate.upgrade')}
        </button>
      )}
    </div>
  )
}
