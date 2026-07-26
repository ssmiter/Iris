# 08 · Iris API 契约草案

> 状态：大陆 0 / 节点 0.4 契约定稿候选
>
> 范围：定义 Frontend 与 Java Backend 的 REST 命令、读模型和 SSE 投影，以及 Backend 与 WebBridge 的私有边界。本文不冻结数据库列，不是 OpenAPI 生成文件。
>
> 总体职责见 [02 · Iris 总体架构](02-architecture-overview.md)。

## 1. 契约原则

1. Frontend 提交人的命令，不提交 provider messages、全量 Tool schema 或“我已经审批”的事实。
2. Backend 先持久化，再返回接受结果或发 SSE。
3. REST 负责有限命令和读模型；SSE 是唯一流式通道，禁止轮询运行状态。
4. SSE 至少一次投递；Frontend 用稳定 event ID 去重。
5. 所有 ID 都是不透明字符串，客户端不得解析时间、类型或父子关系。
6. 写命令带幂等键；并发敏感命令带预期版本。
7. 错误使用 `application/problem+json`，同时提供稳定机器码和一句可展示的人话。
8. API 只返回安全投影；秘密、原始凭据、未过滤工具输出和隐藏推理不出 Backend。

旧设计中的 `POST /api/chat/proxy` 和普通前端可调用的 `POST /api/tools/invoke` 被取消。它们会让 Frontend 重新拥有 Loop，或绕过唯一 Tool Runtime。

## 2. 通用约定

### 2.1 Base URL 与版本

```text
/api/v1
```

首版只维护一个主版本。兼容新增字段不升版本；删除、改义或改变事件 reducer 语义才升级。

### 2.2 编码

- JSON 字段使用 `camelCase`；
- 时间为带时区的 RFC 3339，例如 `2026-07-24T18:30:00+08:00`；
- 枚举值使用 `snake_case`；
- 未知响应字段必须被客户端忽略；
- 客户端发送未知命令字段由服务端拒绝，避免安全字段拼错后静默失效；
- 大文本、二进制、截图和 Tool 原始结果返回引用，不内嵌到 ConversationView。

### 2.3 命令头

会创建或改变事实的请求使用：

```http
Idempotency-Key: <client-generated opaque key>
```

同一 subject、endpoint、幂等键和规范化 body：

- 第一次成功接受后，重复请求返回同一 resource；
- body 不同则返回 `409 idempotency_key_reused`；
- 幂等记录由 SQLite 唯一约束保证，不使用“先查再插”。

对需要乐观并发的命令，body 带 `expectedVersion`。版本不符返回 `409 stale_version` 和当前安全摘要。

### 2.4 HTTP 状态

| 状态 | 语义 |
|---:|---|
| `200` | 读取或同步命令完成 |
| `201` | 资源已创建并持久化 |
| `202` | 长任务已接受；后续只经 SSE/读模型观察 |
| `204` | 幂等命令完成且无 body |
| `400` | JSON 或基本参数不合法 |
| `404` | 当前主体不可见或不存在 |
| `409` | 幂等键、版本、状态或资源冲突 |
| `410` | event cursor 已过期或不可用于当前投影 |
| `412` | 前置条件/快照不再成立 |
| `422` | schema 合法但业务语义无法接受 |
| `429` | 本地预算或 provider rate limit |
| `502` | 外部 provider/daemon 协议故障 |
| `503` | 必需本机组件或 provider 不可用 |

## 3. 核心读模型

### 3.1 `ConversationSummary`

```json
{
  "conversationId": "conv_opaque",
  "title": "整理秋招申请",
  "updatedAt": "2026-07-24T18:30:00+08:00",
  "activeTurnCount": 1,
  "pendingAttentionCount": 2,
  "lastVisibleText": "已整理 18 家公司",
  "version": 7
}
```

标题可以由内部 Pipeline 生成，但只作为 metadata 更新；标题生成过程不会伪装成用户 Turn。

### 3.2 `ConversationView`

```json
{
  "conversationId": "conv_opaque",
  "title": "整理秋招申请",
  "selectedBranchId": "branch_for_requested_view",
  "turnOrder": ["turn_1", "turn_2"],
  "turnsById": {
    "turn_1": {}
  },
  "runsById": {
    "run_1": {}
  },
  "roundsById": {
    "round_1": {}
  },
  "renderNodesById": {
    "node_1": {}
  },
  "branches": [],
  "compactBoundaries": [],
  "compactionsById": {},
  "attentionsById": {},
  "pendingAttentionIds": [],
  "version": 12,
  "projectionVersion": 1,
  "eventCursor": "evt_opaque",
  "hasEarlierTurns": false
}
```

返回的是某个 Branch 上的安全投影，不是数据库实体拼盘。`eventCursor` 与该快照在同一一致性边界取得。`version` 是 Conversation 命令并发版本；Message、Branch 与 metadata 结构变化时递增，普通流式 delta 不递增它。

`projectionVersion` 只表示读模型 schema 版本，不随普通数据变化递增；数据 revision 使用 entity `version` 与 `eventCursor`。

`pendingAttentionIds` 始终索引 `attentionsById` 的 `attentionId`，不是 RenderNode ID；Attention 对应的可见节点另存于 `renderNodesById`。

### 3.3 `TurnView`

```json
{
  "turnId": "turn_opaque",
  "branchId": "branch_opaque",
  "requestMessageId": "msg_opaque",
  "request": {
    "text": "把这批公司按截止日期整理，并尝试找到申请入口",
    "attachmentRefs": []
  },
  "phase": "active",
  "runIds": ["run_root"],
  "rootRunId": "run_root",
  "renderNodeIds": ["node_1", "node_2"],
  "pendingAttentionIds": ["attention_1"],
  "failure": null,
  "supplements": [],
  "stats": {
    "roundCount": 2,
    "toolCallCount": 4,
    "childRunCount": 1,
    "startedAt": "2026-07-24T18:30:00+08:00",
    "endedAt": null
  },
  "version": 12
}
```

