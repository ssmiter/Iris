import type {
  BranchSummary,
  CompactionView,
  CompactBoundaryView,
  RenderNode,
  RoundView,
  RunView,
  TurnView,
} from '@/domain/chat/models'
import type { SupplementView } from '@/domain/chat/input'

export interface ConversationSummary {
  conversationId: string
  title: string | null
  updatedAt: string
  activeTurnCount: number
  pendingAttentionCount: number
  lastVisibleText: string | null
  version: number
}

export interface ConversationPage {
  items: ConversationSummary[]
  nextCursor: string | null
}

export interface ConversationView {
  conversationId: string
  title: string | null
  selectedBranchId: string
  turnOrder: string[]
  turnsById: Record<string, TurnView>
  runsById: Record<string, RunView>
  roundsById: Record<string, RoundView>
  renderNodesById: Record<string, RenderNode>
  branches: BranchSummary[]
  compactBoundaries: CompactBoundaryView[]
  compactionsById: Record<string, CompactionView>
  pendingAttentionIds: string[]
  version: number
  projectionVersion: number
  eventCursor: string | null
  hasEarlierTurns: boolean
}

export interface ConversationEventEnvelope {
  schemaVersion: number
  eventId: string
  conversationId: string
  branchId: string | null
  turnId: string | null
  runId: string | null
  sequence: number
  aggregate: {
    kind: string
    id: string
    version: number
  }
  occurredAt: string
  payload: Record<string, unknown>
}

export interface ConversationEvent {
  type: string
  envelope: ConversationEventEnvelope
}

export interface TaskCheckpointView {
  checkpointId: string
  stateVersion: number
  kind: string
  resumeSummary: string
  sourceRunId: string
  createdAt: string
}

export interface TaskStepView {
  id: string
  description: string
  status: 'pending' | 'in_progress' | 'blocked' | 'completed' | 'skipped'
}

export interface TaskActivityView {
  runId: string
  relation: 'delegate' | 'pipeline' | 'state_agent' | string
  linkedStateVersion: number
  kind: string
  purpose: string
  phase: string
  runVersion: number
  updatedAt: string
  resultStatus?: string
  summary?: string
  outputRef?: string
  evidenceRefs?: string[]
  failure?: {
    code: string
    message: string
    recoveryAction: string
    sideEffectOutcome: string
  }
}

export interface TaskView {
  taskId: string
  conversationId: string
  branchId: string
  definitionVersion: number
  stateVersion: number
  version: number
  phase: 'active' | 'blocked' | 'paused' | 'completed' | 'cancelled'
  objective: string
  constraints: string[]
  completionCriteria: string[]
  steps: TaskStepView[]
  blockers: string[]
  evidenceRefs: string[]
  artifactRefs: string[]
  summary: string
  currentFocus: string
  pendingDecisions: string[]
  nextActions: string[]
  handoffNote: string
  activities: TaskActivityView[]
  latestCheckpoint?: TaskCheckpointView
  updatedAt: string
}

export interface TaskPage {
  conversationId: string
  branchId: string
  items: TaskView[]
}

export class IrisApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(detail)
  }
}

export interface SkillView {
  skillId: string
  definitionVersion: number
  headVersion: number
  name: string
  title: string
  capabilityPath: string
  description: string
  whenToUse: string
  instructions: string
  instructionsContentHash: string
  dependencies: string[]
  enabled: boolean
  lifecycleStatus: string
  updatedAt: string
}

export interface SkillDraft {
  name: string
  title: string
  capabilityPath?: string
  description: string
  whenToUse: string
  instructions: string
  dependencies: string[]
  enabled: boolean
}

export interface McpServerView {
  serverId: string
  slug: string
  displayName: string
  transport: string
  endpoint: string
  authorizationEnv: string | null
  enabled: boolean
  connectionState:
    | 'connected'
    | 'connecting'
    | 'pending'
    | 'needs_auth'
    | 'failed'
    | 'disabled'
  protocolVersion: string | null
  remoteServerName: string | null
  remoteServerVersion: string | null
  instructions: string | null
  toolCount: number
  lastError: string | null
  version: number
  createdAt: string
  updatedAt: string
  checkedAt: string | null
  command: string | null
  args: string[] | null
  env: string[] | null
}

