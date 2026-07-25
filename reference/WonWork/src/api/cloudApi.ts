import { fetchApi } from './client'
import type {
  CloudActivateLicenseRequest,
  CloudCreateOrderRequest,
  CloudCreateOrderResponse,
  CloudCurrentPlanResponse,
  CloudLicenseStatusResponse,
  CloudLoginRequest,
  CloudOrderDto,
  CloudPlanDto,
  CloudQuotaDto,
  CloudRegisterRequest,
  CloudTokenResponse,
} from '@/types/cloud'

/**
 * Wongoing Cloud API 客户端
 * 直接调用 AIGateway.Cloud 的 api/cloud/* 端点
 */
export const cloudApi = {
  // ---------- 认证 ----------
  // 2026-07-24 死链：/api/cloud/auth/* 两端均未实现（本地 daemon 与公网服务器），
  // 调用必 404。在线登录唯一通路是 websiteAuthApi（/api/auth/website/*）。
  // 以下 auth 方法仅为 authStore 兼容历史会话保留，UI 不得再接入。

  login: (req: CloudLoginRequest): Promise<CloudTokenResponse> =>
    fetchApi<CloudTokenResponse>('/api/cloud/auth/login', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  register: (req: CloudRegisterRequest): Promise<{ message: string; userId: number }> =>
    fetchApi<{ message: string; userId: number }>('/api/cloud/auth/register', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  refresh: (refreshToken: string): Promise<CloudTokenResponse> =>
    fetchApi<CloudTokenResponse>('/api/cloud/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    }),

  // ---------- 套餐 ----------

  getPlans: (): Promise<CloudPlanDto[]> => fetchApi<CloudPlanDto[]>('/api/cloud/plan'),

  getCurrentPlan: (): Promise<CloudCurrentPlanResponse> =>
    fetchApi<CloudCurrentPlanResponse>('/api/cloud/plan/current'),

  // ---------- 额度 ----------

  getQuotaUsage: (): Promise<CloudQuotaDto> =>
    fetchApi<CloudQuotaDto>('/api/cloud/quota/usage'),

  deductQuota: (tokens: number): Promise<{ success: boolean }> =>
    fetchApi<{ success: boolean }>('/api/cloud/quota/deduct', {
      method: 'POST',
      body: JSON.stringify({ tokens }),
    }),

  // ---------- License ----------

  getLicenseStatus: (): Promise<CloudLicenseStatusResponse> =>
    fetchApi<CloudLicenseStatusResponse>('/api/cloud/license/status'),

  activateLicense: (req: CloudActivateLicenseRequest): Promise<{ message: string }> =>
    fetchApi<{ message: string }>('/api/cloud/license/activate', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  // ---------- 支付 ----------

  createOrder: (req: CloudCreateOrderRequest): Promise<CloudCreateOrderResponse> =>
    fetchApi<CloudCreateOrderResponse>('/api/cloud/payment/create-order', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  getOrders: (): Promise<CloudOrderDto[]> =>
    fetchApi<CloudOrderDto[]>('/api/cloud/payment/orders'),

  getOrder: (id: number): Promise<CloudOrderDto> =>
    fetchApi<CloudOrderDto>(`/api/cloud/payment/orders/${id}`),

  notifyPayment: (req: { providerTradeNo: string; status: string }): Promise<{ message: string }> =>
    fetchApi<{ message: string }>('/api/cloud/payment/notify', {
      method: 'POST',
      body: JSON.stringify(req),
    }),
}
