import { useMemo } from 'react'
import { useLicenseStore } from '@/stores/licenseStore'
import { useQuotaStore } from '@/stores/quotaStore'
import { useRuntimeConfigStore } from '@/stores/runtimeConfigStore'
import { supportsLicenseActivation, isPreview } from '@/config/product'

export interface LicenseGuardResult {
  /** 当前功能是否可用 */
  allowed: boolean
  /** 不可用时的人类可读原因 */
  reason?: string
  /** 是否需要显示升级入口 */
  showUpgrade?: boolean
}

/**
 * 统一功能守卫 Hook
 *
 * 根据当前 License 状态、套餐 features 与额度判断是否允许使用某项功能。
 * Preview 模式默认放行所有功能（用于开发演示）。
 */
export function useLicenseGuard(feature: string): LicenseGuardResult {
  const license = useLicenseStore((s) => s.license)
  const usage = useQuotaStore((s) => s.usage)
  const byokEnabled = useRuntimeConfigStore((s) => s.config.byokEnabled)

  return useMemo((): LicenseGuardResult => {
    // Preview 模式 / BYOK 测试构建：跳过 License 校验，默认放行
    if (isPreview || byokEnabled) {
      return { allowed: true }
    }

    // 不需要 License 激活的构建目标直接放行
    if (!supportsLicenseActivation) {
      return { allowed: true }
    }

    if (!license) {
      return {
        allowed: false,
        reason: '请先激活 License',
        showUpgrade: true,
      }
    }

    if (license.status === 'expired') {
      return {
        allowed: false,
        reason: 'License 已过期，请续期',
        showUpgrade: true,
      }
    }

    if (license.status === 'revoked') {
      return {
        allowed: false,
        reason: 'License 已被吊销',
        showUpgrade: true,
      }
    }

    if (license.status !== 'active' && license.status !== 'trial') {
      return {
        allowed: false,
        reason: 'License 未激活',
        showUpgrade: true,
      }
    }

    const features = license.features || []
    if (!features.includes(feature)) {
      return {
        allowed: false,
        reason: '当前套餐不包含此功能，请升级',
        showUpgrade: true,
      }
    }

    // 额度检查：remainingTokens 为 -1 表示无限制
    if (usage && usage.remainingTokens === 0) {
      return {
        allowed: false,
        reason: '当月 Token 额度已用完',
        showUpgrade: true,
      }
    }

    return { allowed: true }
  }, [license, usage, feature])
}

/**
 * 判断当前是否处于任何有效 License 状态
 */
export function useHasValidLicense(): boolean {
  const license = useLicenseStore((s) => s.license)
  const byokEnabled = useRuntimeConfigStore((s) => s.config.byokEnabled)
  if (isPreview || byokEnabled || !supportsLicenseActivation) return true
  return license?.status === 'active' || license?.status === 'trial'
}

/**
 * 判断当前套餐是否包含某功能（不触发额度检查）
 */
export function useLicenseFeature(feature: string): boolean {
  const license = useLicenseStore((s) => s.license)
  const byokEnabled = useRuntimeConfigStore((s) => s.config.byokEnabled)
  if (isPreview || byokEnabled || !supportsLicenseActivation) return true
  return (license?.features || []).includes(feature)
}
