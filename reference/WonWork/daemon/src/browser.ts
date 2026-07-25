import * as chromeLauncher from 'chrome-launcher'
import CDP from 'chrome-remote-interface'
import type { Client } from 'chrome-remote-interface'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

export interface BrowserOptions {
  browserPath?: string
  userDataDir?: string
  headless?: boolean
  viewportWidth?: number
  viewportHeight?: number
}

const DEFAULT_VIEWPORT_WIDTH = 1600
const DEFAULT_VIEWPORT_HEIGHT = 900
let chromeProcess: chromeLauncher.LaunchedChrome | null = null
let cdpClient: Client | null = null
let currentUrl = ''
let currentTitle = ''
let lastBrowserError: string | null = null

function isProcessAlive(pid: number): boolean {
  try {
    execSync(`tasklist /FI "PID eq ${pid}" /NH`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} (${ms}ms)`)), ms)
    ),
  ])
}

function detectChromePath(): string | undefined {
  // 1. Environment override
  if (process.env.WEBBRIDGE_BROWSER_PATH) {
    return process.env.WEBBRIDGE_BROWSER_PATH
  }

  // 2. Common Windows paths
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const localAppData = process.env['LOCALAPPDATA'] || ''

  const candidates = [
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFilesX86, 'Chromium', 'Application', 'chrome.exe'),
    path.join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  // 3. Try chrome-launcher's default resolution (may throw if nothing found)
  try {
    return chromeLauncher.Launcher.getInstallations()[0]
  } catch {
    return undefined
  }
}

export function getLastBrowserError(): string | null {
  return lastBrowserError
}

export async function checkChromeAvailability(): Promise<{ available: boolean; path?: string; error?: string }> {
  const detected = detectChromePath()
  if (!detected) {
    return {
      available: false,
      error: '未检测到 Chrome / Edge / Chromium。请安装 Google Chrome 或 Microsoft Edge，或设置环境变量 WEBBRIDGE_BROWSER_PATH 指向浏览器可执行文件。',
    }
  }
  return { available: true, path: detected }
}

export async function launchChrome(options: BrowserOptions = {}): Promise<chromeLauncher.LaunchedChrome> {
  if (chromeProcess && chromeProcess.pid && isProcessAlive(chromeProcess.pid)) {
    return chromeProcess
  }

  chromeProcess = null
  cdpClient = null
  lastBrowserError = null

  const browserPath = options.browserPath || detectChromePath()
  if (!browserPath || !fs.existsSync(browserPath)) {
    lastBrowserError = `未找到浏览器可执行文件：${browserPath || '(无)'}`
    throw new Error(lastBrowserError)
  }

  const chromeFlags = [
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=TranslateUI',
  ]

  if (options.headless) {
    chromeFlags.push('--headless=new')
  } else {
    const width = options.viewportWidth || DEFAULT_VIEWPORT_WIDTH
    const height = options.viewportHeight || DEFAULT_VIEWPORT_HEIGHT
    chromeFlags.push(`--window-size=${width},${height}`)
    chromeFlags.push('--force-device-scale-factor=1')
  }

  const launcherOptions: chromeLauncher.Options = {
    chromeFlags,
    startingUrl: 'about:blank',
    chromePath: browserPath,
  }

  if (options.userDataDir) {
    launcherOptions.userDataDir = options.userDataDir
  }

  try {
    chromeProcess = await withTimeout(
      chromeLauncher.launch(launcherOptions),
      20000,
      '启动浏览器超时'
    )
  } catch (err) {
    lastBrowserError = err instanceof Error ? err.message : String(err)
    throw new Error(lastBrowserError)
  }

  return chromeProcess
}

export async function connectCDP(): Promise<Client> {
  if (cdpClient) {
    return cdpClient
  }

  const port = chromeProcess?.port || 9222
  if (!port) {
    throw new Error('浏览器尚未启动，无法连接 CDP')
  }

  try {
    cdpClient = await withTimeout(CDP({ port }), 15000, '连接浏览器 CDP 超时')
  } catch (err) {
    lastBrowserError = err instanceof Error ? err.message : String(err)
    throw new Error(lastBrowserError)
  }

  await cdpClient.Page.enable()
  await cdpClient.Runtime.enable()
  await cdpClient.DOM.enable()
  try {
    await (cdpClient as any).Emulation?.enable?.()
  } catch {
    // Emulation 域可能不可用，忽略
  }

  cdpClient.on('disconnect', () => {
    cdpClient = null
  })

  return cdpClient
}

let browserLockQueue: Promise<unknown> = Promise.resolve()

/**
 * 串行执行所有需要操作共享浏览器标签页的逻辑。
 * WebBridge daemon 只有一个 CDP 客户端/一个页面；并发请求会互相覆盖导航状态，
 * 因此所有 navigate / evaluate / 提取等操作必须排队执行。
 */
export async function withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = browserLockQueue.then(async () => fn())
  // 无论成功失败都释放锁：用 .catch(() => {}) 让队列继续
  browserLockQueue = run.catch(() => {})
  return run
}

export async function ensureBrowser(options: BrowserOptions = {}): Promise<Client> {
  await launchChrome(options)
  return connectCDP()
}

export function getBrowserStatus(): { ready: boolean; error?: string; pid?: number; path?: string } {
  if (!chromeProcess) {
    return { ready: false, error: lastBrowserError || '浏览器未启动' }
  }
  if (!chromeProcess.pid) {
    return { ready: false, error: '浏览器进程未运行' }
  }
  if (!isProcessAlive(chromeProcess.pid)) {
    return { ready: false, error: '浏览器进程已退出' }
  }
  return { ready: true, pid: chromeProcess.pid, path: detectChromePath() }
}

export async function closeBrowser(): Promise<void> {
  if (cdpClient) {
    try {
      await cdpClient.close()
    } catch {
      // ignore
    }
    cdpClient = null
  }
  if (chromeProcess) {
    try {
      chromeProcess.kill()
    } catch {
      // ignore
    }
    chromeProcess = null
  }
}

export async function getPageState(client: Client): Promise<{
  url: string
  title: string
  viewport_width: number
  viewport_height: number
  scroll_x: number
  scroll_y: number
  page_height: number
  ready_state: 'loading' | 'interactive' | 'complete'
}> {
  const { Page, Runtime } = client

  const [metrics, readyState, title, url] = await Promise.all([
    Page.getLayoutMetrics(),
    Runtime.evaluate({ expression: 'document.readyState' }),
    Runtime.evaluate({ expression: 'document.title' }),
    Runtime.evaluate({ expression: 'window.location.href' }),
  ])

  const visualViewport = metrics.visualViewport

  currentUrl = String(url.result?.value || '')
  currentTitle = String(title.result?.value || '')

  return {
    url: currentUrl,
    title: currentTitle,
    viewport_width: visualViewport?.clientWidth || 1280,
    viewport_height: visualViewport?.clientHeight || 720,
    scroll_x: visualViewport?.pageX || 0,
    scroll_y: visualViewport?.pageY || 0,
    page_height: metrics.contentSize?.height || 0,
    ready_state: (readyState.result?.value || 'complete') as 'loading' | 'interactive' | 'complete',
  }
}

export function getCurrentUrl(): string {
  return currentUrl
}

export function getCurrentTitle(): string {
  return currentTitle
}

export async function captureScreenshot(client: Client, format: 'png' | 'jpeg' = 'png', quality?: number): Promise<string> {
  const { data } = await client.Page.captureScreenshot({
    format,
    ...(format === 'jpeg' && quality !== undefined ? { quality } : {}),
  })
  return data
}

// ── Screencast（接管模式：实时画面推流）──

import type { StageInputEvent } from './types/webbridge'

let screencastListenerBound = false
let currentFrameCallback: ((base64Jpeg: string) => void) | null = null

/**
 * 启动 CDP screencast：页面每次重绘产出一帧 JPEG，经 onFrame 回调推出。
 * 帧是浏览器自己触发的（无需轮询），配合 ack 流控。
 * CDP 事件监听只绑定一次，转发到"当前"回调（避免重复 start 叠加监听）。
 */
export async function startScreencast(client: Client, onFrame: (base64Jpeg: string) => void): Promise<void> {
  // 当前 chrome-remote-interface 的协议类型未含 screencast 域，CDP 本身支持，此处按运行时能力调用
  const Page = client.Page as unknown as {
    startScreencast: (params: Record<string, unknown>) => Promise<void>
    stopScreencast: () => Promise<void>
    screencastFrame: (cb: (frame: { data: string; sessionId: number }) => void) => void
    screencastFrameAck: (params: { sessionId: number }) => Promise<void>
  }
  if (!screencastListenerBound) {
    Page.screencastFrame(({ data, sessionId }) => {
      currentFrameCallback?.(data)
      Page.screencastFrameAck({ sessionId }).catch(() => undefined)
    })
    screencastListenerBound = true
  }
  currentFrameCallback = onFrame
  // 不设 maxWidth/maxHeight：帧与视口 CSS 像素 1:1，
  // 前端坐标换算（点击→Input.dispatchMouseEvent）才不会因缩放产生偏移
  await Page.startScreencast({
    format: 'jpeg',
    quality: 60,
    everyNthFrame: 1,
  })
}

export async function stopScreencast(client: Client): Promise<void> {
  currentFrameCallback = null
  try {
    await (client.Page as unknown as { stopScreencast: () => Promise<void> }).stopScreencast()
  } catch {
    // 已停止或浏览器断开，忽略
  }
}

// ── 舞台输入转发（接管模式：用户操作 → 真实浏览器）──

const KEY_DEFS: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
}

export async function dispatchStageInput(client: Client, event: StageInputEvent): Promise<void> {
  const Input = client.Input as unknown as {
    dispatchMouseEvent: (params: Record<string, unknown>) => Promise<void>
    dispatchKeyEvent: (params: Record<string, unknown>) => Promise<void>
    insertText: (params: { text: string }) => Promise<void>
  }
  switch (event.kind) {
    case 'click':
      await Input.dispatchMouseEvent({ type: 'mouseMoved', x: event.x, y: event.y })
      await Input.dispatchMouseEvent({ type: 'mousePressed', x: event.x, y: event.y, button: 'left', clickCount: 1 })
      await Input.dispatchMouseEvent({ type: 'mouseReleased', x: event.x, y: event.y, button: 'left', clickCount: 1 })
      break
    case 'scroll':
      await Input.dispatchMouseEvent({ type: 'mouseWheel', x: event.x, y: event.y, deltaX: 0, deltaY: event.deltaY })
      break
    case 'text':
      // insertText 走 IME 路径，中文等 Unicode 字符可直接输入
      await Input.insertText({ text: event.text })
      break
    case 'key': {
      const def = KEY_DEFS[event.key]
      if (!def) return
      await Input.dispatchKeyEvent({ type: 'keyDown', ...def })
      await Input.dispatchKeyEvent({ type: 'keyUp', ...def })
      break
    }
  }
}
