import { fetchApi } from './client'
import type {
  WebsiteSendCodeRequest,
  WebsiteRegisterRequest,
  WebsiteLoginRequest,
  WebsiteResetPasswordRequest,
  WebsiteChangePasswordRequest,
  WebsiteTokenResponse,
  WebsiteMeResponse,
} from '@/types/website'

function getWebsiteAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('wonclaw_website_token')
  const headers: Record<string, string> = {}
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

/**
 * Website 账号 API 客户端
 * 所有请求走 AIGateway 本地代理，对用户隐藏公网 website 地址
 * 使用独立的 wonclaw_website_token，避免与 MES JWT 互相覆盖
 */
export const websiteAuthApi = {
  sendCode: (req: WebsiteSendCodeRequest): Promise<{ ok: boolean; delivered?: boolean; devCode?: string; error?: string }> =>
    fetchApi('/api/auth/website/send-code', {
      method: 'POST',
      body: JSON.stringify(req),
      headers: getWebsiteAuthHeaders(),
    }),

  register: (req: WebsiteRegisterRequest): Promise<WebsiteTokenResponse> =>
    fetchApi<WebsiteTokenResponse>('/api/auth/website/register', {
      method: 'POST',
      body: JSON.stringify(req),
      headers: getWebsiteAuthHeaders(),
    }),

  login: (req: WebsiteLoginRequest): Promise<WebsiteTokenResponse> =>
    fetchApi<WebsiteTokenResponse>('/api/auth/website/login', {
      method: 'POST',
      body: JSON.stringify(req),
      headers: getWebsiteAuthHeaders(),
    }),

  me: (): Promise<WebsiteMeResponse> =>
    fetchApi<WebsiteMeResponse>('/api/auth/website/me', {
      headers: getWebsiteAuthHeaders(),
    }),

  logout: (): Promise<{ ok: boolean }> =>
    fetchApi<{ ok: boolean }>('/api/auth/website/logout', {
      method: 'POST',
      headers: getWebsiteAuthHeaders(),
    }),

  resetPassword: (req: WebsiteResetPasswordRequest): Promise<{ ok: boolean; error?: string }> =>
    fetchApi('/api/auth/website/reset-password', {
      method: 'POST',
      body: JSON.stringify(req),
      headers: getWebsiteAuthHeaders(),
    }),

  changePassword: (req: WebsiteChangePasswordRequest): Promise<{ ok: boolean; error?: string }> =>
    fetchApi('/api/auth/website/change-password', {
      method: 'POST',
      body: JSON.stringify(req),
      headers: getWebsiteAuthHeaders(),
    }),
}
