/**
 * 云服务 DTO
 *
 * 与 E:\code\WonWork\learn\03\workshop\cloud-apis.md 中的接口契约对应。
 */

// ==================== 用户认证 ====================

export interface CloudUser {
  id: string
  displayName: string
  email?: string
  phone?: string
  avatarUrl?: string
  avatarUrl_base64?: string
  tenantId?: string
  tenantName?: string
  createdAt: string
  role?: string
}

// ==================== 套餐 ====================

export interface CloudPlanDto {
  key: string
  name: string
  description?: string
  price: number
  currency: string
  /** 月度 token 配额 */
  monthlyTokenQuota?: number
  /** 并发对话数上限 */
  maxConcurrentConversations?: number
  /** 最大附件大小（MB） */
  maxAttachmentSizeMb?: number
  /** 最大历史天数 */
  maxHistoryDays?: number
  /** 包含的功能列表 */
  features?: string[]
  /** 排序 */
  sortOrder?: number
  /** 是否为推荐套餐 */
  isRecommended?: boolean
}

// ==================== 订单与支付 ====================

export type OrderStatus = 'pending_payment' | 'pending_confirm' | 'completed' | 'cancelled' | 'refunded'

export interface CloudOrderDto {
  id: string
  planKey: string
  planName: string
  amount: number
  currency: string
  status: OrderStatus
  createdAt: string
  paidAt?: string
  confirmedAt?: string
  /** 转账汇款凭证图片 URL */
  proofImageUrl?: string
  /** 失败原因 */
  failReason?: string
}

export interface PaymentQrCode {
  type: 'alipay' | 'wechat'
  amount: number
  currency: string
  qrImageUrl: string
  qrImageUrl_base64?: string
  expiresAt?: string
}

// ==================== 许可证 ====================

export type LicenseStatus = 'active' | 'inactive' | 'expired' | 'revoked' | 'trial'

export type LicenseTier = 'free' | 'pro' | 'enterprise'

export interface MachineFingerprint {
  hardwareId: string
  hostname?: string
  os?: string
  createdAt: string
}

export interface License {
  licenseKey: string
  productName: string
  status: LicenseStatus
  tier: LicenseTier
  issuedAt: string
  expiresAt?: string
  maxMachines?: number
  activatedMachines?: number
  tenantId?: string
  planId?: string
  seats?: number
  features?: string[]
  metadata?: Record<string, unknown>
}

// ==================== API 响应 ====================

export interface CloudOkResponse {
  ok: boolean
  error?: string
}

export interface CloudUserResponse extends CloudOkResponse {
  user: CloudUser | null
}

export interface CloudPlansResponse extends CloudOkResponse {
  plans: CloudPlanDto[]
}

export interface CloudOrdersResponse extends CloudOkResponse {
  orders: CloudOrderDto[]
}

export interface CloudOrderResponse extends CloudOkResponse {
  order: CloudOrderDto | null
}

export interface CloudPaymentQrResponse extends CloudOkResponse {
  qr: PaymentQrCode | null
}

export interface CloudLicenseResponse extends CloudOkResponse {
  license: License | null
}

export interface CloudActivateResponse extends CloudOkResponse {
  license?: License
}
