import type { Client } from 'chrome-remote-interface'
import type { BrowserAction, ActionResult, PageState, ActionErrorReason, ActionStateChange } from './types/webbridge'
import * as path from 'path'
import * as xlsx from 'xlsx'
import { stringify as csvStringify } from 'csv-stringify/sync'
import { getPageState, captureScreenshot, getCurrentUrl, getCurrentTitle } from './browser'
import { saveFile, generateTimestampedName, resolveWorkspaceFilePath } from './workspace'

/** 带机器可读原因码的动作错误：模型据此决策重试 / 换选择器 / 等待加载 */
export class ActionError extends Error {
  constructor(
    public reason: ActionErrorReason,
    message: string,
    public details?: string
  ) {
    super(message)
    this.name = 'ActionError'
  }
}

/**
 * 轻量页面内容指纹：url + 可见文本采样 hash + 可交互元素计数 + 滚动位置。
 * 用于 SPA 场景（url/title 不变）判断动作是否真正改变了页面。
 * 采样步长保证 O(1) 成本，大页面不卡顿。
 */
async function computeFingerprint(client: Client): Promise<string> {
  const result = await client.Runtime.evaluate({
    expression: `(() => {
      const text = (document.body && document.body.innerText) || ''
      let h = 0
      const step = Math.max(1, Math.floor(text.length / 2000))
      for (let i = 0; i < text.length; i += step) { h = (h * 31 + text.charCodeAt(i)) | 0 }
      const interactive = document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="tab"]').length
      return location.href + '|' + text.length + '|' + h + '|' + interactive + '|' + Math.round(window.scrollY)
    })()`,
    returnByValue: true,
  })
  return String(result.result.value ?? '')
}

/** 回读目标元素当前值（input/textarea 取 value，其他取文本），用于 type/clear 的确定性反馈 */
async function readElementValue(client: Client, selector: string): Promise<string | undefined> {
  try {
    const result = await client.Runtime.evaluate({
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return null
        if ('value' in el) return String(el.value)
        return (el.textContent || '').trim().slice(0, 200)
      })()`,
      returnByValue: true,
    })
    const v = result.result.value
    return v === null || v === undefined ? undefined : String(v)
  } catch {
    return undefined
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} (${ms}ms)`)), ms)
    ),
  ])
}

function cssEscape(value: string): string {
  const length = value.length
  let result = ''
  for (let i = 0; i < length; i++) {
    const c = value.charCodeAt(i)
    const char = value[i]
    if (c === 0x0000) {
      result += '\\fffd '
    } else if (
      (c >= 0x0001 && c <= 0x001f) ||
      c === 0x007f ||
      (i === 0 && c >= 0x0030 && c <= 0x0039) ||
      (i === 1 && c >= 0x0030 && c <= 0x0039 && value.charCodeAt(0) === 0x002d)
    ) {
      result += '\\' + c.toString(16) + ' '
    } else if (
      c >= 0x0080 ||
      c === 0x002d ||
      c === 0x005f ||
      (c >= 0x0030 && c <= 0x0039) ||
      (c >= 0x0041 && c <= 0x005a) ||
      (c >= 0x0061 && c <= 0x007a)
    ) {
      result += char
    } else {
      result += '\\' + char
    }
  }
  return result
}

function escapeXPathString(value: string): string {
  if (value.includes("'")) {
    const parts = value.split("'")
    return "concat('" + parts.join("', \"'\", '") + "')"
  }
  return `'${value}'`
}

