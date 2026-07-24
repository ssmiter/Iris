import type {
  AnswerNode,
  ConversationProjection,
  RenderNode,
  RoundView,
  RunView,
  ThinkingNode,
  ToolNode,
  TurnView,
} from './models'

const BASE_TIME = '2026-07-24T18:30:00+08:00'

function baseNode(
  nodeId: string,
  turnId: string,
  runId: string,
  roundId: string,
  ordinal: number,
) {
  return {
    nodeId,
    turnId,
    runId,
    roundId,
    pipelineStepRunId: null,
    groupId: null,
    ordinal,
    rendererKey: 'default',
    version: 1,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
  }
}

function makeSimpleTurn(index: number): {
  turn: TurnView
  run: RunView
  round: RoundView
  nodes: RenderNode[]
} {
  const turnId = `turn-history-${index}`
  const runId = `run-history-${index}`
  const roundId = `round-history-${index}`
  const thinkingId = `node-history-thinking-${index}`
  const answerId = `node-history-answer-${index}`
  const thinking: ThinkingNode = {
    ...baseNode(thinkingId, turnId, runId, roundId, 0),
    type: 'thinking',
    status: 'completed',
    summary: '核对已有信息，并把需要继续处理的事项整理成清单。',
    durationMs: 680 + index * 35,
  }
  const answer: AnswerNode = {
    ...baseNode(answerId, turnId, runId, roundId, 1),
    type: 'answer',
    status: 'completed',
    role: 'final',
    sourceMessageId: `msg-answer-history-${index}`,
    content: `已整理第 ${index + 1} 组记录。历史内容保持可追溯，需要时可以继续展开过程。`,
  }
  const round: RoundView = {
    roundId,
    runId,
    index: 0,
    phase: 'settled',
    processNodeIds: [thinkingId],
    answerNodeId: answerId,
    stats: { toolCallCount: 0, durationMs: 1200 + index * 50 },
    version: 1,
  }
  const run: RunView = {
    runId,
    turnId,
    parentRunId: null,
    rootRunId: runId,
    kind: 'agentic',
    purpose: '整理生活记录',
    phase: 'succeeded',
    roundIds: [roundId],
    childRunIds: [],
    startedAt: BASE_TIME,
    endedAt: '2026-07-24T18:30:02+08:00',
    version: 1,
  }
  const turn: TurnView = {
    turnId,
    branchId: 'branch-main',
    requestMessageId: `msg-request-history-${index}`,
    request: {
      text: [
        '把今天收集的零散信息整理一下。',
        '记下这次选择的理由，之后我还要回来查看。',
        '帮我把待办按重要程度重新排一下。',
      ][index % 3],
      attachmentRefs: [],
    },
    phase: 'settled',
    runIds: [runId],
    rootRunId: runId,
    renderNodeIds: [thinkingId, answerId],
    pendingAttentionIds: [],
    stats: {
      roundCount: 1,
      toolCallCount: 0,
      childRunCount: 0,
      startedAt: BASE_TIME,
      endedAt: '2026-07-24T18:30:02+08:00',
    },
    version: 1,
  }
  return { turn, run, round, nodes: [thinking, answer] }
}

const history = Array.from({ length: 14 }, (_, index) => makeSimpleTurn(index))

const travelTurnId = 'turn-travel-plan'
const travelRunId = 'run-travel-agentic'
const travelRound1Id = 'round-travel-1'
const travelRound2Id = 'round-travel-2'
const pipelineRunId = 'run-travel-pipeline'

