/**
 * WebBridge 类型定义
 * 适配 WonWork 项目
 */

// ==================== 枚举 ====================

export type BrowserType = 'chrome' | 'edge' | 'chromium'

export const BROWSER_TYPES: BrowserType[] = ['chrome', 'edge', 'chromium']

export type ActionType =
  // 导航
  | 'navigate' | 'refresh' | 'go_back' | 'go_forward'
  // 元素交互
  | 'click' | 'double_click' | 'right_click' | 'hover'
  // 输入
  | 'type' | 'clear' | 'select' | 'check' | 'upload'
  // 页面读取
  | 'extract_text' | 'extract_table' | 'extract_html' | 'export_table'
  | 'screenshot' | 'get_url' | 'get_title'
  // 滚动
  | 'scroll' | 'scroll_to' | 'scroll_to_top' | 'scroll_to_bottom'
  // 标签页
  | 'new_tab' | 'switch_tab' | 'close_tab' | 'list_tabs'
  // 等待
  | 'wait' | 'wait_for_element' | 'wait_for_navigation'
  // JS
  | 'evaluate'
  // 文件
  | 'download' | 'save_page'

export const ACTION_TYPES: ActionType[] = [
  'navigate', 'refresh', 'go_back', 'go_forward',
  'click', 'double_click', 'right_click', 'hover',
  'type', 'clear', 'select', 'check', 'upload',
  'extract_text', 'extract_table', 'extract_html', 'export_table',
  'screenshot', 'get_url', 'get_title',
  'scroll', 'scroll_to', 'scroll_to_top', 'scroll_to_bottom',
  'new_tab', 'switch_tab', 'close_tab', 'list_tabs',
  'wait', 'wait_for_element', 'wait_for_navigation',
  'evaluate', 'download', 'save_page',
]

export type SelectorType =
  | 'css' | 'xpath' | 'id' | 'name' | 'class_name'
  | 'tag_name' | 'text' | 'text_exact' | 'aria_label'
  | 'role' | 'coordinates' | 'visual'

export const SELECTOR_TYPES: SelectorType[] = [
  'css', 'xpath', 'id', 'name', 'class_name',
  'tag_name', 'text', 'text_exact', 'aria_label',
  'role', 'coordinates', 'visual',
]

export type SecurityLevel = 'read_only' | 'standard' | 'elevated' | 'full'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'starting' | 'connected' | 'error' | 'reconnecting'

export type WorkflowType = 'data_extraction' | 'form_automation' | 'monitoring' | 'research' | 'comparison' | 'custom'

export const WORKFLOW_TYPES: WorkflowType[] = [
  'data_extraction', 'form_automation', 'monitoring', 'research', 'comparison', 'custom',
]

export type ErrorHandlingMode = 'stop' | 'skip' | 'retry' | 'fallback'

export const ERROR_HANDLING_MODES: ErrorHandlingMode[] = ['stop', 'skip', 'retry', 'fallback']

// ==================== 核心接口 ====================

export interface ElementSelector {
  selector_type: SelectorType
  value: string
  frame_index?: number
  timeout_ms?: number
}

export interface BrowserAction {
  action_type: ActionType
  description?: string
  selector?: ElementSelector
  value?: string
  coordinates?: [number, number]
  amount?: number
  options?: Record<string, unknown>
  retry_count?: number
  max_retries?: number
  delay_ms?: number
  timeout_ms?: number
}

export interface PageState {
  url: string
  title: string
  viewport_width: number
  viewport_height: number
  scroll_x: number
  scroll_y: number
  page_height: number
  ready_state: 'loading' | 'interactive' | 'complete'
  visible_text?: string
  screenshot?: string
  tab_id?: string
  tab_index?: number
  total_tabs?: number
}

/** Act 工具失败的机器可读原因码，供模型决策（重试 / 换选择器 / 等待加载） */
export type ActionErrorReason =
  | 'element_not_found'
  | 'element_not_interactable'
  | 'selector_required'
  | 'navigation_timeout'
  | 'no_table_found'
  | 'download_failed'
  | 'unsupported_action'
  | 'unknown'

