import { useTokenHubStore } from '@/stores/tokenHubStore'

/**
 * 会话守卫（2026-08-06 单账号单客户端，实施方案 §7.1）
 *
 * 职责唯一：周期性询问本机 AIGateway /api/auth/session-state，
 * 收到明确失效码时把本客户端踢回登录页。检测与判定全部在后端
 * （SessionLeaseService → website），前端不做任何会话逻辑，只做翻译。
 *
 * 关键约束：
 * - Authorization 钉 wonclaw_website_token，不随 mescli-online 活跃身份切换
 *   （MES 登录后 wonclaw_token 是 MES JWT，website 会话由 website token 承载）。
 * - 轮询本机端点（localhost），免费且不受公网抖动影响；网络错误一律 fail-open 跳过。
 * - kick 遵循 r282 快照原则：发起轮询时的 token 与当前存储一致才清理，
 *   迟到的失效事件不得误伤重新登录的新会话。
 * - kick 后整页 reload：登录态由启动引导（restoreWebsiteSession/fetchUser）重新收敛，
 *   无需在此手工复位 zustand。
 */

const NOTICE_KEY = 'wonclaw_session_notice'
const POLL_BASE_MS = 60_000
const POLL_JITTER_MS = 10_000

let timer: number | null = null
let running = false

export function startSessionGuard(): void {
  if (running) return
  running = true
  scheduleNext()
}

export function stopSessionGuard(): void {
  running = false
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
}

function scheduleNext(): void {
  if (!running) return
  const jitter = Math.floor(Math.random() * (POLL_JITTER_MS * 2 + 1)) - POLL_JITTER_MS
  timer = window.setTimeout(() => {
    void tick()
  }, POLL_BASE_MS + jitter)
}

async function tick(): Promise<void> {
  if (!running) return
  try {
    const token = localStorage.getItem('wonclaw_website_token')
    if (token) {
      const res = await fetch('/api/auth/session-state', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      if (res.ok) {
        const data = (await res.json()) as { status?: string; code?: string }
        if (data.status === 'revoked' && data.code) {
          kick(token, data.code)
          return
        }
        // active / unknown / anonymous：无动作（fail-open）
      }
      // 非 2xx（本机后端暂不可达等）：跳过本轮，绝不因状况不明而踢人
    }
  } catch {
    // 网络错误：跳过本轮，fail-open——状况不明时宁可不踢
  } finally {
    scheduleNext()
  }
}

function kick(token: string, code: string): void {
  // 快照比对：轮询发出后用户可能已重新登录，新会话不得被旧 token 的迟到失效误伤
  if (localStorage.getItem('wonclaw_website_token') !== token) return

  stopSessionGuard()
  localStorage.removeItem('wonclaw_token')
  localStorage.removeItem('wonclaw_website_token')
  // MES 透传凭证一并清除，否则"已踢出"名不副实（与 authStore.clearMesLocalState 同一清单）
  localStorage.removeItem('wonclaw_user_id')
  localStorage.removeItem('wonclaw_user_name')
  localStorage.removeItem('wonclaw_real_name')
  localStorage.removeItem('wonclaw_role_id')
  localStorage.removeItem('wonclaw_factory_id')
  localStorage.removeItem('wonclaw_dept_id')
  localStorage.removeItem('wonclaw_workshop_id')
  localStorage.removeItem('wonclaw_system_code')
  useTokenHubStore.getState().clear()

  // reload 后 toast 上下文已失，留旗标让登录页按码显示解释文案
  try {
    sessionStorage.setItem(NOTICE_KEY, code)
  } catch {
    // sessionStorage 不可用时静默降级（只是少一行解释）
  }
  window.location.reload()
}