const travelNodes: RenderNode[] = [
  {
    ...baseNode('node-travel-thinking', travelTurnId, travelRunId, travelRound1Id, 0),
    type: 'thinking',
    status: 'completed',
    summary: '先锁定必须满足的时间点，再并行比较交通和住宿。',
    detailRef: 'detail://thinking/travel-1',
    durationMs: 1400,
  },
  {
    ...baseNode('node-travel-train', travelTurnId, travelRunId, travelRound1Id, 1),
    type: 'tool',
    status: 'succeeded',
    groupId: 'travel-search',
    toolCallId: 'call-train',
    toolExecutionId: 'execution-train',
    toolName: '查询高铁班次',
    summary: '读取周五晚间与周六早间的可选班次。',
    evidenceSummary: '找到 6 个满足到达时间的班次。',
    resultRef: 'result://train-options',
  },
  {
    ...baseNode('node-travel-hotel', travelTurnId, travelRunId, travelRound1Id, 2),
    type: 'tool',
    status: 'succeeded',
    groupId: 'travel-search',
    toolCallId: 'call-hotel',
    toolExecutionId: 'execution-hotel',
    toolName: '比较西湖附近住宿',
    summary: '按步行距离、周末价格和取消政策筛选住宿。',
    evidenceSummary: '保留 4 个可免费取消的候选。',
    resultRef: 'result://hotel-options',
  },
  {
    ...baseNode('node-travel-stage-answer', travelTurnId, travelRunId, travelRound1Id, 3),
    type: 'answer',
    status: 'completed',
    role: 'stage',
    sourceMessageId: 'msg-travel-stage-answer',
    content: '交通和住宿已有可行组合。下一步按周六晚见朋友的地点压缩移动距离。',
  },
  {
    ...baseNode('node-travel-supplement', travelTurnId, travelRunId, travelRound2Id, 0),
    type: 'supplement',
    status: 'injected',
    messageId: 'msg-travel-supplement',
    text: '酒店最好可以免费取消。',
    injectedAfterRoundId: travelRound1Id,
  },
  {
    ...baseNode('node-travel-child-run', travelTurnId, travelRunId, travelRound2Id, 1),
    type: 'run',
    status: 'succeeded',
    childRunId: pipelineRunId,
    label: '行程约束检查',
    progressSummary: '4 个固定步骤全部完成，未发现时间冲突。',
  },
  {
    ...baseNode('node-travel-artifact', travelTurnId, travelRunId, travelRound2Id, 2),
    type: 'artifact',
    status: 'available',
    artifactId: 'artifact-travel-plan',
    kind: 'document',
    title: '杭州周末行程草案.md',
    previewRef: '/api/v1/artifacts/artifact-travel-plan/preview',
    sourceToolCallId: 'call-build-plan',
  },
  {
    ...baseNode('node-travel-final', travelTurnId, travelRunId, travelRound2Id, 3),
    type: 'answer',
    status: 'completed',
    role: 'final',
    sourceMessageId: 'msg-travel-final',
    content:
      '建议选择 **周五 18:42** 出发的班次，住宿放在龙翔桥附近。\n\n- 周六白天沿西湖活动，晚上前往朋友约定地点\n- 周日上午前往灵隐寺\n- 四个住宿候选均支持免费取消\n\n行程草案已经生成，可以继续调整预算或节奏。',
  },
]

const travelRounds: RoundView[] = [
  {
    roundId: travelRound1Id,
    runId: travelRunId,
    index: 0,
    phase: 'settled',
    processNodeIds: [
      'node-travel-thinking',
      'node-travel-train',
      'node-travel-hotel',
    ],
    answerNodeId: 'node-travel-stage-answer',
    stats: { toolCallCount: 2, durationMs: 6200 },
    version: 1,
  },
  {
    roundId: travelRound2Id,
    runId: travelRunId,
    index: 1,
    phase: 'settled',
    processNodeIds: [
      'node-travel-supplement',
      'node-travel-child-run',
      'node-travel-artifact',
    ],
    answerNodeId: 'node-travel-final',
    stats: { toolCallCount: 1, durationMs: 4100 },
    version: 1,
  },
]