`phase`：

```text
queued | active | settled | stopped | failed
```

等待审批或人工输入不是 Turn 的独占 phase；它们是 Attention 和 Run blocker，因此同一 Turn 可以继续其他安全并行工作。

### 3.4 `RunView`

```json
{
  "runId": "run_opaque",
  "turnId": "turn_opaque",
  "parentRunId": null,
  "rootRunId": "run_opaque",
  "invokingStepId": null,
  "kind": "agentic",
  "definition": {
    "id": "iris.agentic.default",
    "version": "1",
    "snapshotHash": "sha256-definition",
    "normalizedInputHash": "sha256-input",
    "dependencySnapshotRef": null
  },
  "purpose": "整理公司并探索申请入口",
  "phase": "running",
  "blockers": [],
  "roundIds": ["round_1", "round_2"],
  "childRunIds": ["run_pipeline_1"],
  "budget": {
    "toolCallsUsed": 4,
    "toolCallsLimit": 30,
    "elapsedMs": 15000,
    "timeLimitMs": 600000
  },
  "outputRef": null,
  "evidenceRefs": [],
  "failure": null,
  "version": 8,
  "startedAt": "2026-07-24T18:30:00+08:00",
  "endedAt": null
}
```

`kind`：

```text
agentic | pipeline
```

`phase`：

```text
accepted | running | suspended | verifying |
outcome_unknown | succeeded | failed | cancelled
```

等待原因放在可定位的 `blockers[]`：

```json
[
  {
    "kind": "approval",
    "refId": "approval_opaque",
    "since": "2026-07-24T18:30:01+08:00"
  }
]
```

这样一个并行 Run 不会因为其中一个分支等待批准，就丢失其他分支仍在运行的事实。

`kind` 可为 `user_input | approval | child_run | resource | external_component`。

Pipeline Run 接受时 `definition.snapshotHash / normalizedInputHash / dependencySnapshotRef` 必须冻结；恢复不重新按当前 Catalog alias 或排序解析依赖。Agentic Run 的 dependency snapshot 可为空。

### 3.5 `RoundView`

Round 只属于 Agentic Run：

```json
{
  "roundId": "round_opaque",
  "runId": "run_agentic",
  "index": 2,
  "phase": "active",
  "processNodeIds": ["node_thinking", "node_tool"],
  "answerNodeId": null,
  "stats": {
    "toolCallCount": 1,
    "durationMs": 3200
  },
  "version": 3
}
```

PipelineStepRun 与 ModelStep 仍是 canonical facts，但首版 Frontend 不沿裸 ID 读取内部编排；它只接收相应 RenderNode、RoundView 或 RunView。后续若确有诊断需求，再冻结有权限的 detail contract。

### 3.6 `RenderNode`

所有节点共享：

```json
{
  "nodeId": "node_opaque",
  "turnId": "turn_opaque_or_null",
  "runId": "run_opaque_or_null",
  "roundId": "round_opaque_or_null",
  "pipelineStepRunId": null,
  "type": "tool",
  "status": "running",
  "groupId": "parallel_group_or_null",
  "ordinal": 3,
  "rendererKey": "default_tool",
  "version": 4,
  "finalContentHash": null,
  "createdAt": "2026-07-24T18:30:00+08:00",
  "updatedAt": "2026-07-24T18:30:02+08:00"
}
```

联合类型：

| `type` | 关键安全投影 |
|---|---|
| `thinking` | `summary, detailRef?, durationMs?` |
| `tool` | `toolCallId, toolExecutionId, toolName, summary, resultRef?, evidenceSummary?` |
| `attention` | `attentionId, subtype, impact, actions, expiresAt?, approval?` |
| `artifact` | `artifactId, kind, title, previewRef, sourceToolCallId?` |
| `answer` | `content, role=stage|final, sourceMessageId` |
| `supplement` | `messageId, state, injectedAfterRoundId?` |
| `run` | `childRunId, label, progressSummary` |

Frontend 只按 `type + rendererKey` 选择安全 renderer。它不能从 `summary` 推断 Tool 已完成。

未知 `rendererKey` 必须落到对应 `type` 的内置安全默认 renderer；不得动态加载任意组件或渲染原始 HTML。

### 3.7 `FailureView`

HTTP、持久化 Run/Turn、ToolExecution、SSE 终态和模型 observation 共享同一安全失败语义：

```json
{
  "code": "capability_unavailable",
  "category": "dependency",
  "userMessage": "这个能力当前不可用；Iris 已保留原调用版本，没有改用其他版本。",
  "traceId": "trace_opaque",
  "source": "tool_runtime",
  "recoveryAction": "rediscover",
  "sideEffectOutcome": "not_started",
  "detailsRef": null
}
```

`recoveryAction`：

```text
retry_same | reprepare | rediscover | reconcile | user_input | none
```

`sideEffectOutcome`：

```text
not_started | confirmed_not_applied | may_have_applied |
confirmed_applied | n/a
```

`cancelled` 或 `timed_out` 只有在活动已确认停止且没有未闭合副作用时才是终态；否则必须进入 `outcome_unknown` 并要求 reconcile。

## 4. Conversation REST

### 4.1 列表

```http
GET /api/v1/conversations?cursor=<opaque>&limit=30
```

```json
{
  "items": [],
  "nextCursor": null
}
```

### 4.2 新建

```http
POST /api/v1/conversations
Idempotency-Key: create-conversation-opaque
Content-Type: application/json
```

```json
{
  "title": null
}
```

响应：

```json
{
  "conversationId": "conv_opaque",
  "rootBranchId": "branch_opaque",
  "version": 1
}
```

标题为空时可以异步运行内部标题 Pipeline；新建 Conversation 不需要先调用模型。

### 4.3 读取当前分支投影

```http
GET /api/v1/conversations/{conversationId}/view
    ?branchId={branchId}
    &beforeTurnId={optional}
    &limit=50
```

返回 `ConversationView`。

`branchId` 必填或使用服务端 root branch；Frontend 的“当前选中分支”主要属于 View State，不是所有窗口共享的全局真相。

