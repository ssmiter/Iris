export interface BrowserRuntimeSession {
  runtimeUrl: string
  credential: string
  expiresAt: string
  protocolVersion: number
  webSocketUrl: string
}

interface BrowserRuntimeSessionResponse {
  runtimeUrl: string
  credential: string
  expiresAt: string
  protocolVersion: number
}

let cachedSession: BrowserRuntimeSession | null = null

export async function getBrowserRuntimeSession(forceRefresh = false): Promise<BrowserRuntimeSession> {
  if (
    !forceRefresh &&
    cachedSession &&
    Date.parse(cachedSession.expiresAt) > Date.now() + 20_000
  ) {
    return cachedSession
  }

  const response = await fetch('/api/browser/session', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      // 外网通道 /api/browser 在 PublicAuth ProtectedPaths 内，需带 website token；
      // 内网/本地无此要求，token 不存在时不附加
      ...(localStorage.getItem('wonclaw_token')
        ? { Authorization: `Bearer ${localStorage.getItem('wonclaw_token')}` }
        : {}),
    },
    credentials: 'same-origin',
  })
  if (!response.ok) {
    throw new Error(`浏览器会话不可用（HTTP ${response.status}）`)
  }

  const payload = (await response.json()) as BrowserRuntimeSessionResponse
  if (!payload.runtimeUrl || !payload.credential || payload.protocolVersion !== 2) {
    throw new Error('浏览器会话响应无效')
  }

  const wsBase = payload.runtimeUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
  cachedSession = {
    ...payload,
    webSocketUrl: `${wsBase.replace(/\/$/, '')}/ws?access_token=${encodeURIComponent(payload.credential)}`,
  }
  return cachedSession
}

export function clearBrowserRuntimeSession(): void {
  cachedSession = null
}
