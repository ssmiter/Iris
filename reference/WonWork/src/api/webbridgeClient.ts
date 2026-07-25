import type {
  WebBridgeRequest,
  WebBridgeResponse,
  BrowserAction,
  ActionResult,
  PageState,
  ConnectionStatus,
  ElementSelector,
  WorkspaceFileInfo,
  StageInputEvent,
} from '@/types/webbridge'

export interface StatusInfo {
  status: string
  version?: string
  chrome_ready?: boolean
  chrome_error?: string
  browser_path?: string
}

export interface WebBridgeClientOptions {
  onMessage?: (response: WebBridgeResponse) => void
  onStatusChange?: (status: ConnectionStatus) => void
  onRecordedAction?: (action: BrowserAction) => void
  /** 接管模式：screencast 帧（base64 JPEG） */
  onScreencastFrame?: (base64Jpeg: string) => void
}

let requestIdCounter = 0

function generateRequestId(): string {
  requestIdCounter += 1
  return `ww-${Date.now()}-${requestIdCounter}`
}

function createMockPageState(overrides?: Partial<PageState>): PageState {
  return {
    url: 'https://example.com',
    title: 'Mock Page',
    viewport_width: 1280,
    viewport_height: 720,
    scroll_x: 0,
    scroll_y: 0,
    page_height: 1080,
    ready_state: 'complete',
    visible_text: 'This is a mock page used for UI development when no daemon is running.',
    tab_id: 'mock-tab',
    tab_index: 1,
    total_tabs: 1,
    ...overrides,
  }
}

function createMockActionResult(action: BrowserAction, success = true, overrides?: Partial<ActionResult>): ActionResult {
  const base: ActionResult = {
    action,
    success,
    execution_time_ms: Math.floor(Math.random() * 300) + 50,
    page_state_after: createMockPageState(),
    ...overrides,
  }

  switch (action.action_type) {
    case 'navigate':
      base.data = { url: action.value || 'https://example.com' }
      base.page_state_after = createMockPageState({
        url: action.value || 'https://example.com',
        title: `Mock: ${action.value || 'example.com'}`,
      })
      break
    case 'get_url':
      base.data = 'https://example.com'
      break
    case 'get_title':
      base.data = 'Mock Page'
      break
    case 'extract_text':
      base.data = 'Mock extracted text content for development.'
      break
    case 'extract_table':
      base.data = [{ col1: 'a', col2: '1' }, { col1: 'b', col2: '2' }]
      break
    case 'extract_html':
      base.data = '<html><body><h1>Mock</h1></body></html>'
      break
    case 'screenshot':
      base.data =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
      break
    case 'click':
    case 'type':
    case 'clear':
    case 'select':
    case 'check':
      base.data = { selector: action.selector?.value }
      break
    case 'evaluate':
      base.data = { result: 'mock-eval-result' }
      break
    case 'scroll':
    case 'scroll_to':
    case 'scroll_to_top':
    case 'scroll_to_bottom':
      base.data = { scroll_y: 300 }
      base.page_state_after = createMockPageState({ scroll_y: 300 })
      break
    case 'wait':
      base.data = { waited_ms: action.delay_ms || 1000 }
      break
    case 'wait_for_element':
      base.data = { found: true }
      break
    case 'download':
      base.data = { path: 'C:\\Downloads\\mock-file.pdf' }
      break
    case 'save_page':
      base.data = { path: 'C:\\Downloads\\mock-page.html' }
      break
    default:
      base.data = null
  }

  return base
}

export class WebBridgeClient {
  private ws: WebSocket | null = null
  private url = ''
  private options: WebBridgeClientOptions = {}
  private pendingRequests = new Map<string, { resolve: (value: unknown) => void; reject: (reason?: Error) => void }>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelayMs = 2000
  private status: ConnectionStatus = 'disconnected'
  private mock = false
  /** screencast 帧处理器：可在连接后动态挂/摘（HMR 或晚于 connect 的订阅场景） */
  private screencastHandler: ((base64Jpeg: string) => void) | null = null

  /** 连接后动态设置/清除 screencast 帧处理器（null 表示摘除） */
  setScreencastHandler(cb: ((base64Jpeg: string) => void) | null): void {
    this.screencastHandler = cb
  }