### 4.4 修改 metadata

```http
PATCH /api/v1/conversations/{conversationId}
Idempotency-Key: rename-opaque
```

```json
{
  "expectedVersion": 7,
  "title": "2026 秋招"
}
```

只允许明确列出的 metadata 字段。Provider、Branch 或历史不能通过这个 endpoint 修改。

## 5. Turn 与运行命令

### 5.1 提交自然语言 Turn

```http
POST /api/v1/conversations/{conversationId}/turns
Idempotency-Key: user-send-opaque
```

```json
{
  "branchId": "branch_opaque",
  "clientRequestId": "client_opaque",
  "input": {
    "text": "帮我整理这批网申信息",
    "attachmentRefs": ["artifact_input_1"]
  },
  "entrypoint": {
    "kind": "agentic"
  }
}
```

响应 `202`：

```json
{
  "conversationId": "conv_opaque",
  "branchId": "branch_opaque",
  "turnId": "turn_opaque",
  "requestMessageId": "msg_opaque",
  "rootRunId": "run_opaque",
  "acceptedAt": "2026-07-24T18:30:00+08:00",
  "eventCursor": "evt_accepted"
}
```

自然语言入口的 `entrypoint.kind` 首版固定为 `agentic`，也可以整个字段省略。客户端不能随意传 Pipeline ID 来绕过 Catalog、Definition version 和输入验证。

`Idempotency-Key` 控制 HTTP request replay；`clientRequestId` 只用于 UI 乐观项与接受结果关联，并进入历史。两者不是同一去重域。

### 5.2 显式调用已发布 Pipeline Capability

用户从明确的按钮、命令或结构化表单选择 Pipeline 时：

```http
POST /api/v1/conversations/{conversationId}/turns
Idempotency-Key: explicit-capability-opaque
```

```json
{
  "branchId": "branch_opaque",
  "clientRequestId": "client_opaque",
  "input": {
    "text": "运行已保存的网申资料检查",
    "attachmentRefs": []
  },
  "entrypoint": {
    "kind": "pipeline_capability",
    "capabilityId": "capability_opaque",
    "definitionVersion": "3",
    "structuredInput": {
      "folder": "job/"
    }
  }
}
```

Backend 校验该 Capability 确实指向已发布 Pipeline Definition，再创建 `kind=pipeline` 的 root Run。首版不允许用户直接选择原子 Tool 作为 Turn entrypoint；Tool 只能由 Agentic 或 Pipeline 的 tool node 产生 ToolCall/ToolExecution。这样每个接受的 Turn 都有合法 root Run，也不把直接 Tool 偷偷伪装成 one-step Pipeline。客户端不能指定 executor binding、riskLevel 或 `approved=true`。

### 5.3 过程中补充

```http
POST /api/v1/turns/{turnId}/supplements
Idempotency-Key: supplement-opaque
```

```json
{
  "text": "优先处理明天截止的公司",
  "attachmentRefs": []
}
```

响应 `202`：

```json
{
  "supplementId": "supplement_opaque",
  "turnId": "turn_opaque",
  "messageId": null,
  "state": "pending",
  "injectedAfterRoundId": null,
  "version": 1
}
```

状态：

```text
pending | injected | cancelled | promoted
```

注入边界由 Backend 决定并经 SSE 确认。Turn 已结束时可以原子升格为新 Turn；不得静默丢弃或自动无限续跑。
`pending` 阶段尚未创建 canonical Message，避免上下文查询提前读到；真正注入时才写入
普通 `role=user` Message，此时 `messageId` 才有值。模型只看到用户原文与附件，不接收
“已注入”等界面状态说明。

### 5.4 撤回未注入补充

```http
POST /api/v1/turns/{turnId}/supplements/{supplementId}/cancel
Idempotency-Key: supplement-cancel-opaque
```

若已经注入返回 `409 supplement_already_injected`。

### 5.5 停止 Turn

```http
POST /api/v1/turns/{turnId}/stop
Idempotency-Key: stop-opaque
```

```json
{
  "reason": "user_requested"
}
```

响应 `202`：

```json
{
  "stopRequestId": "stop_opaque",
  "turnId": "turn_opaque",
  "rootRunId": "run_opaque",
  "reason": "user_requested",
  "state": "requested",
  "version": 1,
  "requestedAt": "2026-07-26T12:00:00Z",
  "completedAt": null
}
```

`state = requested | draining | completed`。停止是持久化意图：

- Backend 停止创建新的 Model Step 和 child Run；
- 取消向下传播到可取消活动；
- 已进入副作用的 ToolExecution 仍需 verify；
- 未注入 Supplement 保留为待处理，不自动发送；
- 最终 `stopped` 由 SSE 确认。

`draining` 表示至少一个 ToolExecution 已越过执行门，必须完成 verify 或闭合为
`OutcomeUnknown`；它不表示还会继续规划新步骤。进程内取消句柄只负责加快合作取消，
丢失后仍由 StopRequest、Run、Round 与 ToolExecution 事实恢复。

### 5.6 Run 详情

```http
GET /api/v1/runs/{runId}
```

用于展开诊断或重连后的精确读取，不用于轮询。正常 UI 通过 Conversation SSE 和 ConversationView 获取状态。

首版不提供任意 `POST /runs/{id}/resume`。等待输入、审批、人工接管等各有类型化命令，避免一个万能 resume 携带不明状态。

Pipeline 重启从 terminal Step 与 child facts 重建 ready-set。若冻结依赖 unavailable，Run 以 `suspended` + blocker/FailureView 投影；不得自动迁移 Definition/Manifest，也不得直接切 Agentic。Pipeline → Agentic handoff 只有在全部 earlier/sibling activity 终止、Resource Claim 已释放或转移、且没有执行中/验证中/未知写动作时才能创建 child Run；child 继承权限上限但不继承 Approval。

## 6. Branch 与 Compact

### 6.1 读模型

`BranchSummary`：

