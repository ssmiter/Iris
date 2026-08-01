# 21 · Run / Round 与模型协议边界

> 状态：大陆 2 / 节点 2.3 第一阶段已实现并通过统一验证
>
> 依赖：`docs/18-turn-command-and-sse.md`、`docs/20-tool-runtime.md`

## 1. 参考切片后的判断

本轮只针对模型流、工具调用配对和循环边界回看 Claude Code、WonWork 与
ragent-lab：

- Claude Code 证明一次模型响应是按 block 交织的流，`stop_reason` 晚于
  content block；工具结果进入下一次模型 attempt，而不是直接当最终答案；
- Claude Code 的压缩会主动保护 `tool_use ↔ tool_result` 配对，说明配对关系
  必须是 canonical fact，不能只靠临时消息数组；
- WonWork 的流式兼容层暴露了真实 provider 差异：arguments 可能是增量、累计值、
  重复片段或残缺 JSON；解析失败必须显式失败，不能静默替换为 `{}`；
- ragent-lab 的同步 `while(true)` 适合解释最小循环，但把网络等待、工具执行和
  状态存在调用栈里，不满足 Iris 的中断恢复与并行 Attention 需求。

Iris 因此采用“持久化状态机驱动下一步”，而不是让一个长期 Java 调用栈拥有真相。

## 2. 概念边界

- **Turn**：一次用户请求的完整生命周期；
- **Run**：可独立暂停、恢复、核验和产出结果的执行边界；
- **Round**：Agentic Run 中的一次 `model attempt → actions → observations`；
- **ModelAttempt**：一次精确 provider/model/context/resident tool surface 请求；
- **ToolCall**：模型提出的行动意图；
- **ToolExecution**：Tool Runtime 对该意图的一次 durable execution；
- **ToolObservation**：回注下一次 ModelAttempt 的安全结果。

Pipeline child Run 复用 Run 边界，但没有 Agentic Round；本节点不设计通用 DSL。

## 3. 状态机

### Run

```text
accepted → running
running ↔ suspended
running → verifying
verifying → succeeded | failed | outcome_unknown
accepted/running/suspended → cancelled
```

终态不可回退。`outcome_unknown` 只能通过新的 reconciliation command 产生后续事实，
不能静默改成 succeeded/failed。

`verifying` 首先是协议闭合门，不是默认再调用一次 Reviewer 模型。Tool 的客观
postcondition 已在各自 Runtime 内验证；Run 收尾只确认 ToolCall/Execution/Observation
已经闭合，并与用户 Supplement 共用 conversation lock。若用户补充先到达，当前回答保留
为一段已完成的 assistant 事实，Run 打开下一 Round 注入补充；若终止先提交，后到的补充
明确拒绝并让前端作为新 Turn 发送。不得把 pending Supplement 留在已结束 Turn 上。

开放任务是否真正满足用户目标不能由一个通用 `succeeded` 状态臆测。可机械验证的场景
应把验证放在对应工具或领域环境内；内容质量需要独立模态时再按场景引入 Reviewer。
Run succeeded 只表示本次 Harness 轨迹正常闭合，不等价于所有现实目标都客观达成。

### Round

```text
accepted
→ model_streaming
→ model_completed
  ├─ no actions → completed
  └─ tool calls → awaiting_tools
       ├─ waiting approval → awaiting_tools
       ├─ all terminal → observations_ready
       └─ unrecoverable protocol error → failed
→ next Round
```

Round index 在同一 Agentic Run 内单调递增。`agent_round` 的唯一约束
`(run_id, round_index)` 是最终防线。

## 4. canonical model protocol

Provider 要求续接的内部状态（例如 OpenAI-compatible 的
`reasoning_content`）属于 assistant 轨迹的协议事实，不是给用户展示的
thinking 节点。Adapter 必须把它作为不可见 `provider_state` block 原样交给内核；
内核随 ModelAttempt 持久化，并且只在相同 provider profile 与 model 上重放。
一次 assistant 响应中的 provider state、text、全部 tool call 及其 tool result 是
上下文裁剪的一个原子组：保留就完整保留，丢弃就完整丢弃，禁止压缩出一个协议上
残缺的工具轨迹。切换 profile/model 时丢弃旧的模型绑定状态，但不删除历史事实。

Provider adapter 只能输出以下内部事件：

```text
message_started
block_started(index, kind, providerBlockId?)
block_delta(index, text | arguments fragment)
block_completed(index)
message_completed(stopReason, usage)
stream_failed(category, retryability)
```

