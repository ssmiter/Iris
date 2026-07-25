import type { ToolExecutionContext } from '@/agent/types'
import { webBridgeClient } from '@/api/webbridgeClient'
import { useWebBridgeStore } from '@/stores/webbridgeStore'
import { writeFile } from '@/services/fileSystem'
import { safeStringify } from '@/utils/safeSerialize'
import type {
  BrowserAction,
  ActionResult,
  ActionErrorReason,
  ActionStateChange,
  PageState,
  ElementSelector,
} from '@/types/webbridge'

export interface WebBridgePrimitiveResult {
  success: boolean
  url: string
  title: string
  summary: string
  screenshot_path?: string
  cached_path?: string
  candidates?: Array<{ selector: string; text: string; tag: string }>
  error?: string
  /** 机器可读失败原因（element_not_found 等），模型据此决策重试/换选择器 */
  reason?: ActionErrorReason
  /** 动作前后页面状态对比：SPA 场景判断操作是否生效 */
  state_change?: ActionStateChange
}

/** daemon 动作失败：携带机器可读 reason/details，便于等价词重试等自动恢复 */
export class WebBridgeActionError extends Error {
  constructor(
    message: string,
    public reason?: ActionErrorReason,
    public details?: string
  ) {
    super(message)
    this.name = 'WebBridgeActionError'
  }
}

/**
 * 自然语言 → 符号/英文的语义等价表。
 * 体验复盘：计算器场景"乘"找不到 ×、"等号"找不到 =，符号类点击 40% 需手动降级。
 * key 命中（target 等于或包含 key）时，匹配词表整体扩展。
 */
const SEMANTIC_EQUIVALENTS: Record<string, string[]> = {
  乘: ['×', '*', 'x', 'X', 'multiply'],
  除: ['÷', '/', 'divide'],
  加: ['+', 'plus'],
  减: ['-', '−', 'minus', 'subtract'],
  等号: ['=', 'equals', 'equal'],
  等于: ['=', 'equals', 'equal'],
  百分: ['%', 'percent'],
  小数点: ['.', '·', 'point', 'dot'],
  删除: ['Del', 'Delete', '⌫', 'Backspace', 'CE', '退格'],
  退格: ['Backspace', '⌫', 'Delete', '删除'],
  清除: ['C', 'AC', 'Clear', '清空'],
  搜索: ['Search', 'search', '🔍', '百度一下', '搜一下'],
  登录: ['Login', 'Log in', 'Sign in', '登录/注册', '登 录'],
  注册: ['Register', 'Sign up', 'Sign Up'],
  提交: ['Submit', 'OK', '确定', '确认'],
  确定: ['OK', 'Confirm', '确认', '提交'],
  取消: ['Cancel', '关闭', '✕'],
  关闭: ['Close', '✕', '×'],
  下一页: ['Next', '>', '»', '下页'],
  上一页: ['Prev', 'Previous', '<', '«', '上页'],
}

/** 返回 target 的等价匹配词表（含自身）。无命中时返回 [target]。 */
export function expandEquivalents(target: string): string[] {
  const variants = [target]
  for (const [key, equivalents] of Object.entries(SEMANTIC_EQUIVALENTS)) {
    if (target === key || target.includes(key)) {
      for (const eq of equivalents) {
        if (!variants.includes(eq)) variants.push(eq)
      }
    }
  }
  return variants
}

export interface ArtifactWriteOptions {
  encoding?: 'utf-8' | 'base64'
}