async function resolveSelectorToCss(client: Client, selector?: import('./types/webbridge').ElementSelector): Promise<string | null> {
  if (!selector) return null
  const { value, selector_type } = selector
  if (!value) return null

  switch (selector_type) {
    case 'css':
      return value
    case 'id':
      return `#${cssEscape(value)}`
    case 'name':
      return `[name="${cssEscape(value)}"]`
    case 'class_name':
      return `.${cssEscape(value).replace(/\s+/g, '.')}`
    case 'tag_name':
      return value
    case 'aria_label':
      return `[aria-label="${cssEscape(value)}"]`
    case 'role':
      return `[role="${cssEscape(value)}"]`
    case 'text':
    case 'text_exact':
    case 'xpath': {
      const tmpId = `wb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      let expression: string
      if (selector_type === 'xpath') {
        const xpath = value
        expression = `(() => {
          const result = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          const el = result.singleNodeValue;
          if (el) { el.setAttribute('data-wb-tmp-id', '${tmpId}'); }
          return !!el;
        })()`
      } else if (selector_type === 'text_exact') {
        const xpath1 = `//*[text()=${escapeXPathString(value)}]`
        const xpath2 = `//*[normalize-space(text())=${escapeXPathString(value)}]`
        expression = `(() => {
          const result = document.evaluate(${JSON.stringify(xpath1)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          const el = result.singleNodeValue;
          if (el) { el.setAttribute('data-wb-tmp-id', '${tmpId}'); return true; }
          const result2 = document.evaluate(${JSON.stringify(xpath2)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          const el2 = result2.singleNodeValue;
          if (el2) { el2.setAttribute('data-wb-tmp-id', '${tmpId}'); return true; }
          return false;
        })()`
      } else {
        const xpath = `//*[contains(text(), ${escapeXPathString(value)})]`
        expression = `(() => {
          const result = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          const el = result.singleNodeValue;
          if (el) { el.setAttribute('data-wb-tmp-id', '${tmpId}'); return true; }
          return false;
        })()`
      }
      const { Runtime } = client
      const evalResult = await Runtime.evaluate({ expression, returnByValue: true })
      if (evalResult.result.value === true) {
        return `[data-wb-tmp-id="${tmpId}"]`
      }
      return null
    }
    default:
      return value
  }
}

async function resolveNodeId(client: Client, selector: string): Promise<number | null> {
  try {
    const { DOM } = client
    const { root } = await DOM.getDocument()
    const { nodeId } = await DOM.querySelector({ nodeId: root.nodeId, selector })
    return nodeId || null
  } catch {
    return null
  }
}

async function waitForSelector(client: Client, selector: string, timeoutMs = 5000): Promise<number | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const nodeId = await resolveNodeId(client, selector)
    if (nodeId) return nodeId
    await sleep(200)
  }
  return null
}

