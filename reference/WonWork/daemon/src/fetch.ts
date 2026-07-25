import { ensureBrowser } from './browser'
import { executeAction } from './actions'
import type { Client } from 'chrome-remote-interface'

export interface FetchRequest {
  url: string
  selector?: string
  mode?: 'text' | 'html'
  maxLength?: number
}

export interface FetchResponse {
  success: boolean
  url: string
  title: string
  content: string
  contentType: 'text' | 'html'
  totalChars: number
  truncated: boolean
  error?: string
}

interface BrowserOptions {
  browserPath?: string
  headless?: boolean
}

function getBrowserOptions(): BrowserOptions {
  return {
    browserPath: process.env.WEBBRIDGE_BROWSER_PATH,
    headless: process.env.WEBBRIDGE_HEADLESS === 'true',
  }
}

function validateUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`)
  }
}

async function runAction(client: Client, actionType: 'navigate' | 'get_title' | 'evaluate', value?: string, timeoutMs?: number) {
  const result = await executeAction(client, {
    action_type: actionType,
    value,
    timeout_ms: timeoutMs,
  })
  if (!result.success) {
    throw new Error(result.error_message || `Action ${actionType} failed`)
  }
  return result.data
}

function buildExtractionScript(selector: string | undefined, mode: 'text' | 'html'): string {
  if (selector) {
    const safeSelector = JSON.stringify(selector)
    if (mode === 'html') {
      return `(() => {
        const el = document.querySelector(${safeSelector})
        return el ? el.outerHTML : null
      })()`
    }
    return `(() => {
      const el = document.querySelector(${safeSelector})
      return el ? el.innerText : null
    })()`
  }

  if (mode === 'html') {
    return 'document.documentElement.outerHTML'
  }
  return 'document.body.innerText'
}

export async function performFetch(params: FetchRequest): Promise<FetchResponse> {
  const { url, selector, mode = 'text', maxLength = 200000 } = params

  if (!url) {
    return { success: false, url: '', title: '', content: '', contentType: mode, totalChars: 0, truncated: false, error: 'URL is required' }
  }

  try {
    validateUrl(url)
  } catch (err) {
    return {
      success: false,
      url,
      title: '',
      content: '',
      contentType: mode,
      totalChars: 0,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  const client = await ensureBrowser(getBrowserOptions())

  try {
    await runAction(client, 'navigate', url, 30000)

    const title = String((await runAction(client, 'get_title')) || '')

    const script = buildExtractionScript(selector, mode)
    const rawContent = await runAction(client, 'evaluate', script)

    if (selector && rawContent === null) {
      throw new Error(`Selector not found: ${selector}`)
    }

    const fullContent = String(rawContent || '')
    const totalChars = fullContent.length
    const truncated = totalChars > maxLength
    const content = truncated ? fullContent.slice(0, maxLength) : fullContent

    // 释放页面，避免长期占用标签页
    await runAction(client, 'navigate', 'about:blank')

    return {
      success: true,
      url,
      title,
      content,
      contentType: mode,
      totalChars,
      truncated,
    }
  } catch (err) {
    return {
      success: false,
      url,
      title: '',
      content: '',
      contentType: mode,
      totalChars: 0,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
