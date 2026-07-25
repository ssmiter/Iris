import { fetchApi } from './client'
import type {
  CloudPlanResponse,
  CloudPlansResponse,
  CloudTokenHubKeyResponse,
  CloudRevealKeyResponse,
  CloudQuotaUsageResponse,
  CloudJobsResponse,
  CloudRetryResponse,
} from '@/types/tokenhub'

function getWebsiteAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('wonclaw_website_token')
  const headers: Record<string, string> = {}
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

/**
 * 官网云服务 API 客户端
 *
 * 所有请求走 AIGateway 本地代理（/api/cloud/*），对用户隐藏公网 website 地址。
 * 使用独立的 wonclaw_website_token。
 */
export const websiteCloudApi = {
  /** GET /api/cloud/plan/current */
  getCurrentPlan: (): Promise<CloudPlanResponse> =>
    fetchApi<CloudPlanResponse>('/api/cloud/plan/current', {
      headers: getWebsiteAuthHeaders(),
    }),

  /** GET /api/cloud/plans（website r125 新增，可购套餐列表） */
  getPlans: (): Promise<CloudPlansResponse> =>
    fetchApi<CloudPlansResponse>('/api/cloud/plans', {
      headers: getWebsiteAuthHeaders(),
    }),

  /** GET /api/cloud/tokenhub/key */
  getTokenHubKeyMeta: (): Promise<CloudTokenHubKeyResponse> =>
    fetchApi<CloudTokenHubKeyResponse>('/api/cloud/tokenhub/key', {
      headers: getWebsiteAuthHeaders(),
    }),

  /** POST /api/cloud/tokenhub/key/reveal */
  revealTokenHubKey: (): Promise<CloudRevealKeyResponse> =>
    fetchApi<CloudRevealKeyResponse>('/api/cloud/tokenhub/key/reveal', {
      method: 'POST',
      headers: getWebsiteAuthHeaders(),
    }),

  /** GET /api/cloud/quota/usage */
  getQuotaUsage: (): Promise<CloudQuotaUsageResponse> =>
    fetchApi<CloudQuotaUsageResponse>('/api/cloud/quota/usage', {
      headers: getWebsiteAuthHeaders(),
    }),

  /** GET /api/cloud/tokenhub/jobs */
  getProvisioningJobs: (): Promise<CloudJobsResponse> =>
    fetchApi<CloudJobsResponse>('/api/cloud/tokenhub/jobs', {
      headers: getWebsiteAuthHeaders(),
    }),

  /** POST /api/cloud/tokenhub/retry */
  retryProvisioning: (): Promise<CloudRetryResponse> =>
    fetchApi<CloudRetryResponse>('/api/cloud/tokenhub/retry', {
      method: 'POST',
      headers: getWebsiteAuthHeaders(),
    }),
}