```json
{
  "branchId": "branch_opaque",
  "parentBranchId": "branch_parent_or_null",
  "forkAnchor": {
    "mode": "replace_user_message",
    "anchorMessageId": "msg_user_opaque",
    "sourceTurnId": "turn_source",
    "sourceEventSequence": 120
  },
  "headTurnId": "turn_head",
  "status": "active",
  "version": 3
}
```

`mode=replace_user_message` 表示新分支在锚点用户消息之前继承 Context，并用 replacement 创建新 Message/Turn；旧锚点及尾部完全保留在 source Branch。

`CompactBoundaryView`：

```json
{
  "boundaryId": "boundary_opaque",
  "contextFrameId": "frame_opaque",
  "parentContextFrameId": "frame_parent",
  "branchId": "branch_opaque",
  "beforeTurnId": "turn_cutoff",
  "waterlineSequence": 118,
  "inherited": false,
  "trigger": "manual",
  "coveredCount": 12,
  "summaryArtifactRef": "artifact_summary",
  "summary": "经过验证的上下文 Frame",
  "version": 1
}
```

Boundary 不复制该范围内全部 Tool/Capability ID。完整 provenance 通过 canonical
ToolCall/Exposure 沿 source range 解引用。每个 Frame 只有一个 parent，但可以被多个
Branch head 或后续 Frame 引用，因此整体是一棵从当前叶子向 origin 根节点收敛的
多叉树。

### 6.2 创建分支

```http
POST /api/v1/conversations/{conversationId}/branches
Idempotency-Key: branch-opaque
```

```json
{
  "sourceBranchId": "branch_current",
  "anchorMessageId": "msg_user_opaque",
  "replacement": {
    "text": "换一种要求重新尝试",
    "attachmentRefs": []
  },
  "expectedConversationVersion": 12
}
```

响应 `201`：

```json
{
  "branchId": "branch_new",
  "forkedFromBranchId": "branch_current",
  "anchorMessageId": "msg_user_opaque",
  "requestMessageId": "msg_replacement",
  "turnId": "turn_new",
  "rootRunId": "run_new",
  "acceptedAt": "2026-07-24T18:30:00+08:00",
  "eventCursor": "evt_branch_accepted"
}
```

旧消息、旧尾部、ToolCall 和 RenderNode 不覆盖。Frontend 随后用新 `branchId` 读取视图和订阅同一 Conversation event stream。

### 6.3 选择分支

选择是 Frontend View State，并通过 `GET .../view?branchId=` 加载。它不会自动回滚 Workspace，也不会停止另一个窗口正在观察的 Run。

观察一个仍在运行的 Branch 不要求 stop。只有在 active source Branch 上创建替换分支会破坏闭合 anchor 时，Branch command 才返回 `409 branch_source_active`；用户可显式 stop 后重试。

### 6.4 Workspace restore

要让文件世界回到某个历史锚点，可以交给自然语言 Agentic Turn，或显式选择已发布的 `workspace.restore_preview` Pipeline Capability：

```json
{
  "entrypoint": {
    "kind": "pipeline_capability",
    "capabilityId": "workspace.restore_checkpoint",
    "definitionVersion": "1",
    "structuredInput": {
      "checkpointId": "checkpoint_opaque"
    }
  }
}
```

Runtime 生成差异预览和 Operation Snapshot，等待批准。不存在“切分支即静默改文件”的 endpoint。

### 6.5 手动 Compact

```http
POST /api/v1/conversations/{conversationId}/compactions
Idempotency-Key: compact-opaque
```

```json
{
  "branchId": "branch_opaque",
  "scope": "current_branch",
  "reason": "user_requested"
}
```

响应 `202`：

```json
{
  "runId": "run_compact_opaque",
  "eventCursor": "evt_compact_accepted"
}
```

安全 cutoff 由 Backend 根据已闭合 Model Step、ToolCall 和分支位置选择，Frontend 不能指定一个会截断未闭合调用的位置。Compact 是内部 Pipeline：生成 Context Frame seed、结构化事实引用和 CompactBoundary。它不删除 Message，也不改写旧 Tool 结构。

`CompactionView` 直接绑定上述 Pipeline Run，不引入第四套 operation 生命周期：

```json
{
  "runId": "run_compact_opaque",
  "conversationId": "conv_opaque",
  "branchId": "branch_opaque",
  "phase": "running",
  "compactBoundaryId": null,
  "failure": null,
  "version": 2
}
```

```http
GET /api/v1/compactions/{runId}
```

刷新时也可从 `ConversationView.compactionsById` 恢复。它经 `compaction.started / completed / failed / cancelled` 事件闭合；失败不产生半截 Boundary。

## 7. Approval

### 7.1 `ApprovalView`

```json
{
  "approvalId": "approval_opaque",
  "toolExecutionId": "execution_opaque",
  "toolId": "workspace.write_file",
  "manifestVersion": "2",
  "operationSnapshotHash": "sha256-opaque",
  "riskLevel": "standard",
  "impactStatement": "将覆盖 workspace/reports/week.md；原文件 12 KB，已创建检查点",
  "affectedResources": [
    {
      "resource": "workspace:/reports/week.md",
      "effect": "write",
      "expectedVersion": "sha256-before"
    }
  ],
  "status": "pending",
  "createdAt": "2026-07-24T18:30:00+08:00",
  "expiresAt": "2026-07-24T18:35:00+08:00",
  "decidedAt": null,
  "decision": null,
  "reason": null,
  "version": 1
}
```

Frontend 不需要也不应获得秘密参数。完整规范化输入保存在 Backend，UI 得到足以理解影响的安全预览。

`status`：

```text
pending | approved | rejected | expired | invalidated
```

Approval Attention 的 `attentionId` 与 `approvalId` 是不同 ID。它的 `AttentionView.payload.approval` 必须内嵌完整安全 `ApprovalView`，使实时卡片无需猜 ID 或额外轮询就能提交合法决定。

### 7.2 决定

```http
POST /api/v1/approvals/{approvalId}/decision
Idempotency-Key: approval-decision-opaque
```

