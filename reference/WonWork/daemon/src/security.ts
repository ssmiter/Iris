import type { SecurityPolicy, BrowserAction } from './types/webbridge'

const FINANCIAL_KEYWORDS = [
  'bank', 'payment', 'pay', 'wallet', 'alipay', 'wechatpay', 'paypal',
  'credit', 'debit', 'transaction', 'finance', '证券', '银行', '支付', '钱包',
]

const GOVERNMENT_KEYWORDS = [
  'gov', 'government', '税务', '社保', '公安', '政府', '政务', 'china',
]

function isDomainMatch(domain: string, patterns: string[]): boolean {
  const lowerDomain = domain.toLowerCase()
  return patterns.some((pattern) => {
    const lowerPattern = pattern.toLowerCase()
    return lowerDomain === lowerPattern || lowerDomain.endsWith(`.${lowerPattern}`)
  })
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname
  } catch {
    return null
  }
}

function isSensitiveDomain(domain: string, blockFinancial: boolean, blockGovernment: boolean): string | null {
  if (blockFinancial && FINANCIAL_KEYWORDS.some((k) => domain.includes(k))) {
    return `Financial site blocked: ${domain}`
  }
  if (blockGovernment && GOVERNMENT_KEYWORDS.some((k) => domain.includes(k))) {
    return `Government site blocked: ${domain}`
  }
  return null
}

export function checkSecurityPolicy(
  action: BrowserAction,
  policy: SecurityPolicy,
  currentUrl: string
): { allowed: boolean; reason?: string } {
  if (policy.security_level === 'read_only') {
    const interactiveActions = [
      'click', 'double_click', 'right_click', 'hover',
      'type', 'clear', 'select', 'check', 'upload',
      'new_tab', 'switch_tab', 'close_tab', 'evaluate',
    ]
    if (interactiveActions.includes(action.action_type)) {
      return { allowed: false, reason: `Action "${action.action_type}" not allowed in read_only mode` }
    }
  }

  if (action.action_type === 'upload' && policy.allow_file_upload === false) {
    return { allowed: false, reason: 'File upload disabled' }
  }

  if (action.action_type === 'download' && policy.allow_file_download === false) {
    return { allowed: false, reason: 'File download disabled' }
  }

  if (action.action_type === 'evaluate' && policy.allow_javascript === false) {
    return { allowed: false, reason: 'JavaScript evaluation disabled' }
  }

  if (action.action_type === 'navigate' && action.value) {
    const domain = extractDomain(action.value)
    if (domain) {
      if (policy.blocked_domains && policy.blocked_domains.length > 0 && isDomainMatch(domain, policy.blocked_domains)) {
        return { allowed: false, reason: `Domain blocked: ${domain}` }
      }

      if (policy.allowed_domains && policy.allowed_domains.length > 0 && !isDomainMatch(domain, policy.allowed_domains)) {
        return { allowed: false, reason: `Domain not in allowlist: ${domain}` }
      }

      const sensitiveReason = isSensitiveDomain(domain, !!policy.block_financial_sites, !!policy.block_government_sites)
      if (sensitiveReason) {
        return { allowed: false, reason: sensitiveReason }
      }
    }
  }

  if (policy.require_domain_approval) {
    const domain = extractDomain(action.value || currentUrl)
    if (domain && (!policy.allowed_domains || policy.allowed_domains.length === 0)) {
      return { allowed: false, reason: 'Domain approval required but allowlist is empty' }
    }
  }

  return { allowed: true }
}

export class RateLimiter {
  private timestamps: number[] = []
  private lastActionTime = 0

  constructor(
    private maxActionsPerMinute: number,
    private delayBetweenActionsMs: number
  ) {}

  async throttle(): Promise<void> {
    const now = Date.now()
    const elapsed = now - this.lastActionTime
    if (elapsed < this.delayBetweenActionsMs) {
      await new Promise((resolve) => setTimeout(resolve, this.delayBetweenActionsMs - elapsed))
    }

    this.timestamps = this.timestamps.filter((t) => Date.now() - t < 60000)
    if (this.timestamps.length >= this.maxActionsPerMinute) {
      const oldest = this.timestamps[0]
      const wait = 60000 - (Date.now() - oldest) + 50
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
    }

    this.lastActionTime = Date.now()
    this.timestamps.push(this.lastActionTime)
  }
}