export function nowTimestamp(): string {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`
}

export function simpleHash(input: string): string {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash |= 0
  }
  return Math.abs(hash).toString(36).slice(0, 6)
}

export function sanitizeKey(input: string): string {
  return input
    .replace(/[\\/:*?"()<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 60)
    .replace(/^_+|_+$/g, '')
}

export function buildArtifactPath(
  prefix: string,
  ext: string,
  seed = ''
): string {
  const safePrefix = sanitizeKey(prefix) || 'webbridge'
  const timestamp = nowTimestamp()
  const hash = seed ? simpleHash(seed) : simpleHash(`${timestamp}${Math.random()}`)
  return `/workspace/scratch/web_cache/webbridge/${safePrefix}_${timestamp}_${hash}.${ext}`
}

export async function writeArtifact(
  path: string,
  content: string,
  options?: ArtifactWriteOptions
): Promise<void> {
  await writeFile(path, content, options)
}

export function assertConnected(): void {
  if (!webBridgeClient.isConnected) {
    throw new Error('WebBridge daemon 未连接，无法执行浏览器自动化')
  }
}

export async function sendBrowserAction(
  action: BrowserAction,
  ctx?: ToolExecutionContext
): Promise<ActionResult> {
  assertConnected()

  ctx?.onProgress?.({
    toolCallId: '',
    toolName: `webbridge_${action.action_type}`,
    status: 'running',
    message: action.description || action.action_type,
  })

  const result = await useWebBridgeStore.getState().sendAction(action)
  if (!result) {
    throw new WebBridgeActionError('WebBridge action 未返回结果', 'unknown')
  }
  if (!result.success) {
    throw new WebBridgeActionError(
      result.error_message || `${action.action_type} 执行失败`,
      result.error_reason,
      result.error_details
    )
  }
  return result
}

export async function getCurrentPageState(): Promise<PageState> {
  assertConnected()
  const storeState = useWebBridgeStore.getState().pageState
  if (storeState) return storeState

  const [urlResult, titleResult] = await Promise.all([
    sendBrowserAction({ action_type: 'get_url' }),
    sendBrowserAction({ action_type: 'get_title' }),
  ])

  return {
    url: (urlResult.data as string) || '',
    title: (titleResult.data as string) || '',
    viewport_width: 1280,
    viewport_height: 720,
    scroll_x: 0,
    scroll_y: 0,
    page_height: 0,
    ready_state: 'complete',
  }
}

export function targetToSelector(target: string): ElementSelector {
  // 简单启发：如果用户给了 CSS/XPath 形式的字符串，直接当 css 用；否则按可见文本匹配
  const looksLikeSelector = /^[.#\[\w_-]/.test(target) && /[.#\[\]>+~:]/.test(target)
  return {
    selector_type: looksLikeSelector ? 'css' : 'text',
    value: target,
  }
}

export function buildLocateScript(target: string, maxCandidates = 5, variants?: string[]): string {
  const allVariants = (variants && variants.length > 0 ? variants : [target])
    .map((v) => v.toLowerCase().trim())
    .filter(Boolean)
  return `(() => {
    const variants = ${JSON.stringify(allVariants)}
    const max = ${maxCandidates}
    if (variants.length === 0) return []

    function matchText(lowerText) {
      // 返回 0=不匹配 1=包含 2=精确；等价词表中任一词命中即算匹配
      let best = 0
      for (const v of variants) {
        if (lowerText === v) return 2
        if (lowerText.includes(v)) best = Math.max(best, 1)
      }
      return best
    }

    const skipTags = new Set(['html','body','head','script','style','noscript','iframe','meta','link','svg','path','g'])
    const interactiveTags = new Set(['a','button','input','textarea','select','label'])
    const interactiveRoles = new Set(['button','link','textbox','searchbox','checkbox','radio','tab','menuitem'])

    function cssEscape(value) {
      try {
        return CSS.escape(value)
      } catch {
        return value.replace(/([^a-zA-Z0-9_\--￿])/g, '\\\\$1')
      }
    }

    function uniqueSelector(el) {
      if (el.id) return '#' + cssEscape(el.id)
      const tag = el.tagName.toLowerCase()
      if (el.className && typeof el.className === 'string') {
        const classes = el.className.split(/\\s+/).filter(Boolean).filter(c => !/^\\d/.test(c)).slice(0, 3)
        if (classes.length > 0) {
          return tag + '.' + classes.map(cssEscape).join('.')
        }
      }
      for (const attr of ['placeholder','aria-label','name']) {
        const val = el.getAttribute?.(attr)
        if (val) {
          return tag + '[' + attr + '="' + cssEscape(val) + '"]'
        }
      }
      return tag
    }

    function isInteractive(el) {
      const tag = el.tagName.toLowerCase()
      if (interactiveTags.has(tag)) return true
      const role = el.getAttribute?.('role')
      if (role && interactiveRoles.has(role.toLowerCase())) return true
      if (el.onclick != null) return true
      const style = window.getComputedStyle(el)
      if (style.cursor === 'pointer') return true
      return false
    }

    function elementArea(el) {
      const rect = el.getBoundingClientRect?.()
      if (!rect) return 0
      return rect.width * rect.height
    }

    const viewportArea = (window.innerWidth * window.innerHeight) || 1
    const all = Array.from(document.querySelectorAll('*'))
    const matches = []

    // 文本匹配
    for (const el of all) {
      const tag = el.tagName?.toLowerCase()
      if (!tag || skipTags.has(tag)) continue
      const text = (el.textContent || '').trim()
      const lowerText = text.toLowerCase()
      const m = matchText(lowerText)
      if (m === 0) continue
      const exact = m === 2
      if (elementArea(el) > viewportArea * 0.8) continue
      if (text.length > 1000 && !exact) continue
      matches.push({
        el,
        tag,
        selector: uniqueSelector(el),
        text: text.slice(0, 200),
        exact,
        interactive: isInteractive(el),
        textLen: text.length,
      })
    }

    // 属性匹配（placeholder、aria-label、title、name）
    if (matches.length < max) {
      for (const el of all) {
        const tag = el.tagName?.toLowerCase()
        if (!tag || skipTags.has(tag)) continue
        if (matches.some(m => m.el === el)) continue
        for (const attr of ['placeholder','aria-label','title','name']) {
          const val = el.getAttribute?.(attr)
          if (val && matchText(val.toLowerCase()) > 0) {
            matches.push({
              el,
              tag,
              selector: uniqueSelector(el),
              text: (el.textContent || val || '').trim().slice(0, 200),
              exact: false,
              interactive: isInteractive(el),
              textLen: (el.textContent || val || '').length,
            })
            break
          }
        }
      }
    }

    // 排序：精确匹配 > 可交互 > 文本短（更具体）
    matches.sort((a, b) => {
      if (a.exact && !b.exact) return -1
      if (!a.exact && b.exact) return 1
      if (a.interactive && !b.interactive) return -1
      if (!a.interactive && b.interactive) return 1
      return a.textLen - b.textLen
    })

    const seen = new Set()
    const result = []
    for (const m of matches) {
      const key = m.selector + '|' + m.text
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ tag: m.tag, selector: m.selector, text: m.text })
      if (result.length >= max) break
    }
    return result
  })()`
}

export function truncateText(text: string, max = 2000): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n…（已省略 ${text.length - max} 字符）`
}