Block kind 首版为 `thinking | text | tool_call`。Adapter 保留 provider call ID，
但内部 identity 使用 attempt + block index，避免无 ID 或重复 ID 破坏顺序。

完整 ToolCall 只有在 block completed 后形成：

```text
toolCallId, providerCallId, name, argumentsJson, argumentsHash, ordinal
```

arguments 规则：

- 同一片段若是累计值，替换旧值；
- 明确增量才追加；
- 完整 block 结束后只接受一个 JSON object；
- 缺参数、残缺 JSON、重复 ID、name 漂移均形成 protocol failure；
- 永不从残片“猜一个看起来像的对象”，也不静默回退 `{}`。

## 5. attempt 完整性

一个 attempt 只有同时满足以下条件才可提交为 completed：

1. 收到 message start；
2. 所有已开始 block 都 completed；
3. 收到 message completed 与 stop reason；
4. 所有 tool_call arguments 可解析；
5. usage 与 provider metadata 已冻结；
6. content/tool calls/stop reason 在同一 transaction 落库。

网络断开时已展示的 delta 可以作为 transient projection，但不是已提交事实。
恢复时重新发起新的 attempt；旧 attempt 标记 interrupted，不把两次流拼成一条。

### 5.1 有界重试

Provider 重试发生在 ModelAttempt 边界，不发生在字节流内部：

- 只有 Provider 明确标记 `retryable` 的临时错误与本地 provider timeout 可重试；
- protocol、认证、请求拒绝、prompt-too-large 与用户 Stop 不重试；
- 同一 Round 首版最多创建 3 个 Attempt，每次都有独立 `attempt_id / index / phase /
  error_category`；
- 旧 Attempt 先持久化失败；已展示的半截 Answer 追加
  `render_node.invalidated`，新 Attempt 使用新的节点，绝不拼接；
- 重试复用旧 Attempt 已冻结的 `context_hash + capability_lease_hash + ModelRequest`
  内容，只替换 attempt identity，避免重试期间重新发现能力或改变用户视野；
- 重试前由 Harness 执行短暂的指数退避与有界抖动；若 Provider 返回
  `Retry-After`，在交互预算允许时优先采用该值。等待超过 10 秒不再藏在一次
  对话里自动执行，而是尽快以可诊断失败结束，避免前端长时间假死；
- 退避等待不是不可中断的 sleep：进程内取消信号或持久化 StopRequest 到达后，
  当前 Attempt 直接闭合为 cancelled，不再创建后继 Attempt；
- 中间失败只进入 Attempt 事实和运行状态投影，不作为一条新的模型 Observation，
  也不要求模型决定是否重试；只有恢复预算耗尽后的错误才上升到 Run；
- ToolCall 只有 Attempt 完整提交后才成为 canonical fact，因此流阶段失败不会启动工具；
  一旦 Attempt 已提交，任何后续投影或工具错误都不得走 Provider 重试；
- 多 Provider fallback 以后也必须遵循同一 Attempt 隔离，但只有显式配置的 route
  才能切换 profile；首版不把任意可用模型当作隐式 fallback。

### 5.2 输出上限续接

`stop_reason = max_tokens` 不是失败，也不是一次完整回答。内核按以下规则续接：

- 当前 Attempt 仍完整提交，已经产生的 assistant text 是 canonical fact，不丢弃、
  不与下一次流拼成同一 Attempt；
- 当前 Round 以 stage 结束，Run 打开下一 Round，而不是误报 succeeded；
- 内核在下一轮上下文中派生一个不可见的 continuation directive，要求模型从中止处
  继续且不复述；它不是用户 Message，也不进入用户历史；
- 被截断的 assistant 轨迹与 directive 是一个上下文原子组，裁剪时共同保留或共同
  拒绝，避免模型只看到“继续”却看不到要续接的内容；
- 单个 Run 最多自动续接 4 次。达到上限时以明确的 budget failure 结束，保留全部
  已生成内容，避免无限输出和不可控成本；
- `content_filter`、未知 stop reason 等不得伪装成正常完成，必须形成协议失败。

## 6. Tool 配对

每个 ToolCall 恰好关联一个 ToolExecution，并最终形成一个 ToolObservation：

```text
tool_call.provider_call_id
↕
tool_execution.tool_call_id
↕
tool_observation.tool_call_id
```

等待审批时 Round 不伪造 `tool_result`；Run 通过 Attention 暂停对应分支。
只有 Runtime terminal 后才创建 observation。`outcome_unknown` 也必须形成明确的
error observation，告诉模型“结果未知，不得自动重试”。