/** 动作执行前后的页面状态对比（SPA 场景 url/title 不变时判断操作是否生效） */
export interface ActionStateChange {
  dom_changed: boolean
  fingerprint_before?: string
  fingerprint_after?: string
  /** type/clear 后回读的目标元素当前值 */
  element_value?: string
}

export interface ActionResult {
  action: BrowserAction
  success: boolean
  data?: unknown
  error_message?: string
  error_reason?: ActionErrorReason
  error_details?: string
  state_change?: ActionStateChange
  execution_time_ms: number
  page_state_after?: PageState
  /** 实况缩略帧（base64 JPEG），动作成功后由 daemon 附加，供浏览器舞台实时观赏 */
  screenshot_thumb?: string
}

export interface SecurityPolicy {
  security_level: SecurityLevel
  allow_file_upload?: boolean
  allow_file_download?: boolean
  allow_javascript?: boolean
  allow_form_submission?: boolean
  allowed_domains?: string[]
  blocked_domains?: string[]
  require_domain_approval?: boolean
  block_financial_sites?: boolean
  block_government_sites?: boolean
  warn_on_password_fields?: boolean
  allow_cookie_access?: boolean
  allow_localstorage_access?: boolean
  screenshot_sensitive_pages?: boolean
  max_actions_per_minute?: number
  delay_between_actions_ms?: number
}

export interface WorkflowStep {
  step_id: string
  description: string
  actions?: BrowserAction[]
  condition?: string
  on_error?: ErrorHandlingMode
  max_retries?: number
}

export interface WorkflowDefinition {
  id: string
  name: string
  description: string
  workflow_type: WorkflowType
  version?: string
  steps?: WorkflowStep[]
  input_schema?: Record<string, string>
  output_format?: string
  require_login?: boolean
  target_sites?: string[]
  estimated_duration_seconds?: number
  security_policy?: SecurityPolicy
}

export interface WebBridgeConfig {
  name?: string
  version?: string
  description?: string
  bridge_host?: string
  bridge_port?: number
  connection_timeout_ms?: number
  auto_reconnect?: boolean
  max_reconnect_attempts?: number
  browser_type?: BrowserType
  browser_path?: string
  headless?: boolean
  user_data_dir?: string
  viewport_width?: number
  viewport_height?: number
  security_policy?: SecurityPolicy
  action_timeout_ms?: number
  navigation_timeout_ms?: number
  screenshot_quality?: number
}

// ==================== 通信协议 ====================

export interface WebBridgeExecutionOptions {
  maxRetries?: number
  screenshotOnFailure?: boolean
  onStep?: (state: {
    stepIndex: number
    totalSteps: number
    url?: string
    title?: string
    screenshot?: string
    lastAction?: string
  }) => void
}

export interface WorkspaceFileInfo {
  name: string
  path: string
  relativePath: string
  subdir: string
  size: number
  modifiedAt: string
}

export interface WebBridgeRequest {
  id: string
  type: 'action' | 'workflow' | 'ping' | 'config' | 'start_recording' | 'stop_recording' | 'resolve_selector' | 'list_workspace_files' | 'delete_workspace_file' | 'read_workspace_file' | 'write_workspace_file' | 'start_screencast' | 'stop_screencast' | 'input_event'
  payload?: unknown
}

export interface WebBridgeResponse {
  id: string
  type: 'action_result' | 'workflow_result' | 'page_state' | 'pong' | 'error' | 'recorded_action' | 'selector_resolved' | 'workspace_files' | 'workspace_file_content' | 'workspace_file_saved' | 'screencast_frame'
  success: boolean
  payload?: unknown
  error?: string
  error_reason?: ActionErrorReason
  error_details?: string
}

/** 舞台输入事件（接管模式：用户在舞台画面上的操作转发给真实浏览器） */
export type StageInputEvent =
  | { kind: 'click'; x: number; y: number }
  | { kind: 'scroll'; x: number; y: number; deltaY: number }
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: string }