  get connectionStatus(): ConnectionStatus {
    return this.status
  }

  get isConnected(): boolean {
    return this.status === 'connected'
  }

  get isMock(): boolean {
    return this.mock
  }

  connect(url: string, options?: WebBridgeClientOptions): void {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return
    }

    this.url = url
    this.options = options || {}
    this.mock = url === 'mock://localhost' || url.startsWith('mock:')

    if (this.mock) {
      this.setStatus('connected')
      this.options.onStatusChange?.('connected')
      return
    }

    this.setStatus('connecting')

    try {
      this.ws = new WebSocket(url)

      this.ws.onopen = () => {
        this.reconnectAttempts = 0
        this.setStatus('connected')
        this.options.onStatusChange?.('connected')
      }

      this.ws.onmessage = (event) => {
        try {
          const response: WebBridgeResponse = JSON.parse(event.data)
          this.handleResponse(response)
        } catch {
          // ignore malformed messages
        }
      }

      this.ws.onerror = () => {
        this.setStatus('error')
        this.options.onStatusChange?.('error')
      }

      this.ws.onclose = () => {
        this.setStatus('disconnected')
        this.options.onStatusChange?.('disconnected')
        this.scheduleReconnect()
      }
    } catch {
      this.setStatus('error')
      this.options.onStatusChange?.('error')
      this.scheduleReconnect()
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempts = this.maxReconnectAttempts + 1

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    if (this.mock) {
      this.mock = false
    }

    this.setStatus('disconnected')
  }

  get httpBaseUrl(): string {
    if (this.mock) {
      return ''
    }
    return this.url.replace(/^ws/, 'http').replace(/\/ws$/, '')
  }

  async checkStatus(): Promise<StatusInfo> {
    if (this.mock) {
      return {
        status: 'ok',
        version: 'mock-1.0.0',
        chrome_ready: true,
      }
    }

    try {
      const response = await fetch(`${this.httpBaseUrl}/status`, { method: 'GET', credentials: 'omit' })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      return (await response.json()) as StatusInfo
    } catch (err) {
      throw err instanceof Error ? err : new Error('Failed to check daemon status')
    }
  }

  async httpPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    if (this.mock) {
      throw new Error('HTTP API is not available in mock mode')
    }