export function formatDataSummary(data: unknown): string {
  if (typeof data === 'string') return truncateText(data)
  return truncateText(safeStringify(data, 2000))
}

export function buildPrimitiveResult(
  success: boolean,
  pageState: PageState,
  summary: string,
  options?: {
    screenshotPath?: string
    cachedPath?: string
    candidates?: WebBridgePrimitiveResult['candidates']
    error?: string
    reason?: ActionErrorReason
    stateChange?: ActionStateChange
  }
): WebBridgePrimitiveResult {
  return {
    success,
    url: pageState.url || '',
    title: pageState.title || '',
    summary,
    ...(options?.screenshotPath ? { screenshot_path: options.screenshotPath } : {}),
    ...(options?.cachedPath ? { cached_path: options.cachedPath } : {}),
    ...(options?.candidates ? { candidates: options.candidates } : {}),
    ...(options?.error ? { error: options.error } : {}),
    ...(options?.reason ? { reason: options.reason } : {}),
    ...(options?.stateChange ? { state_change: options.stateChange } : {}),
  }
}

/** 把 state_change 渲染成一句话摘要，拼进工具结果给模型看 */
export function describeStateChange(stateChange?: ActionStateChange): string {
  if (!stateChange) return ''
  const parts: string[] = []
  parts.push(stateChange.dom_changed ? '页面内容已变化' : '页面内容无变化（url/title 之外的指纹比对）')
  if (stateChange.element_value !== undefined) {
    parts.push(`目标元素当前值："${stateChange.element_value}"`)
  }
  return `（${parts.join('；')}）`
}
