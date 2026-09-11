import { fetchApi } from './client'


/**
 * MCP 插件市场 + 已安装 MCP server 管理 API（2026-08-06 市场 P1）。
 * 后端：/api/mcp/market/*（官方 Registry 代理 + 安装翻译）、/api/mcp/servers/*（运行状态管理）。
 * 写操作（install/delete/reconnect）需要管理员提权（client.ts 自动附带 X-Admin-Token）。
 */

// ==================== 类型 ====================

export interface McpMarketCard {
  /** registry 全名，如 com.pulsemcp/remote-filesystem */
  name: string
  title?: string
  description?: string
  version?: string
  /** http=远程服务 / stdio=本机运行 */
  runModes: string[]
  runtimeHints: string[]
  requiredEnvCount: number
  repositoryUrl?: string
  /** 信任标记（口子）：P1 一律 unverified */
  trust: string
}

export interface McpMarketSearchResult {
  items: McpMarketCard[]
  nextCursor: string | null
}

export interface McpEnvVarDecl {
  name: string
  description?: string
  isRequired?: boolean
  isSecret?: boolean
  default?: string
  placeholder?: string
}

export interface McpPackageInfo {
  registryType: string
  identifier?: string
  version?: string
  runtimeHint?: string
  runtimeArguments?: { value?: string }[]
  packageArguments?: { value?: string }[]
  environmentVariables?: McpEnvVarDecl[]
}

export interface McpRemoteInfo {
  type: string
  url: string
  headers?: McpEnvVarDecl[]
}

export interface McpMarketDetail {
  name: string
  title?: string
  description?: string
  version?: string
  repository?: { url?: string; source?: string }
  packages?: McpPackageInfo[]
  remotes?: McpRemoteInfo[]
}

export interface McpInstallRequest {
  name: string
  serverName?: string
  domain?: string
  prefer?: 'auto' | 'http' | 'stdio'
  env?: Record<string, string>
  headers?: Record<string, string>
}

export interface McpInstallResult {
  message: string
  serverName: string
}

export interface McpServerStatus {
  name: string
  type: string
  domain: string
  state: 'Connecting' | 'Connected' | 'Failed' | 'Disconnected'
  error?: string | null
  toolCount: number
  tools: string[]
  /** 已配置的凭据键名（值永不回传，密钥只进不出） */
  envKeys: string[]
  headerKeys: string[]
  /** 安装时持久化的 registry 凭据声明（补配面板数据源；手工配置的 server 无此字段） */
  decl?: McpCredentialDecl | null
  /** server 级审批覆盖（null/undefined=缺省 fail-closed 全审批；false=免审批；true=显式审批） */
  requiresApprovalOverride?: boolean | null
  /** 启用态（2026-08-07 v12 行开关=启用/停用）：false=已停用（Disconnected 补投影，工具下线） */
  enabled: boolean
  appCount: number
  apps: McpAppDescriptor[]
}

export interface McpAppDescriptor {
  uri: string
  name: string
  title: string
  description?: string | null
  mimeType: string
}

/** settings PATCH 增量（两字段至少给一；null=恢复缺省：审批缺省=fail-closed，enabled 缺省=启用） */
export interface McpSettingsPatch {
  requiresApproval?: boolean | null
  enabled?: boolean | null
}

/** _decl 元数据：安装时的 registry 声明投影（只含声明，不含任何值） */
export interface McpCredentialDecl {
  source?: string
  registryName?: string
  env: McpEnvVarDecl[]
  headers: McpEnvVarDecl[]
}

/** stdio 形态运行时探测结果（/api/mcp/market/runtimes） */
export interface McpRuntimeInfo {
  command: string
  available: boolean
  installHint: string
}

/** 凭据增量补配请求：值非空=设置，空字符串=删除该键；未提交的节不动 */
export interface McpCredentialsPatch {
  env?: Record<string, string>
  headers?: Record<string, string>
}