export interface McpServerDraft {
  slug: string
  displayName: string
  transport: 'streamable_http' | 'stdio'
  endpoint: string
  authorizationEnv?: string
  command?: string
  args?: string[]
  env?: string[]
  enabled: boolean
}

export interface McpToolView {
  remoteName: string
  localName: string
  capabilityPath: string
  description: string
  riskLevel: string
  manifestHash: string
}

export interface MemorySummary {
  memoryId: string
  definitionVersion: number
  headVersion: number
  title: string
  preview: string
  scope: string
  sourceKind: string
  sourceRef: string | null
  confidence: number
  enabled: boolean
  lifecycleStatus: string
  updatedAt: string
}

export interface MemoryView extends Omit<MemorySummary, 'preview'> {
  content: string
  contentHash: string
}

export interface MemoryDraft {
  title: string
  content: string
  scope: string
  sourceKind: string
  sourceRef?: string
  confidence: number
  enabled: boolean
}

export const capabilityManagementApi = {
  listSkills: () => requestJson<SkillView[]>('/api/v1/skills'),
  createSkill: (definition: SkillDraft) =>
    requestJson<SkillView>('/api/v1/skills', {
      method: 'POST',
      body: JSON.stringify(definition),
    }),
  updateSkill: (skill: SkillView, definition: SkillDraft) =>
    requestJson<SkillView>(`/api/v1/skills/${encodeURIComponent(skill.skillId)}`, {
      method: 'PUT',
      body: JSON.stringify({
        expectedHeadVersion: skill.headVersion,
        definition,
      }),
    }),
  setSkillEnabled: (skill: SkillView, enabled: boolean) =>
    requestJson<SkillView>(
      `/api/v1/skills/${encodeURIComponent(skill.skillId)}/enabled`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          expectedHeadVersion: skill.headVersion,
          enabled,
        }),
      },
    ),
  listMcpServers: () =>
    requestJson<McpServerView[]>('/api/v1/mcp/servers'),
  createMcpServer: (definition: McpServerDraft) =>
    requestJson<McpServerView>('/api/v1/mcp/servers', {
      method: 'POST',
      body: JSON.stringify(definition),
    }),
  updateMcpServer: (server: McpServerView, definition: McpServerDraft) =>
    requestJson<McpServerView>(
      `/api/v1/mcp/servers/${encodeURIComponent(server.serverId)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          expectedVersion: server.version,
          definition,
        }),
      },
    ),
  setMcpServerEnabled: (server: McpServerView, enabled: boolean) =>
    requestJson<McpServerView>(
      `/api/v1/mcp/servers/${encodeURIComponent(server.serverId)}/enabled`,
      {
        method: 'PATCH',
        body: JSON.stringify({ expectedVersion: server.version, enabled }),
      },
    ),
  refreshMcpServer: (serverId: string) =>
    requestJson<McpServerView>(
      `/api/v1/mcp/servers/${encodeURIComponent(serverId)}/refresh`,
      { method: 'POST' },
    ),
  listMcpTools: (serverId: string) =>
    requestJson<McpToolView[]>(
      `/api/v1/mcp/servers/${encodeURIComponent(serverId)}/tools`,
    ),
  listMemories: () => requestJson<MemorySummary[]>('/api/v1/memories'),
  readMemory: (memoryId: string) =>
    requestJson<MemoryView>(
      `/api/v1/memories/${encodeURIComponent(memoryId)}`,
    ),
  createMemory: (definition: MemoryDraft) =>
    requestJson<MemoryView>('/api/v1/memories', {
      method: 'POST',
      body: JSON.stringify(definition),
    }),
  updateMemory: (memory: MemorySummary, definition: MemoryDraft) =>
    requestJson<MemoryView>(
      `/api/v1/memories/${encodeURIComponent(memory.memoryId)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          expectedHeadVersion: memory.headVersion,
          definition,
        }),
      },
    ),
  setMemoryEnabled: (memory: MemorySummary, enabled: boolean) =>
    requestJson<MemoryView>(
      `/api/v1/memories/${encodeURIComponent(memory.memoryId)}/enabled`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          expectedHeadVersion: memory.headVersion,
          enabled,
        }),
      },
    ),
}

export interface CapabilityTreeNode {
  path: string
  name: string
  title: string
  count: number
  stats: Record<string, unknown>
  children: CapabilityTreeNode[]
}

