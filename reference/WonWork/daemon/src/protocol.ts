import type { WebSocket } from 'ws'
import type {
  WebBridgeRequest,
  WebBridgeResponse,
  BrowserAction,
  WorkflowDefinition,
  SecurityPolicy,
  WorkspaceFileInfo,
  ActionErrorReason,
} from './types/webbridge'

export function sendResponse(ws: WebSocket, response: WebBridgeResponse): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(response))
  }
}

export function parseRequest(data: string): WebBridgeRequest | null {
  try {
    return JSON.parse(data) as WebBridgeRequest
  } catch {
    return null
  }
}

export function createResponse(
  request: WebBridgeRequest,
  success: boolean,
  payload?: unknown,
  error?: string
): WebBridgeResponse {
  const base: WebBridgeResponse = {
    id: request.id,
    type: request.type === 'action' ? 'action_result' : request.type === 'workflow' ? 'workflow_result' : 'pong',
    success,
    payload,
    error,
  }
  // 如果 payload 是 ActionResult 且失败，把结构化原因码/详情提到响应顶层
  if (!success && payload && typeof payload === 'object' && payload !== null) {
    const p = payload as Record<string, unknown>
    if (typeof p.error_reason === 'string') base.error_reason = p.error_reason as ActionErrorReason
    if (typeof p.error_details === 'string') base.error_details = p.error_details
  }
  return base
}

export function createRecordedActionResponse(action: BrowserAction): WebBridgeResponse {
  return {
    id: 'recorded',
    type: 'recorded_action',
    success: true,
    payload: action,
  }
}

export function createSelectorResolvedResponse(request: WebBridgeRequest, selector: unknown): WebBridgeResponse {
  return {
    id: request.id,
    type: 'selector_resolved',
    success: true,
    payload: selector,
  }
}

export function isActionPayload(payload: unknown): payload is BrowserAction {
  return typeof payload === 'object' && payload !== null && 'action_type' in payload
}

export function isWorkflowPayload(payload: unknown): payload is WorkflowDefinition {
  return typeof payload === 'object' && payload !== null && 'workflow_type' in payload
}

export function isSecurityPolicyPayload(payload: unknown): payload is SecurityPolicy {
  return typeof payload === 'object' && payload !== null && 'security_level' in payload
}

export function isWorkspaceListPayload(payload: unknown): payload is { subdir?: string } {
  return typeof payload === 'object' && payload !== null
}

export function isWorkspaceFilePayload(payload: unknown): payload is { relativePath: string } {
  return typeof payload === 'object' && payload !== null && typeof (payload as Record<string, unknown>).relativePath === 'string'
}

export function isWriteWorkspaceFilePayload(payload: unknown): payload is { relativePath: string; base64: string } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as Record<string, unknown>).relativePath === 'string' &&
    typeof (payload as Record<string, unknown>).base64 === 'string'
  )
}

export function createWorkspaceFileSavedResponse(
  request: WebBridgeRequest,
  relativePath: string,
  size: number
): WebBridgeResponse {
  return {
    id: request.id,
    type: 'workspace_file_saved',
    success: true,
    payload: { relativePath, size },
  }
}

export function createWorkspaceFilesResponse(
  request: WebBridgeRequest,
  files: WorkspaceFileInfo[]
): WebBridgeResponse {
  return {
    id: request.id,
    type: 'workspace_files',
    success: true,
    payload: files,
  }
}

export function createWorkspaceFileContentResponse(
  request: WebBridgeRequest,
  relativePath: string,
  base64: string
): WebBridgeResponse {
  return {
    id: request.id,
    type: 'workspace_file_content',
    success: true,
    payload: { relativePath, base64 },
  }
}
