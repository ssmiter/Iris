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

export class IrisApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(detail)
  }
}

async function requestJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
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

export function listConversations(): Promise<ConversationPage> {
  return requestJson('/api/v1/conversations?limit=50')
}

export function getConversationView(
  conversationId: string,
  branchId?: string,
): Promise<ConversationView> {
  const query = new URLSearchParams({ limit: '50' })
  if (branchId) query.set('branchId', branchId)
  return requestJson(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/view?${query}`,
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

export function createTurn(
  conversationId: string,
  branchId: string,
  text: string,
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
      input: { text, attachmentRefs: [] },
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
      replacement: { text: replacementText, attachmentRefs: [] },
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

export function createSupplement(turnId: string, text: string) {
  return requestJson<SupplementView>(
    `/api/v1/turns/${encodeURIComponent(turnId)}/supplements`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ text, attachmentRefs: [] }),
    },
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