export interface CapabilityAdminItem {
  id: string | null
  version: string | null
  kind: string
  name: string
  path: string
  description: string | null
  riskLevel: string | null
  availability: string | null
  availabilityReason: string | null
  origin: 'kernel' | 'extension' | 'mcp' | 'skill_store' | 'pipeline' | string
  sourceRoot: string | null
  sourceFile: string | null
  shadowedBy: string | null
}

export interface CapabilityDirectoryCard {
  path: string
  title: string
  description: string
  capabilityCount: number
  stats: Record<string, unknown>
}

export interface CapabilityAdminListing {
  path: string
  directories: CapabilityDirectoryCard[]
  items: CapabilityAdminItem[]
}

export interface CapabilityAdminDetail {
  item: CapabilityAdminItem
  definition: unknown | null
  /** kind=pipeline 时的最近运行（新→旧）；其他 kind 为 null（docs/33 §5） */
  recentRuns?: PipelineRunSummary[] | null
}

export interface PipelineRunSummary {
  runId: string
  triggerKind: string | null
  phase: string
  startedAt: string
  endedAt: string | null
  conversationId: string
}

/** 统一能力管理页的只读投影（docs/32 §4、docs/08 §8.7） */
export const capabilityAdminApi = {
  tree: () => requestJson<CapabilityTreeNode>('/api/v1/capability-admin/tree'),
  items: (path: string) =>
    requestJson<CapabilityAdminListing>(
      `/api/v1/capability-admin/items?path=${encodeURIComponent(path)}`,
    ),
  detail: (path: string) =>
    requestJson<CapabilityAdminDetail>(
      `/api/v1/capability-admin/items/detail?path=${encodeURIComponent(path)}`,
    ),
}

/** 定时任务管理（docs/33 §3、docs/08 §8.8）：DB 真相，能力树只投影启用件。 */
export interface ScheduleView {
  taskId: string
  name: string
  expression: string
  prompt: string
  enabled: boolean
  nextFireAt: string | null
  lastFireAt: string | null
  fireCount: number
  createdBy: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface ScheduleDraft {
  name: string
  expression: string
  prompt: string
  enabled: boolean
}

export interface ScheduleExecutionView {
  executionId: string
  taskId: string
  triggerKind: 'schedule' | 'manual'
  firedAt: string
  conversationId: string | null
  runId: string | null
  status: 'fired' | 'failed'
  error: string | null
}

export const scheduleApi = {
  list: () => requestJson<ScheduleView[]>('/api/v1/schedules'),
  create: (draft: ScheduleDraft) =>
    requestJson<ScheduleView>('/api/v1/schedules', {
      method: 'POST',
      body: JSON.stringify(draft),
    }),
  update: (task: ScheduleView, draft: ScheduleDraft) =>
    requestJson<ScheduleView>(
      `/api/v1/schedules/${encodeURIComponent(task.taskId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          expectedVersion: task.version,
          ...draft,
        }),
      },
    ),
  setEnabled: (task: ScheduleView, enabled: boolean) =>
    requestJson<ScheduleView>(
      `/api/v1/schedules/${encodeURIComponent(task.taskId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          expectedVersion: task.version,
          enabled,
        }),
      },
    ),
  remove: (task: ScheduleView) =>
    requestJson<void>(
      `/api/v1/schedules/${encodeURIComponent(task.taskId)}?expectedVersion=${task.version}`,
      { method: 'DELETE' },
    ),
  runNow: (task: ScheduleView) =>
    requestJson<ScheduleExecutionView>(
      `/api/v1/schedules/${encodeURIComponent(task.taskId)}/run`,
      { method: 'POST' },
    ),
  executions: (taskId: string, limit = 20) =>
    requestJson<ScheduleExecutionView[]>(
      `/api/v1/schedules/${encodeURIComponent(taskId)}/executions?limit=${limit}`,
    ),
}

export interface ArtifactPreviewView {
  artifactId: string
  artifactRef: string
  title: string
  mode: 'text' | 'image' | 'download_only'
  format?: 'markdown' | 'json' | 'plain'
  content?: string
  truncated: boolean
  byteCount: number
  contentRef?: string
  message?: string
}

export interface UploadedArtifact {
  artifactId: string
  artifactRef: string
  version: number
  name: string
  title: string
  kind: string
  sourceKind: 'user_upload' | 'tool'
  sourceRef: string
  mediaType: string
  byteCount: number
  contentHash: string
}

