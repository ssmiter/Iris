/**
 * Website 账号系统 DTO（与 WonWork 官网后端 /api/auth/* 契约对应）
 */

export interface WebsiteUser {
  account: string
  channel: 'email' | 'phone'
  plan: string
  createdAt?: string
}

export interface WebsiteTokenResponse {
  ok: boolean
  token?: string
  user?: WebsiteUser
  error?: string
}

export interface WebsiteMeResponse {
  ok: boolean
  user?: WebsiteUser
  error?: string
}

export interface WebsiteSendCodeRequest {
  channel: 'email' | 'phone'
  target: string
  purpose?: 'register' | 'reset'
}

export interface WebsiteRegisterRequest {
  channel: 'email' | 'phone'
  target: string
  code: string
  password: string
  plan?: string
}

export interface WebsiteLoginRequest {
  account: string
  password: string
}

export interface WebsiteResetPasswordRequest {
  channel: 'email' | 'phone'
  target: string
  code: string
  password: string
}

export interface WebsiteChangePasswordRequest {
  oldPassword: string
  newPassword: string
}

export interface WebsiteAccountInfo {
  email?: string
  phone?: string
  plan?: string
  channel?: string
}