上下文裁剪不得从 tool observation 前切断它对应的 assistant tool call。

## 7. Provider adapter

首版 port：

```java
interface ModelProvider {
    Flux<ModelStreamEvent> stream(ModelRequest request);
}
```

Adapter 负责协议差异与秘密注入；Agentic kernel 不读取 API key、不判断 OpenAI 或
Anthropic JSON 字段。Provider profile 由后端配置选择：

- Anthropic Messages；
- OpenAI-compatible（包含智谱等显式配置 profile）。

“兼容”不是让前端提交任意 base URL。每个 profile 冻结 provider kind、base URL
允许列表、model、timeout 与 credential reference。

## 8. 持久化

新增事实：

```text
model_attempt
model_content_block
model_tool_call
tool_observation
```

原始 provider 流和 thinking 原文默认不持久化到安全 projection。需要审计的
provider metadata 先清洗再存；秘密与 header 永不入库。

### 8.1 Stop 的双层取消

StopRequest 是持久事实，进程内 `RunCancellationRegistry` 只是低延迟加速器：

- 活跃 provider Flux 订阅取消信号，迟到 delta 不得越过 attempt commit；
- 被取消的 streaming attempt 闭合为 `user_cancelled`，对应 Round 进入 `stopped`；
- registry 丢失时，启动恢复仍从 StopRequest 重建，不把内存 signal 当成真相；
- ToolContext 暴露的是对 `RunCancellationRegistry` 的实时读取，而不是 Round 开始时
  复制出的 boolean；长文件扫描会在自身检查点及时停止；
- 尚未执行的 ToolCall 形成可审计失败 observation；已进入 execute/verify 的动作继续
  核验，StopRequest 暂处 `draining`；
- 正常完成、失败或停止后清理进程内 registry，不在 Reactor 终结回调中执行 JDBC。

### 8.2 同一 Round 的 ToolCall 调度

模型一次响应可能产生多个 ToolCall。Iris 按 ordinal 切成若干连续批次：

```text
[parallel_safe read, parallel_safe search] → 并行、有界
[serial write]                             → 单独执行，形成屏障
[parallel_safe read, parallel_safe read]   → 下一并行批
```

并行批只并发执行 Tool Runtime invocation；结果随后按 ordinal 依次形成 projection 和
ToolObservation。这样磁盘等待可以重叠，但 provider 协议配对、Conversation 历史和
下一次模型视野仍完全确定。任何 Manifest 缺失、调度判定异常或未来动态判定不明确都
fail-close 为串行。

## 9. 首轮实现边界

本轮先实现：

- Run/Round transition guard；
- canonical stream assembler；
- OpenAI-compatible 与 Anthropic 事件映射所需的稳定内部类型；
- attempt/block/tool call/observation schema；
- Tool arguments 完整性校验与配对规则；
- response model identity、stop reason、tool block 与 ToolCall ordinal 必须与
  当前 attempt 精确一致，任何漂移都在写入 block/tool fact 前 fail-close；
- Tool Runtime terminal outcome → observation 格式。

随后再接真实 provider HTTP stream 与 Round scheduler。这样先固定可测试的协议和
事实边界，不用真实 API key 驱动内核设计。

## 10. 验证

- text/thinking/tool_call 交织仍按 block index 稳定提交；
- 增量与累计 arguments 都得到同一 JSON；
- 残缺 JSON、name 漂移、重复完成与缺 stop reason 明确失败；
- attempt 中断不会提交半个 ToolCall；
- Run/Round 非法状态跳转被拒绝；
- ToolCall、ToolExecution、ToolObservation 一一配对；
- `outcome_unknown` observation 明确禁止自动重试。

## 11. 请求上下文与协调边界

模型请求不接收前端传入的 `baseUrl`、密钥或任意模型名。后端的 Provider
Profile 冻结 provider 实现与 model id；Agentic 内核只按 profile id 选择。

每次请求由以下持久化事实重新装配：

- 当前分支的用户消息；
- 已完成 attempt 的 assistant text 与 tool call；
- 与 tool call 一一配对的 tool observation；
- 本轮明确租用的工具定义。

工具租约只包含发现阶段选中的工具，不把全量能力目录塞入上下文。上下文和租约分别
计算稳定 hash，并写入 `model_attempt`。Provider 只消费不可变 `ModelRequest`，
只能返回 `ModelStreamEvent`。

`AgenticRoundCoordinator` 负责一个 Round 的可恢复推进：