export function getArtifactMetadata(
  artifactRef: string,
): Promise<UploadedArtifact> {
  const match = /^artifact:\/\/(artifact_[a-f0-9]{32})@([1-9][0-9]*)$/.exec(
    artifactRef,
  )
  if (!match) {
    return Promise.reject(new Error('无效的 Artifact 引用'))
  }
  return requestJson<UploadedArtifact>(
    `/api/v1/artifacts/${encodeURIComponent(match[1])}/versions/${match[2]}`,
  )
}

export function artifactContentUrl(artifactRef: string): string | null {
  const match = /^artifact:\/\/(artifact_[a-f0-9]{32})@([1-9][0-9]*)$/.exec(
    artifactRef,
  )
  return match
    ? `/api/v1/artifacts/${encodeURIComponent(match[1])}/versions/${match[2]}/content`
    : null
}

async function requestJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body && !(init.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const problem = await response.json().catch(() => null) as {
      code?: string
      detail?: string
    } | null
    throw new IrisApiError(
      response.status,
      problem?.code ?? 'request_failed',
      problem?.detail ?? `请求失败（${response.status}）`,
    )
  }
  return response.json() as Promise<T>
}

export function getArtifactPreview(
  previewRef: string,
  signal?: AbortSignal,
): Promise<ArtifactPreviewView> {
  return requestJson<ArtifactPreviewView>(previewRef, { signal })
}

/** 工具输出文本窗口（tool-result:// 的解析端点） */
export interface ToolOutputWindow {
  toolExecutionId: string
  format: string
  contentHash: string
  totalCharacters: number
  startCharacter: number
  endCharacterExclusive: number
  content: string
  truncated: boolean
  nextStartCharacter: number | null
}

export function getToolOutput(
  conversationId: string,
  executionId: string,
  signal?: AbortSignal,
  characterCount = 4000,
): Promise<ToolOutputWindow> {
  const query = new URLSearchParams({
    startCharacter: '0',
    characterCount: String(characterCount),
  })
  return requestJson<ToolOutputWindow>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}`
      + `/tool-executions/${encodeURIComponent(executionId)}/output?${query}`,
    { signal },
  )
}

export function listConversations(): Promise<ConversationPage> {
  return requestJson('/api/v1/conversations?limit=50')
}

export function getConversationView(
  conversationId: string,
  branchId?: string,
  beforeTurnId?: string,
): Promise<ConversationView> {
  const query = new URLSearchParams({ limit: '50' })
  if (branchId) query.set('branchId', branchId)
  if (beforeTurnId) query.set('beforeTurnId', beforeTurnId)
  return requestJson(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/view?${query}`,
  )
}

export function listTasks(
  conversationId: string,
  branchId: string,
  phase?: string,
): Promise<TaskPage> {
  const query = new URLSearchParams({ branchId, limit: '30' })
  if (phase) query.set('phase', phase)
  return requestJson(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/tasks?${query}`,
  )
}

export function createConversation(title?: string) {
  return requestJson<{
    conversationId: string
    rootBranchId: string
    version: number
  }>('/api/v1/conversations', {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ title: title ?? null }),
  })
}

export function renameConversation(
  conversationId: string,
  title: string,
  expectedVersion: number,
) {
  return requestJson<{
    conversationId: string
    title: string
    version: number
    updatedAt: string
    eventCursor: string
  }>(`/api/v1/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'PATCH',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ expectedVersion, title }),
  })
}