```json
{
  "decision": "approve",
  "expectedVersion": 1,
  "operationSnapshotHash": "sha256-opaque",
  "reason": null
}
```

`decision`：

```text
approve | reject
```

Backend 只接受第一份合法决定。命令提交时已经 stale，直接返回 `412 approval_stale`；接受决定时返回 `200 ApprovalView + eventCursor`。即使批准，Commit Gate 仍重新核验：

- Manifest 与 executor version；
- snapshot hash；
- target/resource version；
- policy 与身份；
- expiration；
- 其他 preflight 条件。

若决定接受后、真正 Commit 前又失效，不能再借原 HTTP 返回 412。Runtime 经 SSE 将旧 Approval 标为 `invalidated`，重新 Prepare，并产生新的 Approval Attention。客户端不能复用旧批准。

### 7.3 恢复待处理审批

```http
GET /api/v1/approvals/{approvalId}
```

返回单个 `ApprovalView`。它是刷新、深链接或显式详情读取，不用于轮询。

```http
GET /api/v1/conversations/{conversationId}/approvals?status=pending
```

这是刷新后的恢复读取，不得用于运行期轮询。正常新增和决定经 SSE 投影。

### 7.4 非 Approval Attention 响应

`AttentionView`：

```json
{
  "attentionId": "attention_opaque",
  "turnId": "turn_opaque",
  "runId": "run_opaque",
  "subtype": "clarification",
  "status": "pending",
  "impact": "需要确认是否把酒店搜索范围扩大到西湖 3 公里内。",
  "actions": ["answer", "cancel"],
  "payload": {
    "question": "是否扩大搜索范围？"
  },
  "expiresAt": null,
  "resolvedAt": null,
  "version": 1
}
```

```http
POST /api/v1/attentions/{attentionId}/response
Idempotency-Key: attention-response-opaque
```

请求是严格判别联合：

```json
{
  "expectedVersion": 1,
  "kind": "clarification_answer",
  "answer": "扩大到 3 公里"
}
```

首版 response kind：

```text
clarification_answer
manual_verification_confirmed_applied
manual_verification_confirmed_not_applied
takeover_completed
cancel
```

Backend 按 subtype 校验允许的 kind；人工核验还必须记录 evidence/comment，不能由普通 Supplement 冒充决议。Approval 仍只走专用 decision endpoint。

### 7.5 ToolExecution 诊断详情

```http
GET /api/v1/tool-executions/{toolExecutionId}
```

返回安全详情：

```json
{
  "toolExecutionId": "execution_opaque",
  "toolCallId": "call_opaque",
  "toolId": "workspace.write_file",
  "manifestVersion": "2",
  "phase": "verifying",
  "actionHash": "sha256-opaque",
  "operationSnapshotRef": "snapshot_opaque",
  "approvalRef": "approval_opaque",
  "resultRef": null,
  "evidenceRefs": [],
  "failure": null,
  "version": 9
}
```

内部状态可以覆盖 `proposed / claimed / preparing / awaiting_approval / ready / executing / verifying / succeeded / failed / rejected / cancelled / timed_out / outcome_unknown / reconciling`。`rejected` 表示用户明确拒绝；Approval 超时是独立 `expired` 事实。`cancelled / timed_out` 只有在确认活动停止且副作用未发生时才能闭合，否则进入 `outcome_unknown`。无论成功、拒绝、取消还是未知，Model protocol 都必须得到闭合 observation；详情 API 不返回秘密输入或原始凭据。

## 8. Capability Catalog

Catalog API 供 Frontend 浏览，也由 Backend 内部发现原语使用。模型不会直接通过 HTTP 调自己。

### 8.1 列目录

```http
GET /api/v1/capabilities?parentPath=/travel&cursor=<opaque>&limit=50
```

```json
{
  "parentPath": "/travel",
  "directories": [
    {
      "path": "/travel/train",
      "title": "火车",
      "capabilityCount": 12
    }
  ],
  "items": [
    {
      "capabilityId": "cap_opaque",
      "kind": "tool",
      "name": "query_ticket",
      "description": "查询指定日期和区间的火车票；需要实时班次时使用",
      "path": "/travel/train/query_ticket",
      "riskLevel": "read_only",
      "availability": "available"
    }
  ],
  "nextCursor": null
}
```

`kind`：

```text
tool | pipeline | guidance
```

### 8.2 搜索

```http
GET /api/v1/capabilities/search?q=整理网申&cursor=<opaque>&limit=20
```

结果只返回 discovery card，不返回完整 schema。排序不改变 Registry identity。

### 8.3 读取精确 Definition

```http
GET /api/v1/capabilities/{capabilityId}?version=3
```

响应按 `kind` 返回判别联合 `ToolManifest | PipelineDefinition | GuidanceDefinition`。Tool 示例：

```json
{
  "capabilityId": "cap_opaque",
  "kind": "tool",
  "manifest": {
    "id": "web.observe_page",
    "name": "observe_page",
    "version": "3",
    "capabilityPath": "/web/page/observe_page",
    "description": "读取当前页面的可访问状态；需要确认页面内容和可操作元素时使用",
    "inputSchema": {},
    "outputSchema": {},
    "riskLevel": "read_only",
    "sideEffectKind": "none",
    "approvalPolicy": "not_required",
    "idempotencyPolicy": "safe_repeat",
    "timeoutMs": 30000,
    "resultBudget": {
      "modelTokens": 4000,
      "uiBytes": 65536
    },
    "evidenceContract": {
      "kind": "page_state"
    }
  },
  "availability": {
    "status": "available",
    "missingPrerequisites": []
  }
}
```

敏感安全策略和 executor binding 可以只在 Backend Registry 中存在；对模型暴露的是完成调用所需的最小契约。

### 8.4 不存在公开 Tool 直调

Frontend 若要运行 Capability，首版只能创建带显式 `entrypoint.kind=pipeline_capability` 的 Turn。原子 Tool 没有公开直调入口；Backend 内部 tool node 仍创建 ToolCall/ToolExecution、走 Policy 和 SSE。

