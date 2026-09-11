/**
 * AIGateway.Cloud (Wongoing SaaS) DTO
 * 与 D:\Sleven\Projects\MESCLI\AIGateway\AIGateway.Cloud 后端契约对应
 */

// ==================== 认证 ====================

export interface CloudUser {
  id: number
  email?: string
  phone?: string
  displayName?: string
  tier: string
}

export interface CloudLoginRequest {
  account: string
  password: string
}

export interface CloudRegisterRequest {
  account: string
  password: string
  displayName?: string
}

export interface CloudTokenResponse {
  accessToken: string
  refreshToken: string
  expiresIn: number
  user: CloudUser
}

// ==================== 套餐 / 额度 ====================

export interface CloudPlanDto {
  id: number
  name: string
  tier: string
  monthlyTokenQuota: number
  price: number
  currency: string
  description?: string
}

export interface CloudCurrentPlanResponse {
  tier: string
  plan: CloudPlanDto | null
}

export interface CloudQuotaDto {
  tier: string
  monthlyQuota: number
  usedTokens: number
  remainingTokens: number
  isExhausted: boolean
}

// ==================== License ====================

export interface CloudLicenseDto {
  id: number
  licenseKey: string
  machineFingerprint?: string
  status: string
  activatedAt?: string
  expiresAt?: string
}

export interface CloudLicenseStatusResponse {
  license: CloudLicenseDto | null
}

export interface CloudActivateLicenseRequest {
  licenseKey: string
  machineFingerprint: string
}

// ==================== 订单 / 支付 ====================

export interface CloudOrderDto {
  id: number
  planId: number
  planName?: string
  amount: number
  currency: string
  status: string
  provider?: string
  providerTradeNo?: string
  paidAt?: string
  createdAt: string
}

export interface CloudCreateOrderRequest {
  planId: number
  provider: string
}

export interface CloudCreateOrderResponse {
  order: CloudOrderDto
  payUrl: string
}

export interface CloudPaymentNotifyRequest {
  providerTradeNo: string
  status: string
}
