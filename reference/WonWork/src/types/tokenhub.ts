/**
 * 官网 TokenHub / 云服务 DTO
 *
 * 与 E:\code\WonWork\learn\03\workshop\tencent-tokenhub-integration.md 中的接口契约对应。
 */

export interface CloudPlan {
  key: string
  name: string
  startsAt: string | null
  expiresAt: string | null
  tokenHub: CloudTokenHubInfo | null
}

/** GET /api/cloud/plans 的单条可购套餐（website Program.cs:687） */
export interface CloudPlanListItem {
  key: string
  name: string
  price: number
  currency: string
  description: string | null
  monthlyTokenQuota: number | null
  sortOrder: number
}

export interface CloudTokenHubInfo {
  model: string
  endpointId: string
  baseUrl: string
  monthlyTokenQuota: number
}

export interface TokenHubKeyMeta {
  apiKeyId: string
  keyHint: string
  model: string
  endpointId: string
  baseUrl: string
  monthlyTokenQuota: number
  status: string
  activatedAt: string | null
}

export interface RevealedTokenHubKey {
  key: string
  apiKeyId: string
}

export interface CloudQuotaUsage {
  year: number
  month: number
  usedTokens: number
  monthlyTokenQuota: number | null
}

export interface ProvisioningJob {
  id: number
  orderId: number
  planKey: string
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  attemptCount: number
  lastError: string | null
  createdAt: string
  completedAt: string | null
}

export interface CloudOkResponse {
  ok: boolean
  error?: string
}

export interface CloudPlanResponse extends CloudOkResponse {
  plan: CloudPlan | null
}

export interface CloudPlansResponse extends CloudOkResponse {
  plans: CloudPlanListItem[]
}

export interface CloudTokenHubKeyResponse extends CloudOkResponse {
  key: TokenHubKeyMeta | null
}

export interface CloudRevealKeyResponse extends CloudOkResponse {
  key: string
  apiKeyId: string
}

export interface CloudQuotaUsageResponse extends CloudOkResponse {
  year: number
  month: number
  usedTokens: number
  monthlyTokenQuota: number | null
}

export interface CloudJobsResponse extends CloudOkResponse {
  jobs: ProvisioningJob[]
}

export interface CloudRetryResponse extends CloudOkResponse {
  retried: number
}