开发诊断若未来需要直调，只能在非产品 profile、回环接口和独立构建中存在，且仍调用 Tool Runtime，不能直接获得 Tool 实例。

### 8.5 Definition 生命周期与可用性

Catalog card 和 detail 还可以返回：

```json
{
  "definitionStatus": "active",
  "supersededBy": null,
  "bindingAvailability": {
    "status": "degraded",
    "missingPrerequisites": ["webbridge_daemon"],
    "checkedAt": "2026-07-24T18:30:00+08:00",
    "lastSeenAt": "2026-07-24T18:00:00+08:00"
  }
}
```

两条状态轴不能合并：

```text
definitionStatus: active | deprecated | retired
bindingAvailability.status: available | degraded | unavailable
```

provider 注册校验的 `accepted / rejected` 是本次提交结果，不是 Definition 长期状态。历史 ToolCall 引用的 Manifest version 即使 retired 也保持可读；新执行只能使用 Registry 当前明确允许的版本。Iris 客户端重启时只更新 binding availability，不因 provider 暂时未出现就删除 Definition 或历史。

### 8.6 模型能力工作集不是 Frontend 状态

Backend 内部的发现原语遵循分层响应：

```text
list/search → 轻量 card
inspect → 一个精确 version 的 Definition
activate → 只在有限 model attempt lease 中提供 Tool schema
```

每个 Context Frame 都有 schema token budget。批量 search/card 结果保存为 ContextFrame input/result Artifact 引用；只有精确 inspect 或 active schema 才产生不可变 `CapabilityExposure`。active lease 精确绑定：

```text
contextFrameId + modelStepId + modelAttemptId
+ capabilityId + manifestVersion + schemaHash
```

Agentic ToolCall 必须 durable link 对应 active-schema Exposure。新的 provider fallback attempt 使用新的 Context Frame/lease，旧 attempt 的迟到输出不得执行。重启时，已提交 ToolCall 使用 Exposure 和 pinned Manifest 恢复；binding 缺失闭合为 `capability_unavailable`，不得静默换版本。lease 不是权限，Runtime 仍重新检查 binding、schema、policy、Resource Claims 和 target version。

曾在早期 Round inspect 的 schema，不会因 SSE、ConversationView 或 Compact 自动永久驻留。Compact 不复制全部用过的 ID，只引用 source range、summary/facts 和少量 capability hints；后续需要时重新 discovery/inspect/activate。

Frontend 不提交 `loadedTools[]`，也不接收当前模型完整 schema working set。它可以浏览 Catalog，但浏览行为不会直接改变 Model Step 的 active lease。

## 9. Workspace 与 Artifact 读取

### 9.1 列目录

```http
GET /api/v1/workspace/entries?path=reports/&cursor=<opaque>&limit=100
```

只接受 workspace-relative logical path。绝对路径、UNC、device path、`..`、链接逃逸或无法验证的路径返回 `workspace_path_rejected`。

### 9.2 读取安全内容

```http
GET /api/v1/workspace/content?path=reports/week.md&startLine=1&lineCount=200
```

```json
{
  "path": "reports/week.md",
  "version": "sha256-opaque",
  "content": "...",
  "truncated": false,
  "nextStartLine": null
}
```

该 endpoint 是用户 UI 的只读浏览能力。模型读取仍通过 Tool Runtime 的 read-only Tool，以保留预算、审计和 Context shaping。

### 9.3 Artifact metadata

```http
GET /api/v1/artifacts/{artifactId}
```

```json
{
  "artifactId": "artifact_opaque",
  "name": "网申整理.xlsx",
  "kind": "spreadsheet",
  "size": 28421,
  "version": 2,
  "source": {
    "runId": "run_opaque",
    "toolExecutionId": "execution_opaque"
  },
  "visibility": ["user_timeline"],
  "previewRef": "/api/v1/artifacts/artifact_opaque/preview",
  "downloadRef": "/api/v1/artifacts/artifact_opaque/content"
}
```

Artifact 由 Runtime 验证并登记。Sandbox output 在导入 Workspace 前不是正式 Artifact。

### 9.4 写操作

首版不公开通用 `POST /workspace/write`。用户或 Agent 都通过 Capability/Turn 提交写意图，以得到 Checkpoint、差异预览、审批和 evidence。

## 10. SSE Conversation Event Stream

### 10.1 连接

```http
GET /api/v1/conversations/{conversationId}/events
Accept: text/event-stream
Last-Event-ID: evt_opaque
```

也允许首次连接使用 `?after=evt_opaque`，但 header 优先。Frontend 应使用支持响应状态和重连控制的 fetch-based SSE client，而不是依赖浏览器 `EventSource` 的隐式无限重试。

没有 cursor 时只推送连接后的新事件；正确水合顺序是：

1. `GET ConversationView`；
2. 读取其中 `eventCursor`；
3. 以 cursor 连接 SSE；
4. Backend 重放 cursor 之后的已持久化事件；
5. Frontend 按 event ID 去重。

快照与连接之间发生的事件不会丢失。

### 10.2 Event Envelope

每个 SSE frame：

```text
id: evt_opaque
event: render_node.updated
data: {...}
```

`data`：

```json
{
  "schemaVersion": 1,
  "eventId": "evt_opaque",
  "conversationId": "conv_opaque",
  "branchId": "branch_opaque_or_null",
  "turnId": "turn_opaque",
  "runId": "run_opaque",
  "parentRunId": null,
  "sequence": 184,
  "aggregate": {
    "kind": "run",
    "id": "run_opaque",
    "version": 8
  },
  "causationId": "command_or_event_opaque",
  "correlationId": "command_or_run_opaque",
  "occurredAt": "2026-07-24T18:30:02+08:00",
  "payload": {}
}
```

保证：

