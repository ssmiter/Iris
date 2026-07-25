import http from 'http'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import {
  ensureBrowser,
  closeBrowser,
  getBrowserStatus,
  getPageState,
  checkChromeAvailability,
  getLastBrowserError,
  captureScreenshot,
  startScreencast,
  stopScreencast,
  dispatchStageInput,
} from './browser'
import { executeAction } from './actions'
import { checkSecurityPolicy, RateLimiter } from './security'
import {
  parseRequest,
  sendResponse,
  createResponse,
  isActionPayload,
  isSecurityPolicyPayload,
  createRecordedActionResponse,
  createSelectorResolvedResponse,
  isWorkspaceListPayload,
  isWorkspaceFilePayload,
  isWriteWorkspaceFilePayload,
  createWorkspaceFilesResponse,
  createWorkspaceFileContentResponse,
  createWorkspaceFileSavedResponse,
} from './protocol'
import { startRecording, stopRecording, isCurrentlyRecording } from './recorder'
import { resolveSelectorAtPoint } from './selectorResolver'
import { performSearch } from './search'
import { performFetch } from './fetch'
import { ensureWorkspace, listFiles, listAllWorkspaceFiles, deleteWorkspaceFile, readFileAsBase64, saveFileFromBase64, type WorkspaceSubdir } from './workspace'
import type { SecurityPolicy, BrowserAction, WebBridgeConfig, StageInputEvent } from './types/webbridge'
import { withBrowserLock } from './browser'

const PORT = parseInt(process.env.WEBBRIDGE_PORT || '9223', 10)
const BROWSER_PATH = process.env.WEBBRIDGE_BROWSER_PATH
// 默认 headless（与生产一致）：可见窗口最小化/被遮挡时 Chrome 节流渲染，
// CDP 截图与动作会挂起；且弹出的独立窗口会把用户带离对话场景。
// 调试需看真实窗口时显式设 WEBBRIDGE_HEADLESS=false。
const HEADLESS = process.env.WEBBRIDGE_HEADLESS !== 'false'
// 实况缩略帧（浏览器舞台）：默认开启，JPEG 质量 45
const LIVE_THUMB = process.env.WEBBRIDGE_LIVE_THUMB !== 'false'
const LIVE_THUMB_QUALITY = parseInt(process.env.WEBBRIDGE_LIVE_THUMB_QUALITY || '45', 10)
// 不改变画面/自身已返回截图的动作不附缩略帧
const NO_THUMB_ACTIONS = new Set([
  'screenshot',
  'get_url',
  'get_title',
  'wait',
  'wait_for_element',
  'extract_text',
  'extract_html',
  'extract_table',
  'export_table',
  'download',
  'save_page',
])

const defaultSecurityPolicy: SecurityPolicy = {
  security_level: 'standard',
  allow_file_download: true,
  allow_file_upload: true,
  allow_javascript: true,
  allow_form_submission: true,
  delay_between_actions_ms: 500,
  max_actions_per_minute: 60,
  block_financial_sites: true,
  block_government_sites: false,
  warn_on_password_fields: true,
  screenshot_sensitive_pages: true,
}

let currentSecurityPolicy: SecurityPolicy = { ...defaultSecurityPolicy }
let rateLimiter = new RateLimiter(
  defaultSecurityPolicy.max_actions_per_minute!,
  defaultSecurityPolicy.delay_between_actions_ms!
)

async function updateSecurityPolicy(policy: SecurityPolicy): Promise<void> {
  currentSecurityPolicy = { ...currentSecurityPolicy, ...policy }
  rateLimiter = new RateLimiter(
    currentSecurityPolicy.max_actions_per_minute || 60,
    currentSecurityPolicy.delay_between_actions_ms || 500
  )
}