    const response = await fetch(`${this.httpBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      signal,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status}: ${text}`)
    }

    return (await response.json()) as T
  }

  send<T>(message: Omit<WebBridgeRequest, 'id'> & { id?: string }): Promise<T> {
    const id = message.id || generateRequestId()
    const fullMessage: WebBridgeRequest = { ...message, id } as WebBridgeRequest

    if (this.mock) {
      return this.sendMock<T>(fullMessage)
    }

    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'))
        return
      }

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error('Request timeout'))
      }, 30000)

      this.pendingRequests.set(id, {
        resolve: (value: unknown) => {
          clearTimeout(timeout)
          resolve(value as T)
        },
        reject: (reason?: Error) => {
          clearTimeout(timeout)
          reject(reason)
        },
      })

      this.ws.send(JSON.stringify(fullMessage))
    })
  }

  async startRecording(): Promise<{ success: boolean; error?: string }> {
    if (this.mock) return { success: true }
    return this.send<{ success: boolean; error?: string }>({ type: 'start_recording' })
  }

  async stopRecording(): Promise<{ success: boolean; error?: string }> {
    if (this.mock) return { success: true }
    return this.send<{ success: boolean; error?: string }>({ type: 'stop_recording' })
  }

  /** 接管模式：启动实时画面推流（帧经 onScreencastFrame 回调） */
  async startScreencast(): Promise<{ success: boolean; error?: string }> {
    if (this.mock) return { success: true }
    return this.send<{ success: boolean; error?: string }>({ type: 'start_screencast' })
  }

  async stopScreencast(): Promise<{ success: boolean; error?: string }> {
    if (this.mock) return { success: true }
    return this.send<{ success: boolean; error?: string }>({ type: 'stop_screencast' })
  }

  /** 接管模式：转发用户输入到真实浏览器（点击/滚动/文本/按键） */
  async sendInputEvent(event: StageInputEvent): Promise<{ success: boolean; error?: string }> {
    if (this.mock) return { success: true }
    return this.send<{ success: boolean; error?: string }>({ type: 'input_event', payload: event })
  }

  async resolveSelector(x: number, y: number): Promise<ElementSelector | null> {
    if (this.mock) {
      return { selector_type: 'css', value: 'body', timeout_ms: 5000 }
    }
    return this.send<ElementSelector | null>({ type: 'resolve_selector', payload: { x, y } })
  }

  async listWorkspaceFiles(subdir?: string): Promise<WorkspaceFileInfo[]> {
    if (this.mock) {
      return []
    }
    return this.send<WorkspaceFileInfo[]>({ type: 'list_workspace_files', payload: { subdir } })
  }

  async deleteWorkspaceFile(relativePath: string): Promise<{ success: boolean }> {
    if (this.mock) {
      return { success: true }
    }
    return this.send<{ success: boolean }>({ type: 'delete_workspace_file', payload: { relativePath } })
  }

  async readWorkspaceFile(relativePath: string): Promise<{ relativePath: string; base64: string }> {
    if (this.mock) {
      return { relativePath, base64: '' }
    }
    return this.send<{ relativePath: string; base64: string }>({ type: 'read_workspace_file', payload: { relativePath } })
  }

  async writeWorkspaceFile(relativePath: string, base64: string): Promise<{ relativePath: string; size: number }> {
    if (this.mock) {
      return { relativePath, size: 0 }
    }
    return this.send<{ relativePath: string; size: number }>({
      type: 'write_workspace_file',
      payload: { relativePath, base64 },
    })
  }

  private sendMock<T>(message: WebBridgeRequest): Promise<T> {
    return new Promise<T>((resolve) => {
      setTimeout(() => {
        if (message.type === 'action') {
          const action = message.payload as BrowserAction
          const result = createMockActionResult(action)
          const response: WebBridgeResponse = {
            id: message.id,
            type: 'action_result',
            success: true,
            payload: result,
          }
          this.options.onMessage?.(response)
          resolve(result as T)
        } else if (message.type === 'workflow') {
          const response: WebBridgeResponse = {
            id: message.id,
            type: 'workflow_result',
            success: true,
            payload: { completed: true },
          }
          this.options.onMessage?.(response)
          resolve(response.payload as T)
        } else {
          const response: WebBridgeResponse = {
            id: message.id,
            type: 'pong',
            success: true,
          }
          this.options.onMessage?.(response)
          resolve(undefined as T)
        }
      }, 300)
    })
  }

  private handleResponse(response: WebBridgeResponse): void {
    if (response.type === 'recorded_action' && response.payload) {
      this.options.onRecordedAction?.(response.payload as BrowserAction)
      return
    }
    // screencast 帧是推送消息（无 pending 请求），直接回调
    if (response.type === 'screencast_frame' && response.payload) {
      const data = (response.payload as { data?: string }).data
      if (typeof data === 'string') (this.screencastHandler || this.options.onScreencastFrame)?.(data)
      return
    }
    if (response.type === 'selector_resolved') {
      const pending = this.pendingRequests.get(response.id)
      if (pending) {
        this.pendingRequests.delete(response.id)
        pending.resolve(response.payload)
      }
      this.options.onMessage?.(response)
      return
    }
    const pending = this.pendingRequests.get(response.id)
    if (pending) {
      this.pendingRequests.delete(response.id)
      if (response.success) {
        pending.resolve(response.payload)
      } else {
        const err = new Error(response.error || 'Unknown error') as Error & { reason?: string; details?: string }
        if (response.error_reason) err.reason = response.error_reason
        if (response.error_details) err.details = response.error_details
        pending.reject(err)
      }
    }
    this.options.onMessage?.(response)
  }

  private scheduleReconnect(): void {
    if (this.mock) return
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return
    if (this.reconnectTimer) return

    this.reconnectAttempts += 1
    this.setStatus('reconnecting')
    this.options.onStatusChange?.('reconnecting')

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect(this.url, this.options)
    }, this.reconnectDelayMs)
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status
  }
}

export const webBridgeClient = new WebBridgeClient()