const travelRuns: RunView[] = [
  {
    runId: travelRunId,
    turnId: travelTurnId,
    parentRunId: null,
    rootRunId: travelRunId,
    kind: 'agentic',
    purpose: '规划杭州周末行程',
    phase: 'succeeded',
    roundIds: [travelRound1Id, travelRound2Id],
    childRunIds: [pipelineRunId],
    startedAt: BASE_TIME,
    endedAt: '2026-07-24T18:30:11+08:00',
    version: 1,
  },
  {
    runId: pipelineRunId,
    turnId: travelTurnId,
    parentRunId: travelRunId,
    rootRunId: travelRunId,
    kind: 'pipeline',
    purpose: '行程约束检查',
    phase: 'succeeded',
    roundIds: [],
    childRunIds: [],
    progressSummary: '交通、住宿、会面和景点四项约束均已核对。',
    startedAt: BASE_TIME,
    endedAt: '2026-07-24T18:30:09+08:00',
    version: 1,
  },
]

const travelTurn: TurnView = {
  turnId: travelTurnId,
  branchId: 'branch-main',
  requestMessageId: 'msg-travel-request',
  request: {
    text: '规划下周去杭州的行程：便宜的高铁，住西湖附近，周六晚上见朋友，周日上午去灵隐寺。',
    attachmentRefs: [],
  },
  phase: 'settled',
  runIds: [travelRunId, pipelineRunId],
  rootRunId: travelRunId,
  renderNodeIds: travelNodes.map((node) => node.nodeId),
  pendingAttentionIds: [],
  stats: {
    roundCount: 2,
    toolCallCount: 3,
    childRunCount: 1,
    startedAt: BASE_TIME,
    endedAt: '2026-07-24T18:30:11+08:00',
  },
  version: 1,
}

const approvalTurnId = 'turn-application'
const approvalRunId = 'run-application'
const approvalRoundId = 'round-application-1'
const approvalNodes: RenderNode[] = [
  {
    ...baseNode('node-application-thinking', approvalTurnId, approvalRunId, approvalRoundId, 0),
    type: 'thinking',
    status: 'completed',
    summary: '已核对岗位要求和简历版本，准备进入提交前检查。',
    durationMs: 900,
  },
  {
    ...baseNode('node-application-tool', approvalTurnId, approvalRunId, approvalRoundId, 1),
    type: 'tool',
    status: 'verifying',
    toolCallId: 'call-application',
    toolExecutionId: 'execution-application',
    toolName: '准备网申提交',
    summary: '表单已经填好，正在验证必填项和附件版本。',
    evidenceSummary: '尚未点击提交，外部状态没有改变。',
  },
  {
    ...baseNode('node-application-approval', approvalTurnId, approvalRunId, approvalRoundId, 2),
    type: 'attention',
    status: 'waiting',
    attentionId: 'attention-application-submit',
    subtype: 'approval',
    impact: '确认后将向示例公司的招聘系统正式提交申请，提交后可能无法撤回。',
    actions: [
      { id: 'approve', label: '确认提交', tone: 'primary' },
      { id: 'reject', label: '暂不提交', tone: 'secondary' },
    ],
  },
]
const approvalRound: RoundView = {
  roundId: approvalRoundId,
  runId: approvalRunId,
  index: 0,
  phase: 'active',
  processNodeIds: approvalNodes.map((node) => node.nodeId),
  answerNodeId: null,
  stats: { toolCallCount: 1, durationMs: 5400 },
  version: 1,
}
const approvalRun: RunView = {
  runId: approvalRunId,
  turnId: approvalTurnId,
  parentRunId: null,
  rootRunId: approvalRunId,
  kind: 'agentic',
  purpose: '准备并提交网申',
  phase: 'suspended',
  roundIds: [approvalRoundId],
  childRunIds: [],
  startedAt: BASE_TIME,
  endedAt: null,
  version: 1,
}
const approvalTurn: TurnView = {
  turnId: approvalTurnId,
  branchId: 'branch-main',
  requestMessageId: 'msg-application-request',
  request: {
    text: '用我刚才确认的简历版本填写这家公司的申请，提交前让我看一眼。',
    attachmentRefs: ['artifact-resume-v4'],
  },
  phase: 'active',
  runIds: [approvalRunId],
  rootRunId: approvalRunId,
  renderNodeIds: approvalNodes.map((node) => node.nodeId),
  pendingAttentionIds: ['attention-application-submit'],
  stats: {
    roundCount: 1,
    toolCallCount: 1,
    childRunCount: 0,
    startedAt: BASE_TIME,
    endedAt: null,
  },
  version: 1,
}

