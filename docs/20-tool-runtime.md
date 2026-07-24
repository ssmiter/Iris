# 20 · Tool Runtime 与持久化审批

> 状态：大陆 2 / 节点 2.5 第一阶段已实现并通过统一验证
>
> 依赖：`docs/03-tool-platform.md`、`docs/13-backend-study.md`、
> `docs/18-turn-command-and-sse.md`

## 1. 为什么先于 2.3

路线图明确 2.3 的 Agentic Run/Round 依赖 2.5。模型解析出 `tool_use` 以后，
必须交给一个不会绕过审批、不会因客户端断线丢状态、不会把未知结果伪装成失败的
唯一 Runtime。否则先做 Loop 只会把旧的直接调用旁路固化进去。

## 2. 删除旧执行语义

现有原型存在四个不能进入正式内核的行为：

- `Tool` 直接暴露 `execute(args)`，没有不可变 prepare snapshot；
- 只有 elevated/destructive 等待审批，standard 写操作会直接执行；
- 审批存在内存 `CompletableFuture`，客户端或进程断开即丢失；
- 超时、拒绝和执行异常都压成字符串 error，无法恢复或核验外部结果。

节点 2.5 改为非阻塞、可恢复状态机：

```text
claim
→ validate exact manifest version
→ prepare
→ persist immutable operation snapshot
→ policy
  ├─ read_only → executing
  └─ any write → awaiting_approval
→ commit gate
→ execute
→ verify
→ succeeded | failed | outcome_unknown
```

## 3. Tool Definition 与绑定

`ToolManifest` 是版本化定义，不是随手拼出的前端 DTO，至少包含：

- `id / version / name / description`；
- 从 Java package 推导的 `capabilityPath`；
- input/output JSON Schema；
- `riskLevel / sideEffect`；
- timeout、result budget、idempotency 与 evidence policy。

本地 Tool 不声明 path。`ToolRegistry` 从 Spring bindings 构建
`id + version` 与 name 双索引，并在启动时验证：

- name 必须是 snake_case，description 非空；
- package 必须位于 `com.iris.tools.<domain>.<directory>`；
- schema 必须为 object 且每个属性有 description；
- read_only 必须声明 `sideEffect=none`；
- 任意写能力必须提供 prepare 后的人话 impact 与资源声明；
- 冲突的 identity、name 或完整 capability path 使该注册失败。

首版内置 provider 注册失败会阻止启动，避免系统“看起来有工具但实际不可调用”。
后续外部 provider 可隔离为 rejected registration，不拖垮其他 provider。

## 4. 持久化实体

### `tool_execution`

一次调用的 canonical identity 与状态：

```text
executionId, toolCallId, conversationId, turnId, runId, roundId,
toolId, toolVersion, capabilityPath, phase, inputHash,
snapshotId, approvalId, outcomeKind, errorCode, timestamps, version
```

同一 `toolCallId` 只能 claim 一次。重入先读原 execution，不重新执行。

### `operation_snapshot`

prepare 的不可变结果：

```text
snapshotId, executionId, manifestHash, normalizedInput,
impactStatement, affectedResources, targetVersions,
snapshotHash, expiresAt
```

批准的是 snapshot，不是会漂移的 Tool 名或 raw input。

### `approval_request`

```text
approvalId, executionId, snapshotHash, status,
impactStatement, riskLevel, expectedVersion,
createdAt, expiresAt, decidedAt, decisionBy
```

状态为 `waiting | approved | rejected | expired | invalidated`。
第一次合法终态决定获胜；批准后 Commit Gate 必须重新核验 snapshot hash、
版本与期限。

### `tool_evidence`

保存 verify 产生的安全证据引用与摘要；大结果和敏感原文进入 Artifact，
不塞进 Event 或模型上下文。

## 5. Runtime 返回值

调用 Runtime 不阻塞等待 UI：

- read_only 可在本次调度中执行并返回 terminal outcome；
- 写操作返回 `awaiting_approval + approvalId`；
- 批准命令只推进该 execution，拒绝/过期成为明确终态；
- 重启后扫描 `awaiting_approval` 可继续等待；
- `executing/verifying` 在进程中断后进入 reconciliation，不能盲目重试。

节点 2.3 只消费 Runtime outcome，不获得 Tool 实例。

## 6. 风险与审批不变量

- `read_only + sideEffect=none` 才能自动执行；
- standard、elevated、destructive 全部默认审批；
- 会话设置只能提高严格度，不能给写操作降级；
- impact 为空、资源为空、snapshot 不匹配或已过期一律 fail-close；
- 文件类资源必须是 workspace-relative logical path；
- 审批决议自身是写命令，使用 expected version 与 Idempotency-Key；
- destructive 首版即使批准，也可由 policy 标记为 unsupported。

## 7. 与 Conversation Event 的关系

Tool Runtime 提交状态后，投影为 Conversation Event：

```text
tool.execution.claimed
tool.execution.awaiting_approval
tool.execution.started
tool.execution.succeeded
tool.execution.failed
tool.execution.outcome_unknown
approval.resolved
```

审批同时产生 `attention_projection`。SSE 只发送安全投影，绝不发送秘密、
完整文件内容或未经清洗的工具输出。

## 8. 本节点实现边界

首轮实现：

- 版本化 Manifest、严格 Registry 与 package-derived path；
- input validator；
- durable claim / snapshot / approval / execution / verification；
- read_only 直通与所有写操作挂起；
- 幂等 resume 与明确 terminal/outcome_unknown；
- 一个工作区笔记工具迁移到新契约，证明路径围栏与审批不可绕过。

后续与 2.3 纵向接通时再加入：

- 模型 ToolCall → Runtime invocation adapter；
- Tool result observation 格式；
- Round/RenderNode/Attention 的完整 projector；
- 超时执行器与进程级取消协调。

## 9. 验证

- Registry 会拒绝缺字段、非法 name/path 与风险矛盾；
- read_only 工具无需审批，写工具永不直接执行；
- 相同 toolCall 重入不会产生第二个 execution；
- 重启后 waiting approval 仍可查询和决议；
- snapshot hash 或 expected version 不匹配时批准失败；
- approval 拒绝、过期、执行失败与 outcome unknown 不混淆；
- workspace 越界在 prepare 阶段 fail-close；
- 成功 execution 保存 outcome 与 evidence。