// ==================== 日志与状态 ====================

export interface WebBridgeLogEntry {
  id: string
  timestamp: number
  type: 'action' | 'workflow' | 'system' | 'error'
  message: string
  action?: BrowserAction
  result?: ActionResult
  workflowId?: string
}

// ==================== 预设配置 ====================

export class PresetConfigs {
  static researchAssistant(): WebBridgeConfig {
    return {
      name: 'research-assistant',
      description: '多站点研究，快速提取数据',
      bridge_port: 9223,
      security_policy: {
        security_level: 'standard',
        allow_file_download: true,
        delay_between_actions_ms: 300,
        max_actions_per_minute: 100,
      },
      action_timeout_ms: 20000,
      screenshot_quality: 80,
    }
  }

  static formAutomation(): WebBridgeConfig {
    return {
      name: 'form-automation',
      description: '表单填写与提交自动化',
      bridge_port: 9223,
      security_policy: {
        security_level: 'elevated',
        allow_form_submission: true,
        allow_file_upload: true,
        delay_between_actions_ms: 800,
        max_actions_per_minute: 40,
      },
      action_timeout_ms: 30000,
    }
  }

  static dataExtraction(): WebBridgeConfig {
    return {
      name: 'data-extraction',
      description: '结构化数据提取',
      bridge_port: 9223,
      security_policy: {
        security_level: 'read_only',
        allow_file_download: true,
        delay_between_actions_ms: 200,
        max_actions_per_minute: 150,
      },
      action_timeout_ms: 15000,
      screenshot_quality: 60,
    }
  }

  static monitoring(): WebBridgeConfig {
    return {
      name: 'monitoring',
      description: '低频次定时监控',
      bridge_port: 9223,
      security_policy: {
        security_level: 'read_only',
        delay_between_actions_ms: 1000,
        max_actions_per_minute: 20,
      },
      action_timeout_ms: 45000,
    }
  }

  static secureEnterprise(): WebBridgeConfig {
    return {
      name: 'secure-enterprise',
      description: '企业级严格安全策略',
      bridge_port: 9223,
      security_policy: {
        security_level: 'read_only',
        allow_file_upload: false,
        allow_javascript: false,
        allowed_domains: [],
        require_domain_approval: true,
        block_financial_sites: true,
        block_government_sites: true,
        screenshot_sensitive_pages: false,
        max_actions_per_minute: 30,
        delay_between_actions_ms: 1000,
      },
      action_timeout_ms: 60000,
    }
  }
}

export const WEBBRIDGE_PRESETS: Record<string, () => WebBridgeConfig> = {
  'research-assistant': PresetConfigs.researchAssistant,
  'form-automation': PresetConfigs.formAutomation,
  'data-extraction': PresetConfigs.dataExtraction,
  'monitoring': PresetConfigs.monitoring,
  'secure-enterprise': PresetConfigs.secureEnterprise,
}

export function loadWebBridgePreset(name: string): WebBridgeConfig {
  const factory = WEBBRIDGE_PRESETS[name]
  return factory ? factory() : createDefaultWebBridgeConfig()
}

export function createDefaultWebBridgeConfig(): WebBridgeConfig {
  return {
    name: 'default-webbridge',
    version: '1.0.0',
    bridge_host: 'localhost',
    bridge_port: 9223,
    connection_timeout_ms: 30000,
    auto_reconnect: true,
    max_reconnect_attempts: 5,
    browser_type: 'chrome',
    headless: false,
    viewport_width: 1280,
    viewport_height: 720,
    security_policy: {
      security_level: 'standard',
      allow_file_download: true,
      allow_file_upload: false,
      allow_javascript: true,
      allow_form_submission: true,
      delay_between_actions_ms: 500,
      max_actions_per_minute: 60,
      block_financial_sites: true,
      block_government_sites: false,
      warn_on_password_fields: true,
      screenshot_sensitive_pages: true,
    },
    action_timeout_ms: 30000,
    navigation_timeout_ms: 60000,
    screenshot_quality: 80,
  }
}
