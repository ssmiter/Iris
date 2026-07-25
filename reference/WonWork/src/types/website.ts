/**
 * 官网认证与云服务 DTO
 *
 * 对应 website/Areas/Cloud/Controllers/... 后端接口契约。
 */

// ==================== 用户 ====================

export interface WebsiteUser {
  id: string
  displayName: string
  email?: string
  phone?: string
  avatarUrl?: string
  tenantId?: string
  tenantName?: string
  createdAt: string
}

// ==================== Token ====================

export interface WebsiteTokenResponse {
  accessToken: string
  refreshToken?: string
  expiresIn: number
}

// ==================== 认证请求 ====================

export interface WebsiteLoginRequest {
  email: string
  password: string
  rememberMe?: boolean
}

export interface WebsiteRegisterRequest {
  email: string
  password: string
  displayName: string
  inviteCode?: string
}

export interface WebsiteResetPasswordRequest {
  email: string
  token: string
  newPassword: string
}

// ==================== 认证响应 ====================

export interface WebsiteAuthResponse {
  success: boolean
  error?: string
  token?: WebsiteTokenResponse
  user?: WebsiteUser
}

export interface WebsiteUserResponse {
  success: boolean
  error?: string
  user?: WebsiteUser
}