const unknownTurnId = 'turn-payment-check'
const unknownRunId = 'run-payment-check'
const unknownRoundId = 'round-payment-check'
const unknownTool: ToolNode = {
  ...baseNode('node-payment-unknown', unknownTurnId, unknownRunId, unknownRoundId, 0),
  type: 'tool',
  status: 'outcome_unknown',
  toolCallId: 'call-payment',
  toolExecutionId: 'execution-payment',
  toolName: '核对账单状态',
  summary: '页面在返回确认结果前断开，当前不能证明操作是否生效。',
  evidenceSummary: '不会自动重试；需要先重新读取账单记录进行核对。',
}
const unknownAnswer: AnswerNode = {
  ...baseNode('node-payment-answer', unknownTurnId, unknownRunId, unknownRoundId, 1),
  type: 'answer',
  status: 'completed',
  role: 'final',
  sourceMessageId: 'msg-payment-answer',
  content:
    '这次检查没有得到可信终态。Iris 已停止自动操作，并保留现有证据；下一步应先核对账单记录，而不是再次执行。',
}
const unknownRound: RoundView = {
  roundId: unknownRoundId,
  runId: unknownRunId,
  index: 0,
  phase: 'failed',
  processNodeIds: [unknownTool.nodeId],
  answerNodeId: unknownAnswer.nodeId,
  stats: { toolCallCount: 1, durationMs: 7200 },
  version: 1,
}
const unknownRun: RunView = {
  runId: unknownRunId,
  turnId: unknownTurnId,
  parentRunId: null,
  rootRunId: unknownRunId,
  kind: 'agentic',
  purpose: '核对账单状态',
  phase: 'outcome_unknown',
  roundIds: [unknownRoundId],
  childRunIds: [],
  startedAt: BASE_TIME,
  endedAt: '2026-07-24T18:30:08+08:00',
  version: 1,
}
const unknownTurn: TurnView = {
  turnId: unknownTurnId,
  branchId: 'branch-main',
  requestMessageId: 'msg-payment-request',
  request: { text: '帮我确认这笔账单是不是已经处理完成。', attachmentRefs: [] },
  phase: 'failed',
  runIds: [unknownRunId],
  rootRunId: unknownRunId,
  renderNodeIds: [unknownTool.nodeId, unknownAnswer.nodeId],
  pendingAttentionIds: [],
  stats: {
    roundCount: 1,
    toolCallCount: 1,
    childRunCount: 0,
    startedAt: BASE_TIME,
    endedAt: '2026-07-24T18:30:08+08:00',
  },
  version: 1,
}

const allRuns = [
  ...history.map((item) => item.run),
  ...travelRuns,
  approvalRun,
  unknownRun,
]
const allRounds = [
  ...history.map((item) => item.round),
  ...travelRounds,
  approvalRound,
  unknownRound,
]
const allNodes = [
  ...history.flatMap((item) => item.nodes),
  ...travelNodes,
  ...approvalNodes,
  unknownTool,
  unknownAnswer,
]

export const mockConversation: ConversationProjection = {
  turns: [
    ...history.map((item) => item.turn),
    travelTurn,
    unknownTurn,
    approvalTurn,
  ],
  runsById: Object.fromEntries(allRuns.map((run) => [run.runId, run])),
  roundsById: Object.fromEntries(
    allRounds.map((round) => [round.roundId, round]),
  ),
  renderNodesById: Object.fromEntries(
    allNodes.map((node) => [node.nodeId, node]),
  ),
  compactBoundaries: [
    {
      boundaryId: 'compact-before-travel',
      beforeTurnId: travelTurnId,
      trigger: 'auto',
      coveredCount: history.length,
      summary: '此前整理任务已压缩为背景，但完整历史仍然保留。',
    },
  ],
}
