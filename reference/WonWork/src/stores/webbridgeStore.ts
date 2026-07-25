import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { webBridgeClient } from '@/api/webbridgeClient'
import { getDaemonLauncher } from '@/api/daemonLauncher'
import { useUsageStore, buildTodayUsageRecord } from '@/stores/usageStore'
import { buildWebBridgeResultSummary } from '@/utils/webbridgePrompt'
import { startWorkflowRunChatThread } from '@/utils/workflowRunToChat'
import { buildExampleWorkflows, EXAMPLE_WORKFLOW_TAG } from '@/components/WebBridge/WorkflowTemplates'
import {
  createDefaultWebBridgeConfig,
  loadWebBridgePreset,
  type WebBridgeConfig,
  type SecurityPolicy,
  type BrowserAction,
  type ActionResult,
  type PageState,
  type WorkflowDefinition,
  type WorkflowStep,
  type WebBridgeLogEntry,
  type ConnectionStatus,
  type ActionType,
  type ErrorHandlingMode,
  type ElementSelector,
  type WebBridgeExecutionOptions,
  type WorkspaceFileInfo,
  type StageInputEvent,
} from '@/types/webbridge'

let logIdCounter = 0

function generateLogId(): string {
  logIdCounter += 1
  return `log-${Date.now()}-${logIdCounter}`
}