export function setConversationArchived(
  conversationId: string,
  archived: boolean,
  expectedVersion: number,
) {
  return requestJson<{
    conversationId: string
    archived: boolean
    version: number
    updatedAt: string
    eventCursor: string
  }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/archive`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ expectedVersion, archived }),
    },
  )
}

export function createTurn(
  conversationId: string,
  branchId: string,
  text: string,
  attachmentRefs: string[] = [],
) {
  const clientRequestId = crypto.randomUUID()
  return requestJson<{
    conversationId: string
    branchId: string
    turnId: string
    requestMessageId: string
    rootRunId: string
    acceptedAt: string
    eventCursor: string
  }>(`/api/v1/conversations/${encodeURIComponent(conversationId)}/turns`, {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      branchId,
      clientRequestId,
      input: { text, attachmentRefs },
      entrypoint: { kind: 'agentic' },
    }),
  })
}

export function createBranch(
  conversationId: string,
  sourceBranchId: string,
  anchorMessageId: string,
  replacementText: string,
  expectedConversationVersion: number,
  attachmentRefs: string[] = [],
) {
  return requestJson<{
    branchId: string
    forkedFromBranchId: string
    anchorMessageId: string
    requestMessageId: string
    turnId: string
    rootRunId: string
    acceptedAt: string
    eventCursor: string
  }>(`/api/v1/conversations/${encodeURIComponent(conversationId)}/branches`, {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      sourceBranchId,
      anchorMessageId,
      replacement: { text: replacementText, attachmentRefs },
      expectedConversationVersion,
    }),
  })
}

export function createCompaction(
  conversationId: string,
  branchId: string,
) {
  return requestJson<{
    runId: string
    eventCursor: string
  }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/compactions`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        branchId,
        scope: 'current_branch',
        reason: 'user_requested',
      }),
    },
  )
}

export function decideApproval(
  approvalId: string,
  decision: 'approve' | 'reject',
  expectedVersion: number,
  operationSnapshotHash: string,
) {
  return requestJson<{
    approvalId: string
    toolExecutionId: string
    toolCallId: string
    phase: string
    approved: boolean
    runResumeRequested: boolean
    executionVersion: number
    updatedAt: string
  }>(`/api/v1/approvals/${encodeURIComponent(approvalId)}/decision`, {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      decision,
      expectedVersion,
      operationSnapshotHash,
      reason: null,
    }),
  })
}

export function respondAttention(
  attentionId: string,
  answer: string,
  expectedVersion: number,
) {
  return requestJson<{
    attentionId: string
    inputRequestId: string
    toolExecutionId: string
    toolCallId: string
    phase: string
    runResumeRequested: boolean
    executionVersion: number
    updatedAt: string
  }>(`/api/v1/attentions/${encodeURIComponent(attentionId)}/response`, {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      expectedVersion,
      kind: 'clarification_answer',
      answer,
    }),
  })
}

export function createSupplement(
  turnId: string,
  text: string,
  attachmentRefs: string[] = [],
) {
  return requestJson<SupplementView>(
    `/api/v1/turns/${encodeURIComponent(turnId)}/supplements`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ text, attachmentRefs }),
    },
  )
}

export function uploadArtifact(
  conversationId: string,
  branchId: string,
  file: File,
) {
  const body = new FormData()
  body.append('file', file, file.name)
  return requestJson<UploadedArtifact>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/branches/${encodeURIComponent(branchId)}/artifacts`,
    { method: 'POST', body },
  )
}

export function cancelSupplement(
  turnId: string,
  supplementId: string,
) {
  return requestJson<SupplementView>(
    `/api/v1/turns/${encodeURIComponent(turnId)}/supplements/${encodeURIComponent(supplementId)}/cancel`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    },
  )
}

export function stopTurn(turnId: string) {
  return requestJson<{
    stopRequestId: string
    turnId: string
    rootRunId: string
    reason: string
    state: 'requested' | 'draining' | 'completed'
    version: number
    requestedAt: string
    completedAt: string | null
  }>(`/api/v1/turns/${encodeURIComponent(turnId)}/stop`, {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ reason: 'user_requested' }),
  })
}

export async function streamConversationEvents(
  conversationId: string,
  after: string | null,
  signal: AbortSignal,
  onEvent: (event: ConversationEvent) => void,
  onOpen?: () => void,
): Promise<void> {
  const query = after
    ? `?after=${encodeURIComponent(after)}`
    : ''
  const response = await fetch(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/events${query}`,
    {
      headers: { Accept: 'text/event-stream' },
      signal,
    },
  )
  if (!response.ok || !response.body) {
    throw new IrisApiError(
      response.status,
      'event_stream_failed',
      `事件流连接失败（${response.status}）`,
    )
  }
  onOpen?.()

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (!signal.aborted) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const lines = block.split('\n')
      const type = lines
        .find((line) => line.startsWith('event:'))
        ?.slice(6)
        .trim()
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (type && data) {
        onEvent({
          type,
          envelope: JSON.parse(data) as ConversationEventEnvelope,
        })
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
}