```text
accepted -> assemble context -> begin attempt -> provider stream -> commit
awaiting_tools -> ToolRuntime -> terminal observations -> completed
```

等待审批不是错误，也不伪造 observation；再次推进同一 Round 时复用同一个
toolCall/execution。处于不明确中间态的 Round 不猜测继续，而由恢复器显式终止旧
attempt，保留事实后再决定是否创建新 Round。进程丢失时，`streaming` attempt 先
持久化为 `interrupted`；对应半截 Answer projection 与在线流失败采用同一失效
语义：历史 delta/event 仍保留，但当前投影被删除并追加 `render_node.invalidated`，
不能在水合后伪装成一条失败但可阅读的模型答案。

完成 Round 会把已提交的可见 text block 投影成 AnswerNode：含工具调用的是可选
stage answer，无工具调用的是必需的 final answer。答案同时保存对应 assistant
message；final answer 发布后才能把 Run/Turn 标成成功。投影可重入：崩溃恢复时若
`answer_node_id` 已存在，只复用既有节点，不复制答案。

## 12. Run 闭合账本与 Task Outcome

`Run.phase` 只描述 Harness 是否正常推进到终态，不直接声明用户在现实世界中的目标
已经达成。每个终态 Agentic Run 必须形成一条不可变的 `run_closure_ledger`，记录
收尾时可由内核客观计算的事实：

- Round、ModelAttempt、ToolCall、ToolExecution 与 ToolObservation 数量；
- ToolExecution 中 succeeded、failed、outcome_unknown、rejected、expired 的数量；
- 未配对 ToolCall、非终态 ToolExecution、缺少 Observation 的终态执行数量；
- Tool evidence、Artifact、final Answer 是否存在；
- 最后一轮模型 stop reason、Run 终止原因与记录时间。

账本的 `execution_status` 只有三种语义：

- `closed`：协议轨迹完整闭合，可以安全结束本次 Harness；
- `interrupted`：用户停止、依赖失败或预算边界导致执行中断，已有事实仍保留；
- `uncertain`：收尾时仍存在无法证明闭合的协议事实，不得伪装成 succeeded。

`task_outcome` 首版保持 `not_assessed`。Task head 可以记录 `completed` 或 `blocked`
工作状态，但不能直接升级为现实目标的 Outcome：步骤关闭且 Evidence/Artifact 引用
真实存在，只能证明工作记录结构闭合，尚不能证明每条完成标准已经被相应验证器满足。
后续只有建立“完成标准—领域验证器—Evidence”的明确绑定后，才能投影
`fulfilled | blocked | uncertain`。不得用一次通用 Reviewer 调用猜测。

正常收尾时，final Answer 先成为 canonical fact，然后 Run 在同一持久化事务内完成
`running -> verifying -> succeeded | outcome_unknown` 和账本写入。只要存在未配对
调用、非终态执行、缺失 Observation 或缺失 final Answer，闭合门就进入
`outcome_unknown`。历史上已经失败、但随后被模型观察和处理过的工具执行不会阻止
协议闭合，它们仍作为账本事实供后续 Task Outcome 判断。

## 13. 代码维护的 RuntimePulse

每轮模型请求末尾追加一个有界的 RuntimePulse。它不是对历史的替代，也不由模型
总结，而是由 canonical ToolExecution 事实确定性计算：

- Run/Round 水位、工具调用与时间预算；
- 当前观测时间、本地时区和宿主平台；
- 最近活跃工具的调用数、失败数、outcome_unknown 数；
- 每个工具最新一次 execution 的 phase 和 errorCode；
- 当最新 execution 失败时，同一输入、同一 phase、同一 errorCode 的历史出现次数。

RuntimePulse 只承担“仪表盘”职责：帮助模型立即看见重复碰壁、剩余预算和异常结果，
原始 ToolCall/Observation 仍保留并可回溯。活动条目有固定上限，按最近执行时间选择，
避免把全量工具统计变成新的上下文负担。累计计数与当前状态严格分开：旧 errorCode
不能穿过一次后续成功继续冒充最新错误；成功的幂等读取重复也不能与另一笔失败拼成
“相同输入重复失败”。只有全局最近的工具活动仍以同输入同错误失败，才触发换路提示。

稳定 System Prompt 负责解释读数对应的行动策略：相同输入重复失败时先重新观察或换
路径，outcome_unknown 先核对真实状态，预算接近边界时优先交付已确认结果并明确缺口。
动态 RuntimePulse 只追加当前读数，不修改稳定前缀，也不宣称任务已经完成。