export interface McpPackageConfigField {
  key: string
  type: string
  title: string
  description?: string
  required: boolean
  sensitive: boolean
  defaultValue?: string | null
}

export interface McpPackagePreview {
  token: string
  name: string
  displayName: string
  version: string
  description?: string
  author: string
  runtime: string
  runtimeRequirement?: string | null
  supported: boolean
  packageBytes: number
  expandedBytes: number
  fileCount: number
  sha256: string
  userConfig: McpPackageConfigField[]
  warnings: string[]
  expiresAtUtc: string
}

export interface McpPackageInstallRequest {
  token: string
  serverName: string
  userConfig: Record<string, string>
  replaceExisting: boolean
}

export interface McpPackageInstallResult {
  serverName: string
  version: string
  connected: boolean
  installPath: string
  toolCount: number
  appCount: number
  sha256: string
  alreadyInstalled: boolean
}

// ==================== MESCLI 实现 ====================
// API 层统一 silent：错误只走 store/组件内联呈现，避免全局 toast 与内联提示双弹。

const mescliMcpMarketApi = {
  search: (query?: string, cursor?: string): Promise<McpMarketSearchResult> => {
    const params = new URLSearchParams()
    if (query?.trim()) params.set('query', query.trim())
    if (cursor) params.set('cursor', cursor)
    const qs = params.toString()
    return fetchApi<McpMarketSearchResult>(`/api/mcp/market/search${qs ? `?${qs}` : ''}`, { silent: true })
  },

  detail: (name: string): Promise<McpMarketDetail> =>
    fetchApi<McpMarketDetail>(`/api/mcp/market/detail?name=${encodeURIComponent(name)}`, { silent: true }),

  runtimes: (): Promise<{ runtimes: McpRuntimeInfo[] }> =>
    fetchApi<{ runtimes: McpRuntimeInfo[] }>('/api/mcp/market/runtimes', { silent: true }),

  install: (body: McpInstallRequest): Promise<McpInstallResult> =>
    fetchApi<McpInstallResult>('/api/mcp/market/install', {
      method: 'POST',
      body: JSON.stringify(body),
      silent: true,
    }),

  getServerStatuses: (): Promise<{ servers: McpServerStatus[] }> =>
    fetchApi<{ servers: McpServerStatus[] }>('/api/mcp/servers', { silent: true }),

  updateCredentials: (name: string, body: McpCredentialsPatch): Promise<{ message: string }> =>
    fetchApi<{ message: string }>(`/api/mcp/servers/${encodeURIComponent(name)}/credentials`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      silent: true,
    }),

  /** server 级设置：requiresApproval=false 免审批 / null 恢复缺省（写操作，需提权） */
  updateSettings: (name: string, patch: McpSettingsPatch): Promise<{ message: string }> =>
    fetchApi<{ message: string }>(`/api/mcp/servers/${encodeURIComponent(name)}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
      silent: true,
    }),

  deleteServer: (name: string): Promise<{ message: string }> =>
    fetchApi<{ message: string }>(`/api/mcp/servers/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      silent: true,
    }),

  reconnectServer: (name: string): Promise<{ message: string }> =>
    fetchApi<{ message: string }>(`/api/mcp/servers/${encodeURIComponent(name)}/reconnect`, {
      method: 'POST',
      silent: true,
    }),

  previewPackage: (file: File): Promise<McpPackagePreview> => {
    const body = new FormData()
    body.append('package', file)
    return fetchApi<McpPackagePreview>('/api/mcp/packages/preview', { method: 'POST', body, silent: true })
  },

  installPackage: (body: McpPackageInstallRequest): Promise<McpPackageInstallResult> =>
    fetchApi<McpPackageInstallResult>('/api/mcp/packages/install', {
      method: 'POST',
      body: JSON.stringify(body),
      silent: true,
    }),

  packageStandardUrl: '/api/mcp/packages/standard',
}

export const mcpMarketApi = mescliMcpMarketApi