function generateId(prefix = 'id'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

// ── 接管暂停门（共驾）──
// sendAction 在派发前等待此门：用户点「接管」→ pauseRequested=true，AI 在动作间隙停下；
// 点「交还 AI」→ 释放所有等待者。等待只发生在动作边界，保证控制权交接是原子的。
const pauseResolvers: Array<() => void> = []
/** 接管开始时的页面快照（URL + 标题），交还时对比生成接管记录 */
let takeoverStartPage: { url: string; title: string; at: number } | null = null

function releasePauseGate(): void {
  const rs = pauseResolvers.splice(0)
  for (const r of rs) r()
}

// screencast 帧节流（150ms）：最新帧始终保留，避免掉帧累积
let lastScreencastWriteAt = 0
let pendingScreencastFrame: string | null = null
let screencastFlushTimer: ReturnType<typeof setTimeout> | null = null

/** 统一的 screencast 帧入口（节流后写入 store），connect 选项与接管动态挂载共用 */
function makeScreencastFrameHandler(set: (partial: Partial<WebBridgeState>) => void) {
  return (frame: string) => {
    const now = Date.now()
    if (now - lastScreencastWriteAt < 150) {
      pendingScreencastFrame = frame
      if (!screencastFlushTimer) {
        screencastFlushTimer = setTimeout(() => {
          screencastFlushTimer = null
          if (pendingScreencastFrame) {
            set({ currentScreenshot: pendingScreencastFrame, currentScreenshotMime: 'jpeg' })
            pendingScreencastFrame = null
          }
          lastScreencastWriteAt = Date.now()
        }, 150)
      }
      return
    }
    lastScreencastWriteAt = now
    set({ currentScreenshot: frame, currentScreenshotMime: 'jpeg' })
  }
}

function ensureExplorationStep(steps: WorkflowStep[]): WorkflowStep[] {
  const interactiveTypes: ActionType[] = [
    'click', 'double_click', 'right_click', 'hover',
    'type', 'clear', 'select', 'check', 'upload', 'evaluate',
  ]
  const explorationTypes: ActionType[] = ['screenshot', 'extract_text', 'extract_html', 'extract_table']

  let firstInteractiveStepIndex = -1
  let firstInteractiveActionIndex = -1
  for (let i = 0; i < steps.length; i++) {
    const actions = steps[i].actions || []
    for (let j = 0; j < actions.length; j++) {
      if (interactiveTypes.includes(actions[j].action_type)) {
        firstInteractiveStepIndex = i
        firstInteractiveActionIndex = j
        break
      }
    }
    if (firstInteractiveStepIndex !== -1) break
  }

  if (firstInteractiveStepIndex === -1) return steps

  // Check if there's any exploration action before the first interactive action
  for (let i = 0; i <= firstInteractiveStepIndex; i++) {
    const actions = steps[i].actions || []
    const limit = i === firstInteractiveStepIndex ? firstInteractiveActionIndex : actions.length
    for (let j = 0; j < limit; j++) {
      if (explorationTypes.includes(actions[j].action_type)) {
        return steps
      }
    }
  }

  // Insert exploration after the first navigate, or as a new first step
  const firstStep = steps[0]
  const firstActions = firstStep?.actions || []
  const navigateIndex = firstActions.findIndex((a: BrowserAction) => a.action_type === 'navigate')
  const exploreActions: BrowserAction[] = [
    { action_type: 'screenshot' },
    { action_type: 'extract_text' },
  ]

  if (navigateIndex !== -1) {
    const newActions = [
      ...firstActions.slice(0, navigateIndex + 1),
      ...exploreActions,
      ...firstActions.slice(navigateIndex + 1),
    ]
    return [{ ...firstStep, actions: newActions }, ...steps.slice(1)]
  }

  // Find any navigate action to reuse URL
  const navigateAction = firstActions.find((a: BrowserAction) => a.action_type === 'navigate')
  const exploreStep: WorkflowStep = {
    step_id: `explore-${generateId()}`,
    description: '探索页面结构（自动插入）',
    actions: navigateAction ? [navigateAction, ...exploreActions] : exploreActions,
    on_error: 'stop',
  }
  return [exploreStep, ...steps]
}

interface WebBridgeState {
  // Connection
  status: ConnectionStatus
  host: string
  port: number
  useMock: boolean
  error: string | null
  lastStatusInfo: { chrome_ready?: boolean; chrome_error?: string; version?: string } | null

  // Daemon auto-start
  autoStartEnabled: boolean
  isStartingDaemon: boolean
  daemonPath: string | null

  // Config
  config: WebBridgeConfig
  securityPolicy: SecurityPolicy

  // Runtime
  pageState: PageState | null
  currentScreenshot: string | null
  /** 当前实况帧的 MIME（截图动作=png，daemon 缩略帧=jpeg） */
  currentScreenshotMime: 'png' | 'jpeg'
  logs: WebBridgeLogEntry[]
  isExecuting: boolean
  currentWorkflowId: string | null
  currentWorkflowStepIndex: number
  abortExecution: boolean
  lastFailure: { action?: BrowserAction; error?: string; screenshot?: string; timestamp: number } | null

  // 接管（共驾）：用户暂停 AI 亲自操作浏览器，交还时把期间变化回喂模型
  pauseRequested: boolean
  takeoverNotes: string[]
  requestTakeover: () => void
  handbackToAI: () => void
  /** 接管模式：把用户在舞台画面上的输入（点击/滚动/文本/按键）转发给真实浏览器 */
  sendStageInput: (event: StageInputEvent) => void

  // Workflows
  workflows: WorkflowDefinition[]

  // Recording
  isRecording: boolean
  recordedActions: BrowserAction[]

  // Workspace
  workspaceFiles: WorkspaceFileInfo[]
  workspaceLoading: boolean
  workspaceError: string | null

  // Actions
  connect: () => void
  disconnect: () => void
  checkStatus: () => Promise<void>
  setHost: (host: string) => void
  setPort: (port: number) => void
  setUseMock: (useMock: boolean) => void
  setAutoStartEnabled: (enabled: boolean) => void
  setDaemonPath: (path: string | null) => void
  ensureDaemon: () => Promise<{ success: boolean; started?: boolean; error?: string }>
  tryAutoConnect: (silent?: boolean) => Promise<{ success: boolean; error?: string }>
  startDaemon: () => Promise<{ success: boolean; error?: string }>
  startRecording: () => Promise<void>
  stopRecording: () => Promise<void>
  clearRecordedActions: () => void
  removeRecordedAction: (index: number) => void
  reorderRecordedActions: (from: number, to: number) => void
  listWorkspaceFiles: (subdir?: string) => Promise<WorkspaceFileInfo[]>
  deleteWorkspaceFile: (relativePath: string) => Promise<void>
  readWorkspaceFile: (relativePath: string) => Promise<{ relativePath: string; base64: string }>
  refreshWorkspace: () => Promise<void>
  sendAction: (action: BrowserAction, policyOverride?: SecurityPolicy) => Promise<ActionResult | null>
  runActionsOnce: (actions: BrowserAction[], policyOverride?: SecurityPolicy) => Promise<ActionResult[]>
  setSecurityPolicy: (policy: Partial<SecurityPolicy>) => void
  setLastFailure: (failure: WebBridgeState['lastFailure']) => void
  clearLastFailure: () => void
  loadPreset: (name: string) => void

  createWorkflow: (workflow: Omit<WorkflowDefinition, 'id'>) => WorkflowDefinition
  updateWorkflow: (id: string, updates: Partial<WorkflowDefinition>) => void
  deleteWorkflow: (id: string) => void
  duplicateWorkflow: (id: string) => WorkflowDefinition | null
  renameWorkflow: (id: string, name: string) => void
  getWorkflowByName: (name: string) => WorkflowDefinition | undefined
  getWorkflows: () => WorkflowDefinition[]
  ensureExampleWorkflows: () => void
  runWorkflow: (workflowId: string, options?: { onNavigateToChat?: () => void }) => Promise<void>
  stopWorkflow: () => void

  clearLogs: () => void
  addLog: (entry: Omit<WebBridgeLogEntry, 'id' | 'timestamp'>) => void

  executeFromNaturalLanguage: (text: string) => Promise<string>
  executeWorkflowFromJson: (
    json: unknown,
    options?: WebBridgeExecutionOptions
  ) => Promise<{ workflow: WorkflowDefinition; results: ActionResult[]; summary: string }>
  capturePageContext: () => Promise<{ url: string; title: string; text?: string; screenshot?: string }>
  captureScreenshot: () => Promise<string | undefined>
}

function buildWsUrl(host: string, port: number): string {
  return `ws://${host}:${port}/ws`
}

function checkSecurityPolicy(action: BrowserAction, policy: SecurityPolicy): string | null {
  if (policy.security_level === 'read_only') {
    const interactiveActions: ActionType[] = [
      'click',
      'double_click',
      'right_click',
      'hover',
      'type',
      'clear',
      'select',
      'check',
      'upload',
      'new_tab',
      'switch_tab',
      'close_tab',
      'evaluate',
      'export_table',
    ]
    if (interactiveActions.includes(action.action_type)) {
      return `Action "${action.action_type}" is not allowed in read_only security level`
    }
  }

  if (action.action_type === 'upload' && policy.allow_file_upload === false) {
    return 'File upload is disabled by security policy'
  }

  if (action.action_type === 'download' && policy.allow_file_download === false) {
    return 'File download is disabled by security policy'
  }

  if (action.action_type === 'evaluate' && policy.allow_javascript === false) {
    return 'JavaScript evaluation is disabled by security policy'
  }

  return null
}

function extractQuoted(text: string, index = 0): { value: string; rest: string } | null {
  const quotes = ["'", '"', '“', '”', '‘', '’', '「', '」', '《', '》']
  let quote = ''
  let start = -1
  let i = index
  while (i < text.length) {
    if (quotes.includes(text[i])) {
      quote = text[i]
      start = i + 1
      break
    }
    i += 1
  }
  if (start === -1) return null
  const closeQuote = quote === '“' ? '”' : quote === '‘' ? '’' : quote === '「' ? '」' : quote === '《' ? '》' : quote
  const end = text.indexOf(closeQuote, start)
  if (end === -1) return null
  return { value: text.slice(start, end).trim(), rest: text.slice(end + 1).trim() }
}

function extractSelector(text: string): ElementSelector | undefined {
  // Quoted selector: "name", 'name', “name”, etc.
  const quoted = extractQuoted(text)
  if (quoted) {
    const value = quoted.value
    if (value.startsWith('#')) return { selector_type: 'id', value: value.slice(1) }
    if (value.startsWith('.')) return { selector_type: 'class_name', value: value.slice(1) }
    if (value.startsWith('//')) return { selector_type: 'xpath', value }
    if (value.startsWith('[') || value.includes('>') || value.includes('=')) return { selector_type: 'css', value }
    return { selector_type: 'text_exact', value }
  }
  // CSS-like token: #id, .class, tag[name]
  const cssMatch = text.match(/(#\S+|\.\S+|[a-zA-Z][a-zA-Z0-9]*\[[^\]]+\])/)
  if (cssMatch) {
    const value = cssMatch[1]
    if (value.startsWith('#')) return { selector_type: 'id', value: value.slice(1) }
    if (value.startsWith('.')) return { selector_type: 'class_name', value: value.slice(1) }
    return { selector_type: 'css', value }
  }
  // Bare word fallback (last resort)
  const bareMatch = text.match(/(?:on|in|into|at|的|框|按钮|链接)?\s*["']?([^"'\s,，]+)/)
  if (bareMatch && bareMatch[1].length > 0 && !/^(the|a|an|这个|那个)$/.test(bareMatch[1])) {
    return { selector_type: 'text_exact', value: bareMatch[1] }
  }
  return undefined
}

function inferActionFromText(text: string): BrowserAction | null {
  const lower = text.toLowerCase()
  const trimmed = text.trim()

  // Navigate / 打开网页 / 访问
  if (/\b(navigate|go to|open|visit|browse)\b/.test(lower) || /(?:打开|访问|导航到|前往|浏览)\s*网页?/.test(trimmed)) {
    const urlMatch = trimmed.match(/(?:https?:\/\/)?[^\s，,]+\.[^\s，,]+/)
    return {
      action_type: 'navigate',
      value: urlMatch ? (urlMatch[0].startsWith('http') ? urlMatch[0] : `https://${urlMatch[0]}`) : 'https://example.com',
    }
  }

  // Click / 点击
  if (/\bclick\b/.test(lower) || /点击/.test(trimmed)) {
    const selector = extractSelector(trimmed.replace(/\bclick\b|点击/, '').trim())
    return {
      action_type: 'click',
      selector: selector || { selector_type: 'css', value: 'body' },
    }
  }

  // Type / 输入
  if (/\b(type|enter)\b/.test(lower) || /输入|填写/.test(trimmed)) {
    const valueQuoted = extractQuoted(trimmed)
    const value = valueQuoted?.value || ''
    const afterValue = valueQuoted?.rest || trimmed
    const selector = extractSelector(afterValue)
    return {
      action_type: 'type',
      value,
      selector: selector || { selector_type: 'css', value: 'input' },
    }
  }

  // Screenshot / 截图
  if (/\bscreenshot\b/.test(lower) || /截图|截屏/.test(trimmed)) {
    return { action_type: 'screenshot' }
  }

  // Extract text / 提取文本 / 提取页面内容
  if (/\b(extract|read)\s+(?:text|content|page)\b/.test(lower) || /提取文本|读取文本|提取页面内容/.test(trimmed)) {
    return { action_type: 'extract_text' }
  }

  // Extract table / 提取表格
  if (/\b(extract|read)\s+(?:table|tables)\b/.test(lower) || /提取表格|读取表格/.test(trimmed)) {
    return { action_type: 'extract_table' }
  }

  // Export table / 导出表格
  if (/\bexport\s+(?:table|tables|excel|csv)\b/.test(lower) || /导出表格|导出Excel|导出CSV|保存表格/.test(trimmed)) {
    const formatMatch = trimmed.match(/\b(xlsx|excel|csv)\b/i)
    return { action_type: 'export_table', value: formatMatch ? (formatMatch[1].toLowerCase() === 'excel' ? 'xlsx' : formatMatch[1].toLowerCase()) : 'csv' }
  }

  // Extract html / 提取 HTML
  if (/\b(extract|read)\s+(?:html|source)\b/.test(lower) || /提取HTML|提取 html|提取源码/.test(trimmed)) {
    return { action_type: 'extract_html' }
  }

  // Get URL / 获取网址
  if (/\b(get\s+url|current\s+url)\b/.test(lower) || /当前网址|当前URL|获取网址/.test(trimmed)) {
    return { action_type: 'get_url' }
  }

  // Get title / 获取标题
  if (/\b(get\s+title|current\s+title|page\s+title)\b/.test(lower) || /页面标题|当前标题|获取标题/.test(trimmed)) {
    return { action_type: 'get_title' }
  }

  // Wait / 等待
  const waitMatch = trimmed.match(/(?:wait|等待)\s+(?:(\d+)\s*(?:ms|毫秒)|(\d+)\s*(?:s|sec|sec|秒|秒钟))/i)
  if (waitMatch || /\bwait\b/.test(lower) || /^等待/.test(trimmed)) {
    const ms = waitMatch?.[1] ? parseInt(waitMatch[1], 10) : waitMatch?.[2] ? parseInt(waitMatch[2], 10) * 1000 : 1000
    return { action_type: 'wait', delay_ms: ms }
  }

  // Scroll / 滚动
  if (/\bscroll\b/.test(lower) || /滚动/.test(trimmed)) {
    if (/top|顶部|最上/.test(trimmed)) return { action_type: 'scroll_to_top' }
    if (/bottom|底部|最下/.test(trimmed)) return { action_type: 'scroll_to_bottom' }
    const amountMatch = trimmed.match(/(\d+)/)
    return { action_type: 'scroll', amount: amountMatch ? parseInt(amountMatch[1], 10) : 300 }
  }

  // Evaluate / 执行 JS
  if (/\bevaluate\b/.test(lower) || /执行JS|执行js|执行JavaScript|运行脚本/.test(trimmed)) {
    const codeQuoted = extractQuoted(trimmed)
    return { action_type: 'evaluate', value: codeQuoted?.value || '' }
  }

  // New tab / 新标签页
  if (/\bnew\s+tab\b/.test(lower) || /新标签页|新建标签/.test(trimmed)) {
    const urlMatch = trimmed.match(/(?:https?:\/\/)?[^\s，,]+\.[^\s，,]+/)
    return { action_type: 'new_tab', value: urlMatch ? urlMatch[0] : undefined }
  }

  // Refresh / 刷新
  if (/\brefresh\b/.test(lower) || /刷新页面|刷新网页/.test(trimmed)) {
    return { action_type: 'refresh' }
  }

  // Go back / 返回
  if (/\bgo\s+back\b/.test(lower) || /返回上一页|后退/.test(trimmed)) {
    return { action_type: 'go_back' }
  }

  return null
}

function splitCommandIntoSegments(text: string): string[] {
  // Split on common English/Chinese conjunctions and punctuation
  const separators = /(?:\s+(?:and|then|after that|next|随后|然后|接着|再|之后|下一步)\s+|\s*[,，;；]\s*)/i
  return text
    .split(separators)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function inferActionsFromText(text: string): BrowserAction[] {
  const segments = splitCommandIntoSegments(text)
  const actions: BrowserAction[] = []
  for (const segment of segments) {
    const action = inferActionFromText(segment)
    if (action) {
      actions.push({ ...action, description: segment })
    }
  }
  return actions
}

export const useWebBridgeStore = create<WebBridgeState>()(
  persist(
    (set, get) => ({
      status: 'disconnected',
      host: 'localhost',
      port: 9223,
      useMock: false,
      error: null,
      lastStatusInfo: null,

      autoStartEnabled: false,
      isStartingDaemon: false,
      daemonPath: null,

      config: createDefaultWebBridgeConfig(),
      securityPolicy: createDefaultWebBridgeConfig().security_policy!,

      pageState: null,
      currentScreenshot: null,
      currentScreenshotMime: 'png',
      logs: [],
      isExecuting: false,
      currentWorkflowId: null,
      currentWorkflowStepIndex: 0,
      abortExecution: false,
      lastFailure: null,

      pauseRequested: false,
      takeoverNotes: [],

      isRecording: false,
      recordedActions: [],

      workspaceFiles: [],
      workspaceLoading: false,
      workspaceError: null,

      workflows: [],

      connect: () => {
        const { host, port, useMock } = get()
        const url = useMock ? 'mock://localhost' : buildWsUrl(host, port)
        set({ status: 'connecting', error: null })

        webBridgeClient.connect(url, {
          onStatusChange: (status) => {
            set({ status })
          },
          onMessage: (response) => {
            if (response.type === 'page_state' && response.payload) {
              set({ pageState: response.payload as PageState })
            }
          },
          onRecordedAction: (action) => {
            set((state) => ({
              recordedActions: [...state.recordedActions, action],
            }))
          },
          onScreencastFrame: makeScreencastFrameHandler(set),
        })
      },

      disconnect: () => {
        webBridgeClient.disconnect()
        set({ status: 'disconnected', error: null })
        // 断线时若正处于接管暂停，必须释放暂停门，否则执行回路永久挂起
        if (get().pauseRequested) {
          set({ pauseRequested: false })
          releasePauseGate()
        }
      },

      checkStatus: async () => {
        try {
          const info = await webBridgeClient.checkStatus()
          set({
            lastStatusInfo: {
              chrome_ready: info.chrome_ready,
              chrome_error: info.chrome_error,
              version: info.version,
            },
            error: info.chrome_error || null,
          })
        } catch (err) {
          set({
            lastStatusInfo: { chrome_ready: false },
            error: err instanceof Error ? err.message : 'Status check failed',
          })
        }
      },

      setHost: (host) => set({ host }),
      setPort: (port) => set({ port }),
      setUseMock: (useMock) => set({ useMock }),

      setAutoStartEnabled: (autoStartEnabled) => set({ autoStartEnabled }),
      setDaemonPath: (daemonPath) => set({ daemonPath }),

      startRecording: async () => {
        if (!webBridgeClient.isConnected && !webBridgeClient.isMock) {
          throw new Error('WebBridge 未连接，无法开始录制')
        }
        set({ isRecording: true, error: null })
        try {
          await webBridgeClient.startRecording()
        } catch (err) {
          set({ isRecording: false })
          throw err
        }
      },

      stopRecording: async () => {
        set({ isRecording: false })
        if (webBridgeClient.isConnected || webBridgeClient.isMock) {
          await webBridgeClient.stopRecording()
        }
      },

      clearRecordedActions: () => set({ recordedActions: [] }),

      removeRecordedAction: (index) => set((state) => ({
        recordedActions: state.recordedActions.filter((_, i) => i !== index),
      })),

      reorderRecordedActions: (from, to) => set((state) => {
        const actions = [...state.recordedActions]
        if (from < 0 || from >= actions.length || to < 0 || to >= actions.length) return state
        const [moved] = actions.splice(from, 1)
        actions.splice(to, 0, moved)
        return { recordedActions: actions }
      }),

      listWorkspaceFiles: async (subdir) => {
        set({ workspaceLoading: true, workspaceError: null })
        try {
          const files = await webBridgeClient.listWorkspaceFiles(subdir)
          set({ workspaceFiles: files, workspaceLoading: false })
          return files
        } catch (err) {
          const error = err instanceof Error ? err.message : 'List workspace files failed'
          set({ workspaceError: error, workspaceLoading: false })
          throw err
        }
      },

      deleteWorkspaceFile: async (relativePath) => {
        await webBridgeClient.deleteWorkspaceFile(relativePath)
        await get().refreshWorkspace()
      },

      readWorkspaceFile: async (relativePath) => {
        return webBridgeClient.readWorkspaceFile(relativePath)
      },

      refreshWorkspace: async () => {
        await get().listWorkspaceFiles()
      },

      ensureDaemon: async () => {
        const { host, port, useMock, autoStartEnabled } = get()
        if (useMock) {
          return { success: true, started: false }
        }
        if (webBridgeClient.isConnected) {
          return { success: true, started: false }
        }

        set({ isStartingDaemon: true, error: null, status: 'starting' })
        try {
          const launcher = getDaemonLauncher()
          const status = await launcher.checkStatus(host, port)
          if (status.running) {
            get().connect()
            return { success: true, started: false }
          }

          if (!autoStartEnabled) {
            const error = '守护进程未运行，且自动启动已禁用。请手动启动或开启自动启动。'
            set({ error, status: 'disconnected' })
            return { success: false, started: false, error }
          }

          const startResult = await get().startDaemon()
          if (startResult.success) {
            get().connect()
          }
          return { ...startResult, started: startResult.success }
        } catch (err) {
          const error = err instanceof Error ? err.message : '检测或启动守护进程失败'
          set({ error, status: 'disconnected' })
          return { success: false, started: false, error }
        } finally {
          set({ isStartingDaemon: false })
        }
      },

      /**
       * 启动时静默探测守护进程：若已运行则自动连接，不运行时仅记录日志、不弹错误。
       * 用于安装包启动场景——Launcher 已在后台拉起 daemon，前端只需连上即可使用 WebBridge。
       */
      tryAutoConnect: async (silent = false) => {
        const { host, port, useMock } = get()
        if (useMock || webBridgeClient.isConnected) {
          return { success: true }
        }

        try {
          const launcher = getDaemonLauncher()
          const status = await launcher.checkStatus(host, port)
          if (status.running) {
            get().connect()
            return { success: true }
          }
          const error = status.error || 'WebBridge 守护进程未运行'
          if (!silent) {
            set({ error, status: 'disconnected' })
          }
          return { success: false, error }
        } catch (err) {
          const error = err instanceof Error ? err.message : '检测守护进程失败'
          if (!silent) {
            set({ error, status: 'disconnected' })
          }
          return { success: false, error }
        }
      },

      startDaemon: async () => {
        const { host, port, daemonPath } = get()
        set({ isStartingDaemon: true, error: null, status: 'starting' })
        try {
          const launcher = getDaemonLauncher()
          const result = await launcher.start({ host, port, daemonPath: daemonPath || undefined })
          if (!result.success) {
            set({ error: result.error || '启动守护进程失败', status: 'disconnected' })
          }
          return result
        } catch (err) {
          const error = err instanceof Error ? err.message : '启动守护进程失败'
          set({ error, status: 'disconnected' })
          return { success: false, error }
        } finally {
          set({ isStartingDaemon: false })
        }
      },

      sendAction: async (action, policyOverride) => {
        const { securityPolicy, status, currentWorkflowId, workflows } = get()
        if (!webBridgeClient.isConnected && !webBridgeClient.isMock) {
          set({ error: 'WebBridge not connected' })
          return null
        }

        // 接管暂停门：用户接管期间，动作在边界处等待（不中断进行中的动作）
        while (get().pauseRequested) {
          await new Promise<void>((resolve) => pauseResolvers.push(resolve))
        }

        const workflow = currentWorkflowId ? workflows.find((w) => w.id === currentWorkflowId) : null
        const effectivePolicy = policyOverride || workflow?.security_policy || securityPolicy
        const violation = checkSecurityPolicy(action, effectivePolicy)
        if (violation) {
          const errorResult: ActionResult = {
            action,
            success: false,
            error_message: violation,
            execution_time_ms: 0,
          }
          get().addLog({
            type: 'action',
            message: `Security check failed: ${violation}`,
            action,
            result: errorResult,
          })
          set({ error: violation })
          return errorResult
        }

        set({ isExecuting: true, error: null })
        get().addLog({
          type: 'action',
          message: `Executing ${action.action_type}`,
          action,
        })

        try {
          const result = await webBridgeClient.send<ActionResult>({
            type: 'action',
            payload: action,
          })

          get().addLog({
            type: 'action',
            message: result.success ? `${action.action_type} succeeded` : `${action.action_type} failed: ${result.error_message || ''}`,
            action,
            result,
          })

          if (result.success && result.page_state_after) {
            set({ pageState: result.page_state_after })
            if (action.action_type === 'screenshot' && typeof result.data === 'string') {
              set({ currentScreenshot: result.data, currentScreenshotMime: 'png' })
            }
          }

          // 实况缩略帧：daemon 在每个画面变更动作后附带 JPEG 快照，驱动浏览器舞台
          if (result.success && typeof result.screenshot_thumb === 'string' && result.screenshot_thumb) {
            set({ currentScreenshot: result.screenshot_thumb, currentScreenshotMime: 'jpeg' })
          }

          // 上报 WebBridge action 用量
          if (result.success) {
            try {
              useUsageStore.getState().report(
                buildTodayUsageRecord({ webbridgeActions: 1 })
              )
            } catch {
              // 用量上报失败不影响 action 执行
            }

            // 文件类动作自动刷新工作区
            if (['download', 'save_page', 'export_table'].includes(action.action_type)) {
              get().refreshWorkspace().catch(() => undefined)
            }
          }

          return result
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : 'Action failed'
          const errorResult: ActionResult = {
            action,
            success: false,
            error_message: errorMessage,
            execution_time_ms: 0,
          }
          get().addLog({
            type: 'error',
            message: errorMessage,
            action,
            result: errorResult,
          })

          let screenshot: string | undefined
          try {
            if (webBridgeClient.isConnected || webBridgeClient.isMock) {
              screenshot = await get().captureScreenshot()
            }
          } catch {
            // 截图失败不影响错误记录
          }

          set({
            error: errorMessage,
            lastFailure: {
              action,
              error: errorMessage,
              screenshot,
              timestamp: Date.now(),
            },
          })
          return errorResult
        } finally {
          set({ isExecuting: false })
        }
      },

      setSecurityPolicy: (policy) => {
        set((state) => ({
          securityPolicy: { ...state.securityPolicy, ...policy },
        }))
      },

      setLastFailure: (failure) => set({ lastFailure: failure }),
      clearLastFailure: () => set({ lastFailure: null }),

      requestTakeover: () => {
        if (get().pauseRequested) return
        takeoverStartPage = {
          url: get().pageState?.url || '',
          title: get().pageState?.title || '',
          at: Date.now(),
        }
        set({ pauseRequested: true })
        get().addLog({ type: 'system', message: '用户接管浏览器 · AI 已暂停' })
        // 启动实时画面推流：舞台上的点击/输入需要新鲜帧反馈。
        // 同时动态挂载帧处理器——连接若早于本模块版本建立（HMR 场景），
        // connect 时的旧 options 里没有 onScreencastFrame，必须在这里补挂。
        if (webBridgeClient.isConnected) {
          webBridgeClient.setScreencastHandler(makeScreencastFrameHandler(set))
          webBridgeClient.startScreencast().catch(() => undefined)
        }
      },

      sendStageInput: (event) => {
        if (!get().pauseRequested) return
        if (!webBridgeClient.isConnected) return
        webBridgeClient.sendInputEvent(event).catch(() => undefined)
      },

      handbackToAI: () => {
        if (!get().pauseRequested) return
        set({ pauseRequested: false })
        releasePauseGate()
        get().addLog({ type: 'system', message: '用户交还控制权 · AI 继续执行' })
        if (webBridgeClient.isConnected) {
          webBridgeClient.setScreencastHandler(null)
          webBridgeClient.stopScreencast().catch(() => undefined)
        }

        // 异步采样交还时的真实页面状态，生成接管记录回喂模型
        const start = takeoverStartPage
        takeoverStartPage = null
        const startedAt = start?.at || Date.now()
        void (async () => {
          let endUrl = get().pageState?.url || ''
          let endTitle = get().pageState?.title || ''
          try {
            if (webBridgeClient.isConnected) {
              const [urlResult, titleResult] = await Promise.all([
                webBridgeClient.send<ActionResult>({ type: 'action', payload: { action_type: 'get_url' } }),
                webBridgeClient.send<ActionResult>({ type: 'action', payload: { action_type: 'get_title' } }),
              ])
              if (typeof urlResult?.data === 'string') endUrl = urlResult.data
              if (typeof titleResult?.data === 'string') endTitle = titleResult.data
            }
          } catch {
            // 采样失败则沿用缓存状态
          }
          const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
          const fromDesc = start?.url ? `${start.title || '(无标题)'}（${start.url}）` : '(未知页面)'
          const endDesc = `${endTitle || '(无标题)'}（${endUrl || '未知地址'}）`
          const changed = start && (start.url !== endUrl)
          const note = changed
            ? `用户接管浏览器 ${secs} 秒：接管前在 ${fromDesc}，交还时页面为 ${endDesc}。用户可能已手动完成部分操作，请基于当前页面状态继续。`
            : `用户接管浏览器 ${secs} 秒后交还，页面未发生跳转，仍为 ${endDesc}。`
          set((state) => ({ takeoverNotes: [...state.takeoverNotes, note] }))
        })()
      },

      runActionsOnce: async (actions, policyOverride) => {
        const results: ActionResult[] = []
        for (const action of actions) {
          if (get().abortExecution) break
          const result = await get().sendAction(action, policyOverride)
          if (result) {
            results.push(result)
          }
          if (!result?.success) break
        }
        return results
      },

      loadPreset: (name) => {
        const preset = loadWebBridgePreset(name)
        set((state) => ({
          config: { ...state.config, ...preset, security_policy: preset.security_policy },
          securityPolicy: { ...state.securityPolicy, ...preset.security_policy },
          port: preset.bridge_port || state.port,
        }))
      },

      createWorkflow: (workflow) => {
        const newWorkflow: WorkflowDefinition = {
          ...workflow,
          id: generateId('wf'),
          version: workflow.version || '1.0.0',
        }
        set((state) => ({ workflows: [...state.workflows, newWorkflow] }))
        return newWorkflow
      },

      updateWorkflow: (id, updates) => {
        set((state) => ({
          workflows: state.workflows.map((w) => (w.id === id ? { ...w, ...updates } : w)),
        }))
      },

      deleteWorkflow: (id) => {
        set((state) => ({
          workflows: state.workflows.filter((w) => w.id !== id),
        }))
      },

      duplicateWorkflow: (id) => {
        const workflow = get().workflows.find((w) => w.id === id)
        if (!workflow) return null
        const copy: WorkflowDefinition = {
          ...workflow,
          id: generateId('wf'),
          name: `${workflow.name} (Copy)`,
        }
        set((state) => ({ workflows: [...state.workflows, copy] }))
        return copy
      },

      renameWorkflow: (id, name) => {
        set((state) => ({
          workflows: state.workflows.map((w) => (w.id === id ? { ...w, name } : w)),
        }))
      },

      getWorkflowByName: (name) => {
        const lower = name.toLowerCase()
        return get().workflows.find((w) => w.name.toLowerCase() === lower)
      },

      getWorkflows: () => get().workflows,

      ensureExampleWorkflows: () => {
        const { workflows } = get()
        const hasExamples = workflows.some((w) => w.description?.includes(EXAMPLE_WORKFLOW_TAG) || w.id.includes(EXAMPLE_WORKFLOW_TAG))
        if (workflows.length === 0 || !hasExamples) {
          const examples = buildExampleWorkflows()
          set((state) => ({
            workflows: [...examples, ...state.workflows],
          }))
        }
      },

      runWorkflow: async (workflowId, options) => {
        const workflow = get().workflows.find((w) => w.id === workflowId)
        if (!workflow) return

        const chatThread = options?.onNavigateToChat
          ? await startWorkflowRunChatThread(workflow.name, 'webbridge')
          : null
        if (chatThread) {
          options?.onNavigateToChat?.()
        }

        set({
          isExecuting: true,
          currentWorkflowId: workflowId,
          currentWorkflowStepIndex: 0,
          abortExecution: false,
          error: null,
        })

        get().addLog({
          type: 'workflow',
          message: `Starting workflow: ${workflow.name}`,
          workflowId,
        })
        chatThread?.updateLog(`开始运行 WebBridge 工作流：${workflow.name}`)

        for (let i = 0; i < (workflow.steps?.length || 0); i++) {
          if (get().abortExecution) {
            get().addLog({
              type: 'workflow',
              message: 'Workflow stopped by user',
              workflowId,
            })
            chatThread?.updateLog('工作流被用户中止')
            break
          }

          set({ currentWorkflowStepIndex: i })
          const step = workflow.steps![i]

          get().addLog({
            type: 'workflow',
            message: `Step ${i + 1}: ${step.description}`,
            workflowId,
          })
          chatThread?.updateLog(`步骤 ${i + 1}: ${step.description}`)

          if (!step.actions || step.actions.length === 0) continue

          for (const action of step.actions) {
            if (get().abortExecution) break

            const result = await get().sendAction(action)
            chatThread?.updateLog(`执行动作：${action.action_type} ${result?.success ? '成功' : '失败'}`)

            if (!result?.success) {
              const mode: ErrorHandlingMode = step.on_error || 'stop'
              if (mode === 'stop') {
                get().addLog({
                  type: 'error',
                  message: `Workflow stopped due to failed step: ${step.description}`,
                  workflowId,
                })
                set({ isExecuting: false, currentWorkflowId: null })
                chatThread?.finalize('error', `WebBridge 工作流「${workflow.name}」执行失败：步骤 ${step.description} 出错`)
                return
              } else if (mode === 'retry') {
                const retries = step.max_retries || 1
                let succeeded = false
                for (let r = 0; r < retries; r++) {
                  get().addLog({
                    type: 'workflow',
                    message: `Retrying step ${i + 1} (attempt ${r + 1}/${retries})`,
                    workflowId,
                  })
                  chatThread?.updateLog(`重试步骤 ${i + 1}，第 ${r + 1}/${retries} 次`)
                  const retryResult = await get().sendAction(action)
                  if (retryResult?.success) {
                    succeeded = true
                    break
                  }
                }
                if (!succeeded) {
                  get().addLog({
                    type: 'error',
                    message: `Step ${i + 1} failed after ${retries} retries`,
                    workflowId,
                  })
                  chatThread?.updateLog(`步骤 ${i + 1} 在 ${retries} 次重试后仍失败`)
                }
              }
              // skip: continue to next step
            }
          }
        }

        get().addLog({
          type: 'workflow',
          message: `Workflow completed: ${workflow.name}`,
          workflowId,
        })
        set({ isExecuting: false, currentWorkflowId: null, currentWorkflowStepIndex: 0 })
        chatThread?.finalize('completed', `WebBridge 工作流「${workflow.name}」执行完成。`)
      },

      stopWorkflow: () => {
        set({ abortExecution: true })
      },

      clearLogs: () => set({ logs: [] }),

      addLog: (entry) => {
        const fullEntry: WebBridgeLogEntry = {
          ...entry,
          id: generateLogId(),
          timestamp: Date.now(),
        }
        set((state) => ({
          logs: [fullEntry, ...state.logs].slice(0, 500),
        }))
      },

      executeFromNaturalLanguage: async (text) => {
        const commandText = text.replace(/^\/web\s*/i, '').trim()
        if (!commandText) {
          return '请提供 WebBridge 任务描述，例如：/web navigate to example.com'
        }

        const actions = inferActionsFromText(commandText)
        if (actions.length > 0) {
          const results: ActionResult[] = []
          for (const action of actions) {
            const result = await get().sendAction(action)
            if (!result) return '无法执行：WebBridge 未连接'
            results.push(result)
          }

          const parts = results.map((result, index) => {
            const action = actions[index]
            let line = `${index + 1}. ${action.action_type}`
            if (result.success) {
              if (action.action_type === 'navigate') line += ` → ${action.value}`
              if (action.action_type === 'click') line += ` → ${action.selector?.value || ''}`
              if (action.action_type === 'type') line += ` → ${action.selector?.value || ''}`
              if (action.action_type === 'extract_text') line += `\n${String(result.data || '').slice(0, 200)}`
              if (action.action_type === 'extract_table') line += `\n${JSON.stringify(result.data || []).slice(0, 200)}`
              if (action.action_type === 'get_url') line += `\n${result.data}`
              if (action.action_type === 'get_title') line += `\n${result.data}`
              if (action.action_type === 'screenshot') line += '（截图已生成）'
            } else {
              line += ` ❌ ${result.error_message || '未知错误'}`
            }
            return line
          })

          return `已执行 ${results.filter((r) => r.success).length}/${results.length} 个动作：\n${parts.join('\n')}`
        }

        // Try matching a saved workflow by name
        const matchedWorkflow = get().workflows.find(
          (w) =>
            w.name.toLowerCase().includes(commandText.toLowerCase()) ||
            commandText.toLowerCase().includes(w.name.toLowerCase())
        )
        if (matchedWorkflow) {
          await get().runWorkflow(matchedWorkflow.id)
          return `已运行工作流：${matchedWorkflow.name}`
        }

        return `无法识别任务："${commandText}"。支持的操作包括：navigate、click、type、screenshot、extract_text、wait、scroll、evaluate 等，或已保存的工作流名称。`
      },

      executeWorkflowFromJson: async (
        json: unknown,
        options: WebBridgeExecutionOptions = {}
      ): Promise<{ workflow: WorkflowDefinition; results: ActionResult[]; summary: string }> => {
        const { maxRetries = 1, screenshotOnFailure = true, onStep } = options
        const parsed = json as Partial<WorkflowDefinition>
        if (!parsed.name || !Array.isArray(parsed.steps)) {
          throw new Error('Invalid workflow JSON: name and steps are required')
        }

        // Ensure connection before execution
        const { status, useMock } = get()
        if (status === 'disconnected' && !useMock) {
          get().connect()
          // Wait a moment for mock to connect, or fail for real connection
          await new Promise((resolve) => setTimeout(resolve, useMock ? 100 : 1000))
        }
        if (!webBridgeClient.isConnected && !webBridgeClient.isMock) {
          throw new Error('WebBridge 未连接，请先连接 Daemon 或启用 Mock 模式')
        }

        const workflow = get().createWorkflow({
          name: parsed.name,
          description: parsed.description || '',
          workflow_type: parsed.workflow_type || 'custom',
          steps: ensureExplorationStep(parsed.steps || []).map((step, index) => ({
            step_id: step.step_id || `step-${index + 1}`,
            description: step.description || `Step ${index + 1}`,
            actions: step.actions || [],
            condition: step.condition,
            on_error: step.on_error || 'stop',
            max_retries: step.max_retries,
          })),
          input_schema: parsed.input_schema,
          output_format: parsed.output_format,
          require_login: parsed.require_login,
          target_sites: parsed.target_sites,
          estimated_duration_seconds: parsed.estimated_duration_seconds,
          security_policy: parsed.security_policy,
        })

        const results: ActionResult[] = []

        set({
          isExecuting: true,
          currentWorkflowId: workflow.id,
          currentWorkflowStepIndex: 0,
          abortExecution: false,
          error: null,
        })

        get().addLog({
          type: 'workflow',
          message: `Starting workflow: ${workflow.name}`,
          workflowId: workflow.id,
        })

        const emitStep = () => {
          const state = get()
          onStep?.({
            stepIndex: state.currentWorkflowStepIndex,
            totalSteps: workflow.steps?.length || 0,
            url: state.pageState?.url,
            title: state.pageState?.title,
            screenshot: state.currentScreenshot || undefined,
            lastAction: state.logs[0]?.action?.action_type,
          })
        }

        try {
          const steps = workflow.steps || []
          for (let i = 0; i < steps.length; i++) {
            if (get().abortExecution) {
              get().addLog({
                type: 'workflow',
                message: 'Workflow stopped by user',
                workflowId: workflow.id,
              })
              break
            }

            set({ currentWorkflowStepIndex: i })
            const step = steps[i]
            emitStep()

            get().addLog({
              type: 'workflow',
              message: `Step ${i + 1}: ${step.description}`,
              workflowId: workflow.id,
            })

            if (!step.actions || step.actions.length === 0) continue

            for (const action of step.actions) {
              if (get().abortExecution) break

              const result = await get().sendAction(action)
              if (result) {
                results.push(result)
              }
              emitStep()

              if (!result?.success) {
                const mode: ErrorHandlingMode = step.on_error || 'stop'
                if (mode === 'stop') {
                  get().addLog({
                    type: 'error',
                    message: `Workflow stopped due to failed step: ${step.description}`,
                    workflowId: workflow.id,
                  })
                  throw new Error(`步骤 "${step.description}" 执行失败：${result?.error_message || '未知错误'}`)
                } else if (mode === 'retry') {
                  const retries = Math.min(step.max_retries || 1, 3)
                  let succeeded = false
                  for (let r = 0; r < retries; r++) {
                    get().addLog({
                      type: 'workflow',
                      message: `Retrying step ${i + 1} (attempt ${r + 1}/${retries})`,
                      workflowId: workflow.id,
                    })
                    if (screenshotOnFailure) {
                      await get().captureScreenshot()
                      emitStep()
                    }
                    const retryResult = await get().sendAction(action)
                    if (retryResult?.success) {
                      succeeded = true
                      if (retryResult) results.push(retryResult)
                      emitStep()
                      break
                    }
                  }
                  if (!succeeded) {
                    get().addLog({
                      type: 'error',
                      message: `Step ${i + 1} failed after ${retries} retries`,
                      workflowId: workflow.id,
                    })
                  }
                }
                // skip: continue to next step
              }
            }
          }

          get().addLog({
            type: 'workflow',
            message: `Workflow completed: ${workflow.name}`,
            workflowId: workflow.id,
          })

          const summary = buildWebBridgeResultSummary(workflow.name, results)

          // 接管记录回喂：以工具结果摘要的形式进入 agentic 上下文，
          // 模型在下一轮决策时知道"用户接管期间做了什么/页面变成什么样"
          const notes = get().takeoverNotes
          const finalSummary = notes.length > 0
            ? `${summary}\n\n【用户接管记录】\n${notes.join('\n')}`
            : summary
          return { workflow, results, summary: finalSummary }
        } finally {
          set({ isExecuting: false, currentWorkflowId: null, currentWorkflowStepIndex: 0, takeoverNotes: [] })
        }
      },

      capturePageContext: async () => {
        if (!webBridgeClient.isConnected && !webBridgeClient.isMock) {
          throw new Error('WebBridge 未连接')
        }

        const state = get()
        const [urlResult, titleResult, textResult] = await Promise.all([
          get().sendAction({ action_type: 'get_url' }),
          get().sendAction({ action_type: 'get_title' }),
          get().sendAction({ action_type: 'extract_text' }),
        ])

        return {
          url: (urlResult?.data as string) || state.pageState?.url || '',
          title: (titleResult?.data as string) || state.pageState?.title || '',
          text: (textResult?.data as string) || '',
          screenshot: state.currentScreenshot || undefined,
        }
      },

      captureScreenshot: async () => {
        if (!webBridgeClient.isConnected && !webBridgeClient.isMock) {
          return undefined
        }
        const result = await get().sendAction({ action_type: 'screenshot' })
        return result?.success && typeof result.data === 'string' ? result.data : undefined
      },
    }),
    {
      name: 'wonclaw-webbridge',
      partialize: (state) => ({
        host: state.host,
        port: state.port,
        useMock: state.useMock,
        autoStartEnabled: state.autoStartEnabled,
        daemonPath: state.daemonPath,
        config: state.config,
        securityPolicy: state.securityPolicy,
        workflows: state.workflows,
      }),
    }
  )
)