let chromeReadyAtStartup = false
let startupError: string | null = null
const recordingCallbacks = new Map<WebSocket, (action: BrowserAction) => void>()

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.url === '/status' && req.method === 'GET') {
    const status = getBrowserStatus()
    const chromeCheck = await checkChromeAvailability()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        status: 'ok',
        version: '1.0.0',
        chrome_ready: status.ready,
        chrome_error: status.error || startupError || chromeCheck.error,
        chrome_path: status.path || chromeCheck.path,
        browser_path: BROWSER_PATH || chromeCheck.path || 'auto',
      })
    )
    return
  }

  if (req.url === '/config' && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', async () => {
      try {
        const config = JSON.parse(body) as WebBridgeConfig
        if (config.security_policy) {
          await updateSecurityPolicy(config.security_policy)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: 'Invalid config' }))
      }
    })
    return
  }

  if (req.url === '/search' && req.method === 'POST') {
    const body = await parseJsonBody(req)
    const query = typeof body.query === 'string' ? body.query : ''
    const top_n = typeof body.top_n === 'number' ? body.top_n : 10
    const response = await withBrowserLock(() => performSearch(query, top_n))
    res.writeHead(response.success ? 200 : 500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(response))
    return
  }

  if (req.url === '/fetch' && req.method === 'POST') {
    const body = await parseJsonBody(req)
    const response = await withBrowserLock(() =>
      performFetch({
        url: typeof body.url === 'string' ? body.url : '',
        selector: typeof body.selector === 'string' ? body.selector : undefined,
        mode: body.mode === 'html' ? 'html' : 'text',
        maxLength: typeof body.maxLength === 'number' ? body.maxLength : 200000,
      })
    )
    res.writeHead(response.success ? 200 : 500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(response))
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ status: 'not_found' }))
})

function parseJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}') as Record<string, unknown>)
      } catch {
        resolve({})
      }
    })
  })
}

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws: WebSocket) => {
  console.log('WebBridge client connected')

  ws.on('message', async (rawData) => {
    const request = parseRequest(rawData.toString())
    if (!request) {
      sendResponse(ws, {
        id: 'unknown',
        type: 'error',
        success: false,
        error: 'Invalid JSON',
      })
      return
    }

    if (request.type === 'ping') {
      sendResponse(ws, createResponse(request, true))
      return
    }

    if (request.type === 'action' && isActionPayload(request.payload)) {
      const action = request.payload as BrowserAction
      const check = checkSecurityPolicy(action, currentSecurityPolicy, getPageStateSafeUrl())
      if (!check.allowed) {
        sendResponse(
          ws,
          createResponse(request, false, undefined, check.reason || 'Security check failed')
        )
        return
      }

      try {
        const result = await withBrowserLock(async () => {
          await rateLimiter.throttle()
          const client = await ensureBrowser({
            browserPath: BROWSER_PATH,
            headless: HEADLESS,
          })
          const actionResult = await executeAction(client, action)
          // 实况缩略帧：每个改变画面的动作成功后附一张低质量 JPEG，
          // 供前端"浏览器舞台"实时观赏。可用 WEBBRIDGE_LIVE_THUMB=false 关闭。
          if (
            LIVE_THUMB &&
            actionResult.success &&
            !NO_THUMB_ACTIONS.has(action.action_type)
          ) {
            try {
              actionResult.screenshot_thumb = await captureScreenshot(client, 'jpeg', LIVE_THUMB_QUALITY)
            } catch {
              // 缩略帧失败不影响动作结果
            }
          }
          return actionResult
        })
        sendResponse(ws, createResponse(request, result.success, result, result.error_message))
      } catch (err) {
        sendResponse(
          ws,
          createResponse(request, false, undefined, err instanceof Error ? err.message : 'Action failed')
        )
      }
      return
    }

    if (request.type === 'workflow') {
      sendResponse(
        ws,
        createResponse(request, false, undefined, 'Workflow execution not yet supported by daemon')
      )
      return
    }

    if (request.type === 'config' && isSecurityPolicyPayload(request.payload)) {
      await updateSecurityPolicy(request.payload as SecurityPolicy)
      sendResponse(ws, createResponse(request, true))
      return
    }

    if (request.type === 'start_recording') {
      try {
        const client = await ensureBrowser({
          browserPath: BROWSER_PATH,
          headless: HEADLESS,
        })
        recordingCallbacks.set(ws, (action: BrowserAction) => {
          sendResponse(ws, createRecordedActionResponse(action))
        })
        await startRecording(client, {
          onAction: (action: BrowserAction) => {
            const cb = recordingCallbacks.get(ws)
            if (cb) cb(action)
          },
        })
        sendResponse(ws, createResponse(request, true, { recording: true }))
      } catch (err) {
        sendResponse(
          ws,
          createResponse(request, false, undefined, err instanceof Error ? err.message : 'Start recording failed')
        )
      }
      return
    }

    if (request.type === 'stop_recording') {
      stopRecording()
      recordingCallbacks.delete(ws)
      sendResponse(ws, createResponse(request, true, { recording: false }))
      return
    }

    // ── 接管模式：实时画面推流 + 用户输入转发 ──
    if (request.type === 'start_screencast') {
      try {
        const client = await ensureBrowser({ browserPath: BROWSER_PATH, headless: HEADLESS })
        await startScreencast(client, (frame) => {
          sendResponse(ws, {
            id: 'screencast',
            type: 'screencast_frame',
            success: true,
            payload: { data: frame },
          })
        })
        sendResponse(ws, createResponse(request, true, { screencast: true }))
      } catch (err) {
        sendResponse(ws, createResponse(request, false, undefined, err instanceof Error ? err.message : 'Start screencast failed'))
      }
      return
    }

    if (request.type === 'stop_screencast') {
      try {
        const client = await ensureBrowser({ browserPath: BROWSER_PATH, headless: HEADLESS })
        await stopScreencast(client)
      } catch {
        // 忽略
      }
      sendResponse(ws, createResponse(request, true, { screencast: false }))
      return
    }

    if (request.type === 'input_event') {
      try {
        const event = request.payload as StageInputEvent
        if (!event || typeof event.kind !== 'string') {
          sendResponse(ws, createResponse(request, false, undefined, 'Invalid input_event payload'))
          return
        }
        await withBrowserLock(async () => {
          const client = await ensureBrowser({ browserPath: BROWSER_PATH, headless: HEADLESS })
          await dispatchStageInput(client, event)
        })
        sendResponse(ws, createResponse(request, true))
      } catch (err) {
        sendResponse(ws, createResponse(request, false, undefined, err instanceof Error ? err.message : 'Input event failed'))
      }
      return
    }

    if (request.type === 'resolve_selector') {
      try {
        const payload = request.payload as { x?: number; y?: number }
        const x = typeof payload?.x === 'number' ? payload.x : 0
        const y = typeof payload?.y === 'number' ? payload.y : 0
        const client = await ensureBrowser({
          browserPath: BROWSER_PATH,
          headless: HEADLESS,
        })
        const selector = await resolveSelectorAtPoint(client, x, y)
        sendResponse(ws, createSelectorResolvedResponse(request, selector))
      } catch (err) {
        sendResponse(
          ws,
          createResponse(request, false, undefined, err instanceof Error ? err.message : 'Resolve selector failed')
        )
      }
      return
    }

    if (request.type === 'list_workspace_files') {
      try {
        const payload = isWorkspaceListPayload(request.payload) ? request.payload : {}
        const subdir = payload.subdir as WorkspaceSubdir | undefined
        const files = subdir ? await listFiles(subdir) : await listAllWorkspaceFiles()
        sendResponse(ws, createWorkspaceFilesResponse(request, files))
      } catch (err) {
        sendResponse(
          ws,
          createResponse(request, false, undefined, err instanceof Error ? err.message : 'List workspace files failed')
        )
      }
      return
    }

    if (request.type === 'delete_workspace_file') {
      try {
        const payload = isWorkspaceFilePayload(request.payload) ? request.payload : null
        if (!payload?.relativePath) {
          sendResponse(ws, createResponse(request, false, undefined, 'relativePath is required'))
          return
        }
        await deleteWorkspaceFile(payload.relativePath)
        sendResponse(ws, createResponse(request, true))
      } catch (err) {
        sendResponse(
          ws,
          createResponse(request, false, undefined, err instanceof Error ? err.message : 'Delete workspace file failed')
        )
      }
      return
    }

    if (request.type === 'read_workspace_file') {
      try {
        const payload = isWorkspaceFilePayload(request.payload) ? request.payload : null
        if (!payload?.relativePath) {
          sendResponse(ws, createResponse(request, false, undefined, 'relativePath is required'))
          return
        }
        const base64 = await readFileAsBase64(payload.relativePath)
        sendResponse(ws, createWorkspaceFileContentResponse(request, payload.relativePath, base64))
      } catch (err) {
        sendResponse(
          ws,
          createResponse(request, false, undefined, err instanceof Error ? err.message : 'Read workspace file failed')
        )
      }
      return
    }

    if (request.type === 'write_workspace_file') {
      try {
        const payload = isWriteWorkspaceFilePayload(request.payload) ? request.payload : null
        if (!payload?.relativePath || !payload?.base64) {
          sendResponse(ws, createResponse(request, false, undefined, 'relativePath and base64 are required'))
          return
        }
        const result = await saveFileFromBase64(payload.relativePath, payload.base64)
        sendResponse(ws, createWorkspaceFileSavedResponse(request, result.relativePath, result.size))
      } catch (err) {
        sendResponse(
          ws,
          createResponse(request, false, undefined, err instanceof Error ? err.message : 'Write workspace file failed')
        )
      }
      return
    }
  })

  ws.on('close', () => {
    console.log('WebBridge client disconnected')
    // screencast 帧回调随连接失效，防止向死连接推流
    void ensureBrowser({ browserPath: BROWSER_PATH, headless: HEADLESS })
      .then((client) => stopScreencast(client))
      .catch(() => undefined)
  })
})

