import type { SupplementView } from './input'

export type TurnPhase = 'queued' | 'active' | 'settled' | 'stopped' | 'failed'
export type RunKind = 'agentic' | 'pipeline'
export type RunPhase =
  | 'accepted'
  | 'running'
  | 'suspended'
  | 'verifying'
  | 'outcome_unknown'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
export type RoundPhase = 'active' | 'settled' | 'stopped' | 'failed'

export interface FailureView {
  code: string
  category: string
  userMessage: string
  traceId: string
  source: string
  recoveryAction:
    | 'retry_same'
    | 'reprepare'
    | 'rediscover'
    | 'reconcile'
    | 'user_input'
    | 'none'
  sideEffectOutcome:
    | 'not_started'
    | 'confirmed_not_applied'
    | 'may_have_applied'
    | 'confirmed_applied'
    | 'n/a'
  detailsRef: string | null
}

export interface TurnView {
  turnId: string
  branchId: string
  requestMessageId: string
  request: {
    text: string
    attachmentRefs: string[]
  }
  phase: TurnPhase
  runIds: string[]
  rootRunId: string
  renderNodeIds: string[]
  pendingAttentionIds: string[]
  stop: {
    stopRequestId: string
    turnId: string
    rootRunId: string
    reason: string
    state: 'requested' | 'draining' | 'completed'
    version: number
    requestedAt: string
    completedAt: string | null
  } | null
  failure: FailureView | null
  supplements: SupplementView[]
  stats: {
    roundCount: number
    toolCallCount: number
    childRunCount: number
    startedAt: string
    endedAt: string | null
  }
  version: number
}

export interface RunView {
  runId: string
  turnId: string
  parentRunId: string | null
  rootRunId: string
  kind: RunKind
  purpose: string
  phase: RunPhase
  roundIds: string[]
  childRunIds: string[]
  progressSummary?: string
  failure: FailureView | null
  startedAt: string
  endedAt: string | null
  version: number
}

export interface RoundView {
  roundId: string
  runId: string
  index: number
  phase: RoundPhase
  processNodeIds: string[]
  answerNodeId: string | null
  stats: {
    toolCallCount: number
    durationMs: number
  }
  version: number
}

interface RenderNodeBase {
  nodeId: string
  turnId: string | null
  runId: string | null
  roundId: string | null
  pipelineStepRunId: string | null
  groupId: string | null
  ordinal: number
  rendererKey: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface ThinkingNode extends RenderNodeBase {
  type: 'thinking'
  status: 'running' | 'completed' | 'failed'
  summary: string
  detailRef?: string
  durationMs?: number
}

export interface ToolNode extends RenderNodeBase {
  type: 'tool'
  status:
    | 'queued'
    | 'running'
    | 'verifying'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'outcome_unknown'
  toolCallId: string
  toolExecutionId: string
  toolName: string
  summary: string
  resultRef?: string
  evidenceSummary?: string
}

export interface AttentionAction {
  id: string
  label: string
  tone: 'primary' | 'secondary' | 'danger'
}

export interface AttentionNode extends RenderNodeBase {
  type: 'attention'
  status: 'waiting' | 'resolved' | 'expired' | 'cancelled'
  attentionId: string
  subtype: 'approval' | 'clarification' | 'takeover' | 'auth'
  impact: string
  actions: AttentionAction[]
  expiresAt?: string
  approval?: {
    approvalId: string
    toolExecutionId: string
    toolCallId: string
    toolName: string
    operationSnapshotHash: string
    riskLevel: 'read_only' | 'standard' | 'elevated' | 'destructive'
    impactStatement: string
    status: 'waiting' | 'approved' | 'rejected' | 'expired' | 'invalidated'
    version: number
    expiresAt: string
  }
}

export interface ArtifactNode extends RenderNodeBase {
  type: 'artifact'
  status: 'available' | 'superseded' | 'unavailable'
  artifactId: string
  kind: 'document' | 'spreadsheet' | 'image' | 'archive' | 'other'
  title: string
  previewRef: string
  sourceToolCallId?: string
}

export interface AnswerNode extends RenderNodeBase {
  type: 'answer'
  status: 'streaming' | 'completed' | 'stopped' | 'failed'
  content: string
  role: 'stage' | 'final'
  sourceMessageId: string | null
}

export interface SupplementNode extends RenderNodeBase {
  type: 'supplement'
  status: 'queued' | 'injected' | 'promoted'
  supplementId: string
  messageId: string
  state: 'injected' | 'promoted'
  text: string
  attachmentRefs: string[]
  injectedAfterRoundId?: string | null
}

export interface ChildRunNode extends RenderNodeBase {
  type: 'run'
  status: RunPhase
  childRunId: string
  label: string
  progressSummary: string
}

export type RenderNode =
  | ThinkingNode
  | ToolNode
  | AttentionNode
  | ArtifactNode
  | AnswerNode
  | SupplementNode
  | ChildRunNode

export interface CompactBoundaryView {
  boundaryId: string
  contextFrameId: string
  parentContextFrameId: string
  branchId: string
  beforeTurnId: string
  waterlineSequence: number
  inherited: boolean
  trigger: 'manual' | 'auto'
  coveredCount: number
  summary: string
}

export interface ForkAnchor {
  mode: 'replace_user_message'
  anchorMessageId: string
  sourceTurnId: string
  sourceEventSequence: number
  baseContextFrameId: string
  baseWaterlineSequence: number
}

export interface BranchSummary {
  branchId: string
  parentBranchId: string | null
  forkAnchor: ForkAnchor | null
  headTurnId: string | null
  status: 'active' | 'archived'
  version: number
}

export interface CompactionView {
  runId: string
  conversationId: string
  branchId: string
  phase: 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled'
  parentContextFrameId: string
  sourceStartSequence: number
  waterlineSequence: number
  beforeTurnId: string
  sourceSnapshotId: string
  sourceFactCount: number
  estimatedInputTokens: number
  compactBoundaryId: string | null
  failure: {
    code: string
    userMessage: string
    source: string
  } | null
  version: number
  requestedAt: string
  endedAt: string | null
}

export interface ConversationProjection {
  turns: TurnView[]
  runsById: Record<string, RunView>
  roundsById: Record<string, RoundView>
  renderNodesById: Record<string, RenderNode>
  compactBoundaries: CompactBoundaryView[]
}

export interface WaterfallViewState {
  expandedRoundIds: ReadonlySet<string>
  expandedNodeIds: ReadonlySet<string>
}
