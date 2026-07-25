import { isMescli, isPreview } from '@/config/product'
import { fetchApi } from './client'
import { cloudApi } from './cloudApi'
import { isWebsiteOnline } from '@/utils/runtimeMode'
import { useAuthStore } from '@/stores/authStore'
import type {
  LicenseInfo,
  LicenseActivationRequest,
  LicenseActivationResponse,
  MachineFingerprint,
} from '@/types/mescli'
import { DEFAULT_FEATURES_BY_TIER } from '@/config/product'

const LICENSE_STORAGE_KEY = 'wonwork_license_info'
const FINGERPRINT_STORAGE_KEY = 'wonwork_machine_fingerprint'
const PREVIEW_LICENSE_PREFIX = 'WW-PREVIEW-'

function generateHardwareId(): string {
  const existing = localStorage.getItem(FINGERPRINT_STORAGE_KEY)
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as MachineFingerprint
      if (parsed.hardwareId) return parsed.hardwareId
    } catch {
      // ignore
    }
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function buildFingerprint(): MachineFingerprint {
  const hardwareId = generateHardwareId()
  const fingerprint: MachineFingerprint = {
    hardwareId,
    hostname: window.location.hostname,
    os: navigator.platform,
    createdAt: new Date().toISOString(),
  }
  localStorage.setItem(FINGERPRINT_STORAGE_KEY, JSON.stringify(fingerprint))
  return fingerprint
}

export function readFingerprint(): MachineFingerprint {
  const raw = localStorage.getItem(FINGERPRINT_STORAGE_KEY)
  if (raw) {
    try {
      return JSON.parse(raw) as MachineFingerprint
    } catch {
      // ignore
    }
  }
  return buildFingerprint()
}

function saveLicense(license: LicenseInfo): void {
  localStorage.setItem(LICENSE_STORAGE_KEY, JSON.stringify(license))
}

function readLicense(): LicenseInfo | null {
  const raw = localStorage.getItem(LICENSE_STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as LicenseInfo
  } catch {
    return null
  }
}

function licenseStatusFromCloud(status: string): LicenseInfo['status'] {
  switch (status) {
    case 'active':
      return 'active'
    case 'expired':
      return 'expired'
    case 'revoked':
      return 'revoked'
    case 'trial':
      return 'trial'
    default:
      return 'inactive'
  }
}

// ==================== MESCLI 实现 ====================

const mescliLicenseApi = {
  getLicense: async (): Promise<LicenseInfo | null> => {
    try {
      return await fetchApi<LicenseInfo>('/api/license/current')
    } catch {
      return null
    }
  },

  activate: async (req: LicenseActivationRequest): Promise<LicenseActivationResponse> => {
    return fetchApi<LicenseActivationResponse>('/api/license/activate', {
      method: 'POST',
      body: JSON.stringify(req),
    })
  },

  deactivate: async (): Promise<{ success: boolean }> => {
    return fetchApi<{ success: boolean }>('/api/license/deactivate', {
      method: 'POST',
    })
  },
}

// ==================== Preview 实现（本地演示） ====================

const previewLicenseApi = {
  getLicense: async (): Promise<LicenseInfo | null> => {
    const license = readLicense()
    if (!license) return null

    const now = new Date().toISOString()
    if (license.expiresAt && license.expiresAt < now) {
      license.status = 'expired'
      saveLicense(license)
    }
    return license
  },

  activate: async (req: LicenseActivationRequest): Promise<LicenseActivationResponse> => {
    await new Promise((resolve) => setTimeout(resolve, 400))

    const key = req.licenseKey.trim()
    if (!key.startsWith(PREVIEW_LICENSE_PREFIX)) {
      return {
        success: false,
        error: `无效的 Preview License，应以 ${PREVIEW_LICENSE_PREFIX} 开头`,
      }
    }

    const now = new Date()
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()

    const license: LicenseInfo = {
      licenseKey: key,
      productName: 'WonWork Preview',
      status: 'active',
      issuedAt: now.toISOString(),
      expiresAt,
      maxMachines: 1,
      activatedMachines: 1,
      features: ['byok', 'local_model', 'offline_mode'],
    }

    saveLicense(license)
    buildFingerprint()

    return { success: true, license }
  },

  deactivate: async (): Promise<{ success: boolean }> => {
    localStorage.removeItem(LICENSE_STORAGE_KEY)
    return { success: true }
  },
}

// ==================== Online 实现（Wongoing Cloud） ====================

async function fetchCurrentTier(): Promise<'free' | 'pro' | 'enterprise'> {
  try {
    const current = await cloudApi.getCurrentPlan()
    const tier = current.tier.toLowerCase()
    if (tier === 'pro' || tier === 'enterprise') return tier
  } catch {
    // ignore
  }
  return 'free'
}

async function mapCloudLicense(
  cloud: Awaited<ReturnType<typeof cloudApi.getLicenseStatus>>['license']
): Promise<LicenseInfo | null> {
  if (!cloud) return null

  const tier = await fetchCurrentTier()
  const features = DEFAULT_FEATURES_BY_TIER[tier] ?? DEFAULT_FEATURES_BY_TIER.free

  return {
    licenseKey: cloud.licenseKey,
    productName: 'WonWork Online',
    status: licenseStatusFromCloud(cloud.status),
    issuedAt: cloud.activatedAt ?? new Date().toISOString(),
    expiresAt: cloud.expiresAt,
    maxMachines: 1,
    activatedMachines: cloud.machineFingerprint ? 1 : 0,
    tier,
    features,
  }
}

const onlineLicenseApi = {
  getLicense: async (): Promise<LicenseInfo | null> => {
    // 旧 Wongoing Cloud License 仅对 cloud 会话有意义：
    // - website-online（官网账号）→ 走套餐/TokenHub，无 License 概念
    // - mescli-online（官网版里再登 MES）→ 功能门控走 permissions，也无 License 概念
    // 两者若放行下去会请求 /api/cloud/license/status（后端无此代理路由）→ 404 噪声
    if (isWebsiteOnline() || !useAuthStore.getState().isCloudLoggedIn) return null
    try {
      const status = await cloudApi.getLicenseStatus()
      return await mapCloudLicense(status.license)
    } catch {
      return null
    }
  },

  activate: async (req: LicenseActivationRequest): Promise<LicenseActivationResponse> => {
    await cloudApi.activateLicense({
      licenseKey: req.licenseKey,
      machineFingerprint: JSON.stringify(req.fingerprint),
    })
    const license = await onlineLicenseApi.getLicense()
    if (license) {
      saveLicense(license)
      return { success: true, license }
    }
    return { success: false, error: '激活后未能获取 License 信息' }
  },

  deactivate: async (): Promise<{ success: boolean }> => {
    localStorage.removeItem(LICENSE_STORAGE_KEY)
    return { success: true }
  },
}

export const licenseApi = isMescli
  ? mescliLicenseApi
  : isPreview
    ? previewLicenseApi
    : onlineLicenseApi

export { buildFingerprint }