function getPageStateSafeUrl(): string {
  try {
    return ''
  } catch {
    return ''
  }
}

async function runStartupCheck(): Promise<void> {
  const availability = await checkChromeAvailability()
  if (!availability.available) {
    startupError = availability.error || '未检测到浏览器'
    console.error('Startup check failed:', startupError)
    return
  }

  console.log(`Detected browser: ${availability.path}`)

  try {
    const client = await ensureBrowser({
      browserPath: BROWSER_PATH,
      headless: HEADLESS,
    })
    const state = await getPageState(client)
    chromeReadyAtStartup = true
    console.log('Chrome launched successfully:', state.url)
  } catch (err) {
    startupError = err instanceof Error ? err.message : String(err)
    chromeReadyAtStartup = false
    console.error('Failed to launch Chrome:', startupError)
    console.error('Set WEBBRIDGE_BROWSER_PATH to override Chrome detection')
  }
}

async function main(): Promise<void> {
  await ensureWorkspace()
  await runStartupCheck()

  // 父进程监护：launcher（WonWorkLauncher.ps1）窗口被用户关闭时，PowerShell 进程被
  // 直接终止、finally 清理不会执行，daemon 会成孤儿并持续锁占 daemon\node.exe，
  // 导致覆盖安装失败（DeleteFile failed; code 5）。
  // launcher 通过 WONWORK_PARENT_PID 注入自己的 PID；父进程消失即自行退出。
  const parentPid = Number(process.env.WONWORK_PARENT_PID)
  if (parentPid > 0) {
    let exiting = false
    setInterval(() => {
      if (exiting) return
      try {
        process.kill(parentPid, 0) // 信号 0：仅探测存在性，不真正发信号
      } catch {
        exiting = true
        console.log('Parent process gone, shutting down WebBridge daemon...')
        void closeBrowser().finally(() => process.exit(0))
      }
    }, 5000).unref()
  }

  server.listen(PORT, () => {
    console.log(`WebBridge daemon listening on port ${PORT}`)
    console.log(`Status endpoint: http://localhost:${PORT}/status`)
    if (!chromeReadyAtStartup) {
      console.warn(`WARNING: Chrome not ready. ${startupError || ''}`)
    }
  })
}

main()

process.on('SIGINT', async () => {
  console.log('Shutting down WebBridge daemon...')
  await closeBrowser()
  server.close(() => process.exit(0))
})

process.on('SIGTERM', async () => {
  await closeBrowser()
  server.close(() => process.exit(0))
})