- `sequence` 在单 Conversation 内单调递增；
- `eventId` 同时是该 Conversation 的 opaque event cursor；
- event 先提交 SQLite 后可见；
- 重连可能重复，不会跳过已提交 event；
- stream 覆盖整棵 Conversation；`branchId` 帮助投影，但 Backend 不因当前 UI 选择而丢弃其他分支事件；
- `branchId / turnId / runId / parentRunId` 按事件作用域可为 null；Conversation metadata 或 projection 事件不伪造 Turn；
- 不保证多个 Conversation 间全局顺序；
- 心跳使用 SSE comment，不产生业务 event；
- 原始 provider delta、秘密和未清洗 Tool 输出不进入该 envelope。

### 10.3 事件族与 reducer 规则

除严格定义的文本 delta 外，事件一律携带**完整安全 View upsert**，不使用含糊 merge patch。Frontend 以实体 ID 和 `version` 替换；旧版本忽略，版本跳跃仍可接受，因为 View 是完整的。

| event | payload |
|---|---|
| `conversation.updated` | `{ "conversation": ConversationSummary }` |
| `turn.accepted / turn.updated` | `{ "turn": TurnView }` |
| `run.started / run.updated / run.settled` | `{ "run": RunView }`；settled 的 terminal phase 和 `failure?` 已在完整 View 中 |
| `round.started / round.updated` | `{ "round": RoundView }` |
| `render_node.added / render_node.updated / render_node.invalidated` | `{ "node": RenderNode }` |
| `render_node.delta` | §10.4 的唯一增量格式 |
| `attention.requested / attention.updated` | `{ "attention": AttentionView, "node": RenderNode }`；approval subtype 内嵌 `ApprovalView` |
| `supplement.updated` | `{ "supplement": SupplementView }` |
| `artifact.published` | `{ "artifact": ArtifactView }` |
| `branch.created` | `{ "branch": BranchSummary, "acceptance": TurnAcceptance }` |
| `compaction.started / completed / failed / cancelled` | `{ "compaction": CompactionView, "boundary": CompactBoundaryView? }` |
| `projection.invalidated` | `{ "reasonCode", "requiredProjectionVersion" }` |

ToolExecution 的全部内部状态不会一比一泄漏为 UI 事件。Projector 将其变成 `tool` 或 `attention` 节点；诊断详情通过有权限的 detail endpoint 按需读取。

Provider 只有在任何可见 delta 和 ToolCall 尚未提交前，才能透明重试。提交后若 attempt 失败，Backend 先持久化 attempt failure 和 `render_node.invalidated`，再创建新 attempt；不能把两次输出拼成同一条回答，更不能重复已经启动的 Tool。

Stream 覆盖整棵 Conversation，但当前 `ConversationView` 只含请求的 Branch。Frontend reducer 忽略其他 `branchId` 的 Branch-scoped 事件；切换 Branch 时重新 GET 对应 View。Conversation-level upsert 仍应用。这样隐藏 Branch 的旧 delta 不需要在当前 reducer 中拥有 base。

### 10.4 Delta 规则

`render_node.delta`：

```json
{
  "nodeId": "node_answer",
  "field": "content",
  "baseVersion": 6,
  "targetVersion": 7,
  "chunkSequence": 7,
  "append": "新的文本"
}
```

约束：

- 只允许白名单文本字段；
- `chunkSequence` 对 node/field 从 1 开始连续；
- 本地 node version 必须等于 `baseVersion`，应用后成为 `targetVersion`；
- 重复 chunk 忽略；
- 缺口、缺失 base node 或 version 不符时，Frontend 重新 GET 当前 Branch 的完整 ConversationView，不猜接，也不依赖不存在的 node detail endpoint；
- completed 的完整 `RenderNode` 带 `finalContentHash`；
- Frontend 可按 animation frame 合并 delta，但不能丢 chunk。

### 10.5 Cursor 与版本失效

连接建立前若 cursor 不属于该 Conversation、不可再解码或投影版本不兼容，返回：

```http
410 event_cursor_unavailable
```

并返回完整 Problem JSON 与重新读取 ConversationView 的安全提示。连接已经建立后若发生投影迁移，发送 `projection.invalidated` 后关闭连接。客户端重新水合，绝不能静默从“现在”继续。

### 10.6 断线不是取消

Frontend 关闭、网络断开或 SSE subscriber 被清理不会改变 Turn。只有显式 stop、预算终止、不可恢复错误或后端策略能改变 Run。

## 11. 典型 SSE 序列

### 11.1 Agentic 调 Pipeline，再执行写动作

```text
turn.accepted
run.started(kind=agentic)
round.started(index=1)
render_node.added(type=thinking)
render_node.updated(thinking=completed)
run.started(kind=pipeline,parentRunId=agentic)
render_node.added(type=run,childRunId=pipeline)
render_node.added(type=tool,status=preparing)
attention.requested(subtype=approval)
run.updated(blockers=[approval])
attention.updated(status=approved)
render_node.updated(type=tool,status=running)
render_node.updated(type=tool,status=verifying)
artifact.published
render_node.updated(type=tool,status=succeeded)
run.settled(kind=pipeline,phase=succeeded)
round.updated(phase=settled)
round.started(index=2)
render_node.added(type=answer,role=final)
render_node.delta(...)
render_node.updated(answer=completed)
run.settled(kind=agentic,phase=succeeded)
turn.updated(phase=settled)
```

SSE 顺序展示因果，但完整事实由 Message、Run、ToolExecution、Approval 和 Event 表保存。

### 11.2 Outcome unknown

```text
render_node.updated(tool=status:running)
render_node.updated(tool=status:outcome_unknown)
run.updated(phase=outcome_unknown)
attention.requested(subtype=manual_verification)
```

此时不得自动重发同一外部写。Reconcile 得到证据后再：

```text
render_node.updated(tool=status:succeeded|failed)
run.updated(...)
```

## 12. Error Contract

HTTP 拒绝、已接受后的异步失败和模型 observation 使用同一组 `code / category / recoveryAction / sideEffectOutcome`。HTTP 非成功响应：

```http
Content-Type: application/problem+json
```

