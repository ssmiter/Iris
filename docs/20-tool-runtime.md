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

### `tool_output_payload`、Object 与 Observation

Tool 成功返回后产生两份用途不同、但来源唯一的数据：

```text
canonical output bytes（完整、不可变、按内容 hash 保存）
                 ↓ SQL 记录 executionId → objectRef
                 ↓ 有界投影
tool observation（预览、尺寸、稳定引用、继续读取方法）
```

- Runtime 必须先把完整 output 原子写入 Managed Object Store，再在同一 SQL 事务中
  保存 payload metadata、完成 ToolExecution 并生成 Observation；
  `resultCharacterLimit`
  只限制 Observation，绝不能改写 canonical payload。
- 超预算 Observation 带 `tool-result://<executionId>` 稳定引用、原始字符数和
  小预览。模型可发现 `/system/context/read_tool_result` 后按字符窗口继续读取。
- `tool_output_payload` 只保存 `executionId、objectRef、mediaType、hash、byteCount、
  characterCount`；原始 JSON 不进入 SQL。它属于对话执行历史，不伪装成用户工作区
  文件；canonical identity 仍是 executionId。
- 按字符读取由对象仓以 UTF-8 Reader 流式跳过和读取，内存只保留请求窗口；首版
  深分页是 O(offset)，真实负载证明需要时再增加稀疏字符索引，不提前制造索引系统。
- micro compact 可以清除旧 Observation 的大段预览，只保留 executionId、工具名、
  结果 hash 和读回指引；完整 payload 与 `tool_observation` 历史记录都不得删除。
- 普通 compact summary 只改变 Context Frame，必须引用 source execution/message
  range；不能用摘要覆盖 `tool_execution`、payload 或原始消息。
- 敏感结果是否允许落盘必须在 Tool 执行前由授权策略决定，不能先完整保存再依靠
  Observation 脱敏补救。

## 5. Runtime 返回值

调用 Runtime 不阻塞等待 UI：

- read_only 可在本次调度中执行并返回 terminal outcome；
- 写操作返回 `awaiting_approval + approvalId`；
- 批准命令只推进该 execution，拒绝/过期成为明确终态；
- 重启后扫描 `awaiting_approval` 可继续等待；
- `executing/verifying` 在进程中断后进入 reconciliation，不能盲目重试。

节点 2.3 只消费 Runtime outcome，不获得 Tool 实例。

### 5.1 Tool 的调度语义也是契约

Tool 不能只声明“做什么”，还必须声明调度器怎样安全地运行它：

```text
concurrency: serial | parallel_safe
cancellation: cooperative | commit_boundary
```

- `parallel_safe` 首版只允许 `read_only + sideEffect=none`，表示同一模型响应中相邻的
  同类调用可以并行；未知、校验失败或未声明一律按 `serial`；
- 调度器只合并**连续**的 parallel-safe ToolCall，遇到 serial ToolCall 形成屏障，
  不跨越模型给出的 ordinal 猜测依赖；
- 并行执行可以乱序完成，但 ToolObservation、投影和下一轮模型输入必须按原
  ToolCall ordinal 稳定提交；
- `cooperative` Tool 在扫描、读取和等待边界重复读取实时 cancellation signal；
  不能把开始执行时的布尔快照当作取消状态；Manifest timeout 也汇入同一实时信号，
  审批恢复时重新开始执行期限，不把用户等待审批的时间算成工具运行；
- `commit_boundary` Tool 只允许在副作用提交前取消。进入 execute/verify 后继续核验，
  无法确认时闭合为 `OutcomeUnknown`，不能为了响应 Stop 而假装没有执行。

这不是性能开关。它把“哪些动作彼此独立、什么时候还能安全停止”从调度器猜测提升为
Capability Definition 的一部分。首版最大只读并发数有界，避免模型一次生成大量调用
压垮 SQLite、磁盘或 provider。

### 5.2 人工接管不是长时间阻塞的 execute

浏览器登录、验证码、密码输入和人工核验需要暂停某一次 ToolExecution，但不能让 Java
线程、HTTP 请求或 daemon action 一直等待。它们使用通用持久 Attention：

```text
execute 到达明确暂停点
→ Runtime 持久化 suspended operation + Attention(pending)
→ ToolExecution phase=awaiting_attention（非终态）
→ Round 保持 awaiting_tools，Run launcher 退出当前推进
→ 用户提交类型化 Attention response
→ Runtime 以同一 execution/snapshot 恢复
→ 重新检查 Runtime/Session/Page 与 expected Observation
→ resume/verify
→ succeeded | failed | outcome_unknown
```

约束：

- Tool 不能自己创建任意 UI JSON；它只返回版本化 `AttentionRequest`，Runtime 负责身份、
  状态和投影；
- `AttentionRequest` 包含 subtype、impact、允许的 response kinds、安全 payload、期限和
  resume contract，不包含密码、验证码或 daemon token；
- response 使用 expectedVersion + Idempotency-Key；通用 `/runs/{id}/resume` 仍不存在；
- takeover 的“已完成”只是用户声明，不是动作成功证据。恢复后必须重新观察页面；旧
  Observation/element ref 一律失效；
- 等待期间 Session 可以过期或 daemon 可以重启。恢复时明确返回 session expired 并让
  Agent 重新规划，不能重造旧 handle；
- Approval 与 Takeover 都投影为 Attention，但状态机不同：批准允许进入 Commit Gate，
  takeover response 允许同一 execution 从暂停点继续，二者不能共用一个 approved 布尔值。

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
- 进程级强制终止留给隔离 Runner；内核不以“返回超时”掩盖仍在后台运行的线程。

## 9. 验证

- Registry 会拒绝缺字段、非法 name/path 与风险矛盾；
- read_only 工具无需审批，写工具永不直接执行；
- 相同 toolCall 重入不会产生第二个 execution；
- 重启后 waiting approval 仍可查询和决议；
- snapshot hash 或 expected version 不匹配时批准失败；
- approval 拒绝、过期、执行失败与 outcome unknown 不混淆；
- workspace 越界在 prepare 阶段 fail-close；
- 成功 execution 保存 outcome 与 evidence。
- 完整 Tool output 与有界 Observation 分离；任何截断都可通过 executionId 读回。

## 10. Observation 的稳定引用

ToolExecution、完整结果、Evidence 和模型看到的 ToolObservation 必须连成同一条可回溯
引用链。每条 terminal Observation 至少携带：

- `executionId`；存在可重取结果正文时同时携带 `tool-result://{executionId}`；
- 有界的 output 或错误、effect、recovery；
- Runtime 已持久化 Evidence 的 `evidence://{evidenceId}`、kind、reference 与短摘要。

`tool-result://` 是完整工具结果的数据平面入口：模型可把 executionId 交给
`read_tool_result`、`query_tool_result` 或 Python staged input，正文不需要经过对话
上下文复制。`evidence://` 是验证事实的稳定标识，可进入 Task work state 和 Run
closure；Evidence 的 `reference` 只是它所指向的文件、页面、Checkpoint 或领域对象，
不能替代 Evidence 自身身份。

Observation 只返回当前 conversation 可访问的引用；Task 标记完成前，Runtime 必须核验
提交的 Evidence/Artifact 引用真实存在且属于当前 conversation/branch。字符串长得像
引用，不构成完成证据。