export async function executeAction(
  client: Client,
  action: BrowserAction
): Promise<ActionResult> {
  const startTime = Date.now()

  try {
    const { Page, Runtime, Input, DOM } = client
    let data: unknown = null
    let fingerprintBefore: string | undefined
    let elementValue: string | undefined

    switch (action.action_type) {
      case 'navigate': {
        const url = action.value || 'about:blank'
        const { Page } = client

        // 监听 DOMContentLoaded 或 load 事件，先触发者胜。
        // 某些站点（如百度）在 headless 模式下 load 事件可能不触发，
        // 但 DOMContentLoaded 足以认为页面可用。
        const navigationDone = new Promise<void>((resolve) => {
          let settled = false
          const settle = () => {
            if (settled) return
            settled = true
            resolve()
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pageAny = Page as any
          pageAny.domContentEventFired().then(settle).catch(() => undefined)
          pageAny.loadEventFired().then(settle).catch(() => undefined)
        })

        await Page.navigate({ url })
        try {
          await withTimeout(
            navigationDone,
            action.timeout_ms || 30000,
            '页面加载超时'
          )
        } catch (err) {
          throw new ActionError(
            'navigation_timeout',
            err instanceof Error ? err.message : '页面加载超时',
            `url: ${url}，可能是网络慢或页面资源挂起；可重试或加大 timeout_ms`
          )
        }

        data = { url }
        break
      }

      case 'refresh': {
        await Promise.all([
          Page.loadEventFired(),
          Page.reload(),
        ])
        break
      }

      case 'go_back': {
        await Page.navigate({ url: 'javascript:history.back()' })
        await sleep(500)
        break
      }

      case 'go_forward': {
        await Page.navigate({ url: 'javascript:history.forward()' })
        await sleep(500)
        break
      }

      case 'click':
      case 'double_click':
      case 'right_click':
      case 'hover': {
        const selector = await resolveSelectorToCss(client, action.selector)
        if (!selector) throw new ActionError('selector_required', 'Selector required', '请提供 selector 或先用 webbridge_locate 探测')
        const nodeId = await waitForSelector(client, selector)
        if (!nodeId) {
          throw new ActionError(
            'element_not_found',
            `Element not found: ${selector}`,
            `选择器 ${selector} 在等待超时内未匹配到元素；可能文案不匹配（试试语义等价词）、元素未渲染（先 wait_for_element）或页面已跳转`
          )
        }

        fingerprintBefore = await computeFingerprint(client)

        let x: number, y: number
        try {
          const { model } = await DOM.getBoxModel({ nodeId })
          const width = model.content[2] - model.content[0]
          const height = model.content[5] - model.content[1]
          if (width <= 0 || height <= 0) throw new Error('zero-size box')
          ;[x, y] = [model.content[0] + 5, model.content[1] + 5]
        } catch {
          throw new ActionError(
            'element_not_interactable',
            `Element not interactable: ${selector}`,
            '元素存在但不可见或尺寸为 0（可能被隐藏/遮挡）；可先滚动到可见区域或换候选元素'
          )
        }

        if (action.action_type === 'click') {
          await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
          await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
        } else if (action.action_type === 'double_click') {
          await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 2 })
          await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 2 })
        } else if (action.action_type === 'right_click') {
          await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'right', clickCount: 1 })
          await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'right', clickCount: 1 })
        } else {
          await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y })
        }
        break
      }

      case 'type': {
        const selector = await resolveSelectorToCss(client, action.selector)
        const value = action.value || ''
        if (!selector) throw new ActionError('selector_required', 'Selector required', '请提供 selector 或先用 webbridge_locate 探测')
        const nodeId = await waitForSelector(client, selector)
        if (!nodeId) {
          throw new ActionError(
            'element_not_found',
            `Element not found: ${selector}`,
            `选择器 ${selector} 未匹配到输入元素；可换 placeholder/aria-label 描述（如"搜索框"）或先 locate 探测`
          )
        }

        fingerprintBefore = await computeFingerprint(client)
        await DOM.focus({ nodeId })
        await Input.insertText({ text: value })
        elementValue = await readElementValue(client, selector)
        data = { selector, value }
        break
      }

      case 'clear': {
        const selector = await resolveSelectorToCss(client, action.selector)
        if (!selector) throw new ActionError('selector_required', 'Selector required', '请提供 selector')
        const nodeId = await waitForSelector(client, selector)
        if (!nodeId) throw new ActionError('element_not_found', `Element not found: ${selector}`)

        fingerprintBefore = await computeFingerprint(client)
        await DOM.focus({ nodeId })
        await Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', modifiers: 2 })
        await Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', modifiers: 2 })
        await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Delete' })
        await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Delete' })
        elementValue = await readElementValue(client, selector)
        break
      }

      case 'select': {
        const selector = await resolveSelectorToCss(client, action.selector)
        const value = action.value || ''
        if (!selector) throw new ActionError('selector_required', 'Selector required', '请提供 selector')
        fingerprintBefore = await computeFingerprint(client)
        const selectResult = await Runtime.evaluate({
          expression: `(() => { const el = document.querySelector('${selector.replace(/'/g, "\\'")}'); if (!el) return false; el.value = '${value.replace(/'/g, "\\'")}'; el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`,
          returnByValue: true,
        })
        if (selectResult.result.value !== true) {
          throw new ActionError('element_not_found', `Element not found: ${selector}`)
        }
        break
      }

      case 'check': {
        const selector = await resolveSelectorToCss(client, action.selector)
        if (!selector) throw new ActionError('selector_required', 'Selector required', '请提供 selector')
        fingerprintBefore = await computeFingerprint(client)
        const checkResult = await Runtime.evaluate({
          expression: `(() => { const el = document.querySelector('${selector.replace(/'/g, "\\'")}'); if (!el) return false; el.checked = !el.checked; el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`,
          returnByValue: true,
        })
        if (checkResult.result.value !== true) {
          throw new ActionError('element_not_found', `Element not found: ${selector}`)
        }
        break
      }

      case 'upload': {
        const selector = await resolveSelectorToCss(client, action.selector)
        const relativePath = action.value || ''
        if (!selector) throw new ActionError('selector_required', 'Selector required', '请提供文件输入框的 selector')
        if (!relativePath) throw new ActionError('selector_required', 'File path required', '请提供要上传的文件相对路径')

        const filePath = resolveWorkspaceFilePath(relativePath)
        const nodeId = await waitForSelector(client, selector)
        if (!nodeId) throw new ActionError('element_not_found', `Element not found: ${selector}`, '文件输入框未找到；注意 input[type=file] 可能不可见，尝试用显式 CSS 选择器')

        const { DOM } = client
        await (DOM as unknown as { setFileInputFiles: (params: { nodeId: number; files: string[] }) => Promise<unknown> }).setFileInputFiles({ nodeId, files: [filePath] })
        data = { selector, filePath }
        break
      }

      case 'extract_text': {
        const result = await Runtime.evaluate({
          expression: 'document.body.innerText',
          returnByValue: true,
        })
        data = result.result.value
        break
      }

      case 'extract_html': {
        const result = await Runtime.evaluate({
          expression: 'document.documentElement.outerHTML',
          returnByValue: true,
        })
        data = result.result.value
        break
      }

      case 'extract_table': {
        const result = await Runtime.evaluate({
          expression: `(() => {
            const tables = Array.from(document.querySelectorAll('table'));
            return tables.slice(0, 5).map(t => {
              const rows = Array.from(t.querySelectorAll('tr'));
              return rows.map(r => Array.from(r.querySelectorAll('td, th')).map(c => c.innerText));
            });
          })()`,
          returnByValue: true,
        })
        data = result.result.value
        break
      }

      case 'export_table': {
        const format = action.value || 'csv'
        const selector = action.selector?.value || ''
        let tableData: unknown = null

        if (selector) {
          const result = await Runtime.evaluate({
            expression: `(() => {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return null;
              const rows = Array.from(el.querySelectorAll('tr'));
              return rows.map(r => Array.from(r.querySelectorAll('td, th')).map(c => c.innerText));
            })()`,
            returnByValue: true,
          })
          tableData = result.result.value
        } else {
          const result = await Runtime.evaluate({
            expression: `(() => {
              const tables = Array.from(document.querySelectorAll('table'));
              return tables.length > 0 ? tables[0] : null;
            })()`,
            returnByValue: true,
          })
          const tableEl = result.result.value
          if (!tableEl) throw new ActionError('no_table_found', 'No table found on page', '页面上没有 <table> 元素；可能是 div 布局的"伪表格"，可改用 extract_text 或 extract_html')
          const rowsResult = await Runtime.evaluate({
            expression: `(() => {
              const table = document.querySelector('table');
              if (!table) return null;
              const rows = Array.from(table.querySelectorAll('tr'));
              return rows.map(r => Array.from(r.querySelectorAll('td, th')).map(c => c.innerText));
            })()`,
            returnByValue: true,
          })
          tableData = rowsResult.result.value
        }

        if (!tableData || !Array.isArray(tableData) || tableData.length === 0) {
          throw new ActionError('no_table_found', 'No table data to export', '表格存在但没有数据行；可能是虚拟滚动只渲染了可见区，可先滚动加载再导出')
        }

        const rows = tableData as string[][]
        const ext = format === 'xlsx' ? '.xlsx' : '.csv'
        const filename = action.options?.filename as string | undefined || generateTimestampedName(getCurrentTitle() || 'table', ext)
        let buffer: Buffer

        if (format === 'xlsx') {
          const ws = xlsx.utils.aoa_to_sheet(rows)
          const wb = xlsx.utils.book_new()
          xlsx.utils.book_append_sheet(wb, ws, 'Sheet1')
          buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
        } else {
          const csv = csvStringify(rows)
          buffer = Buffer.from(csv, 'utf-8')
        }

        const result = await saveFile('exports', filename, buffer)
        data = { ...result, format, rows: rows.length }
        break
      }

      case 'screenshot': {
        data = await captureScreenshot(client)
        break
      }

      case 'get_url': {
        data = getCurrentUrl()
        break
      }

      case 'get_title': {
        data = getCurrentTitle()
        break
      }

      case 'scroll': {
        const amount = action.amount || 300
        fingerprintBefore = await computeFingerprint(client)
        await Runtime.evaluate({ expression: `window.scrollBy(0, ${amount})` })
        break
      }

      case 'scroll_to': {
        const y = action.coordinates?.[1] || 0
        fingerprintBefore = await computeFingerprint(client)
        await Runtime.evaluate({ expression: `window.scrollTo(0, ${y})` })
        break
      }

      case 'scroll_to_top': {
        fingerprintBefore = await computeFingerprint(client)
        await Runtime.evaluate({ expression: 'window.scrollTo(0, 0)' })
        break
      }

      case 'scroll_to_bottom': {
        fingerprintBefore = await computeFingerprint(client)
        await Runtime.evaluate({ expression: 'window.scrollTo(0, document.body.scrollHeight)' })
        break
      }

      case 'wait': {
        await sleep(action.delay_ms || 1000)
        data = { waited_ms: action.delay_ms || 1000 }
        break
      }

      case 'wait_for_element': {
        const selector = await resolveSelectorToCss(client, action.selector)
        if (!selector) throw new ActionError('selector_required', 'Selector required', '请提供 selector')
        const nodeId = await waitForSelector(client, selector, action.delay_ms || 5000)
        if (!nodeId) {
          throw new ActionError(
            'element_not_found',
            `Element not found within timeout: ${selector}`,
            `等待 ${action.delay_ms || 5000}ms 后元素仍未出现；可能页面加载慢（加大 delay_ms）或选择器不匹配`
          )
        }
        data = { found: true }
        break
      }

      case 'wait_for_navigation': {
        await Page.loadEventFired()
        break
      }

      case 'evaluate': {
        const script = action.value || ''
        const result = await Runtime.evaluate({ expression: script, returnByValue: true })
        data = result.result.value
        break
      }

      case 'download': {
        const url = action.value || ''
        if (!url) throw new ActionError('selector_required', 'Download URL required', '请提供下载地址')
        const filename = generateTimestampedName(new URL(url).hostname || 'download', path.extname(new URL(url).pathname) || '.bin')
        const response = await fetch(url)
        if (!response.ok) throw new ActionError('download_failed', `Download failed: HTTP ${response.status}`, `url: ${url}`)
        const buffer = Buffer.from(await response.arrayBuffer())
        const result = await saveFile('downloads', filename, buffer)
        data = result
        break
      }

      case 'save_page': {
        const html = await Runtime.evaluate({
          expression: 'document.documentElement.outerHTML',
          returnByValue: true,
        })
        const filename = generateTimestampedName(getCurrentTitle() || 'page', '.html')
        const result = await saveFile('snapshots', filename, String(html.result.value))
        data = result
        break
      }

      default:
        throw new ActionError('unsupported_action', `Unsupported action type: ${action.action_type}`)
    }

    // 动作后短暂等待 SPA 渲染，再采指纹对比——url/title 不变时也能判断页面是否变化
    let stateChange: ActionStateChange | undefined
    if (fingerprintBefore !== undefined) {
      await sleep(250)
      const fingerprintAfter = await computeFingerprint(client)
      stateChange = {
        dom_changed: fingerprintAfter !== fingerprintBefore,
        fingerprint_before: fingerprintBefore,
        fingerprint_after: fingerprintAfter,
        ...(elementValue !== undefined ? { element_value: elementValue } : {}),
      }
    }

    const pageState = await getPageState(client)
    const execution_time_ms = Date.now() - startTime

    return {
      action,
      success: true,
      data,
      ...(stateChange ? { state_change: stateChange } : {}),
      execution_time_ms,
      page_state_after: pageState as PageState,
    }
  } catch (err) {
    const execution_time_ms = Date.now() - startTime
    if (err instanceof ActionError) {
      return {
        action,
        success: false,
        error_message: err.message,
        error_reason: err.reason,
        error_details: err.details,
        execution_time_ms,
      }
    }
    return {
      action,
      success: false,
      error_message: err instanceof Error ? err.message : 'Unknown error',
      error_reason: 'unknown',
      execution_time_ms,
    }
  }
}