```json
{
  "type": "https://iris.local/problems/approval-stale",
  "title": "批准的动作已经变化",
  "status": 412,
  "code": "approval_stale",
  "detail": "目标文件在批准后发生变化，请查看新的差异后再次确认。",
  "traceId": "trace_opaque",
  "category": "precondition",
  "requestReplay": "requires_new_command",
  "recoveryAction": "reprepare",
  "sideEffectOutcome": "not_started",
  "fieldErrors": [],
  "context": {
    "approvalId": "approval_opaque",
    "currentVersion": 2
  }
}
```

规则：

- `code` 稳定，Frontend 可以分派；
- `detail` 是可展示的人话，但不含密钥、SQL、绝对隐私路径或堆栈；
- `traceId` 仅用于本机日志关联；
- `requestReplay` 只描述当前 HTTP command：`safe_same_request | requires_new_command | forbidden`；它不能替代 Runtime 的恢复判断；
- 已接受 Turn 后发生的错误不再试图改写原 HTTP 响应，而是写入 `FailureView`，经完整 Run/Turn/RenderNode upsert 与 `run.settled` 投影；刷新后仍可读；
- 当 `sideEffectOutcome=may_have_applied` 时，唯一合法自动恢复是 `reconcile`，不能 `retry_same`；
- schema 验证错误用 `fieldErrors[{path,code,message}]`；
- provider 原始错误保存在安全诊断记录，只投影归一化错误。

建议机器码：

```text
invalid_request
idempotency_key_reused
stale_version
turn_not_active
supplement_already_injected
approval_stale
approval_already_decided
capability_unavailable
manifest_version_mismatch
workspace_path_rejected
workspace_version_conflict
external_component_unavailable
provider_rate_limited
outcome_unknown
projection_version_unsupported
```

## 13. Backend 与 WebBridge 私有契约

该 API 不暴露给 Frontend，只监听 `127.0.0.1`，每次请求携带 Backend 启动时协商的本机令牌。

首版最小原语：

```text
GET  /health
POST /sessions
POST /sessions/{sessionId}/observe
POST /sessions/{sessionId}/actions
POST /sessions/{sessionId}/takeover
DELETE /sessions/{sessionId}
```

`actions` 只接受单个或明确批次的浏览器原语，并冻结：

```text
toolExecutionId + actionAttemptId + idempotencyKey
+ expectedObservationRef + primitive + normalizedArgs
```

单动作结果至少为：

```text
applied | not_applied | outcome_unknown
+ newObservationRef? + evidenceRef?
```

响应丢失时，Backend 只能用同一 idempotency key 查询/重放 daemon 已知结果；不得生成新 attempt 再次点击提交。Daemon 无法证明是否生效就返回 `outcome_unknown`，由 Backend Runtime reconcile。长动作可用 daemon → Backend streaming response，但 Backend 必须先把进度转成持久化事件，再投影给 Frontend。

Daemon 不拥有：

- Conversation/Turn/Run；
- Pipeline Definition；
- Tool risk 或审批；
- 用户历史；
- 重试外部副作用的权力。

已录制浏览器过程属于 Backend 的 Pipeline Capability。Pipeline 中每个浏览器真实动作仍通过 Tool Runtime 和 WebBridge Connector；不存在 daemon 自己的 `/workflow/run` 产品真相。

## 14. 配置与秘密的边界

Frontend 可以读取不含秘密的 profile：

```http
GET /api/v1/settings/model-profiles
```

```json
{
  "items": [
    {
      "profileId": "profile_opaque",
      "displayName": "默认模型",
      "providerKind": "openai_compatible",
      "model": "model-name",
      "credentialState": "configured"
    }
  ]
}
```

不返回 `baseUrl` 中的秘密参数、API key 或凭据内容。

保存凭据属于明确的用户设置流程，Backend 写入本机秘密存储。该设置接口在产品化节点另行冻结；0.4 不假装 `PUT JSON {apiKey}` 已经解决安全存储。

## 15. Projection 与 Schema 演进

- 每个 View 有 `projectionVersion`；
- 每个 Event 有 `schemaVersion`；
- Backend 可以由 canonical facts 重建新 projection；
- Frontend 不永久维护 `legacyToRenderNodes()`；
- 不兼容时发 `projection.invalidated`，Frontend 重新 GET View；
- 迁移失败是显式可恢复错误，不允许静默丢弃旧 RenderNode；
- 大陆 2 实现契约时生成 OpenAPI，并对 JSON fixture 做前后端 contract test。

## 16. 安全检查表

每个 endpoint 合并前必须回答：

1. 它是否让 Frontend 绕过 Turn/Run/Tool Runtime？
2. 写命令能否被重放造成第二次副作用？
3. 身份、risk、approval 或 path 是否来自客户端自报？
4. 返回值是否可能包含 secret、绝对敏感路径或原始 Tool 输出？
5. SSE 断线后能否从持久化 cursor 恢复？
6. 事件是否有稳定因果 ID 和版本？
7. 错误是否把“请求失败”误写成“外部动作未发生”？
8. 这个 API 是产品必要能力，还是为了调试方便开出的永久旁路？

## 17. 0.4 契约验收

实现者应能只根据本文完成以下闭环：

```text
创建 Conversation
→ 读取某 Branch 的 ConversationView + cursor
→ 提交 User Turn
→ 通过 SSE 渲染 Agentic/Pipeline child Run
→ 提交 Supplement
→ 对精确 Operation Snapshot 批准或拒绝
→ 回答 clarification / manual verification / takeover Attention
→ 观察 Tool verification、Artifact 和最终 Answer
→ 已接受后的失败从 FailureView 与 run.settled 恢复
→ 断线后以 cursor 无损续传
→ 在旧 Message 创建新 Branch
→ 手动 Compact 而不删除历史
```

契约刻意没有提供原始 chat proxy、裸 Tool invoke、静默 Workspace write、万能 Run resume 或 daemon workflow shortcut。少几个方便接口，换来的是只有一个可恢复的产品真相。
