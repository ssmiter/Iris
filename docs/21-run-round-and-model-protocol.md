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
- **ModelAttempt**：一次精确 provider/model/context/schema lease 请求；
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

## 9. 首轮实现边界

本轮先实现：

- Run/Round transition guard；
- canonical stream assembler；
- OpenAI-compatible 与 Anthropic 事件映射所需的稳定内部类型；
- attempt/block/tool call/observation schema；
- Tool arguments 完整性校验与配对规则；
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
attempt，保留事实后再决定是否创建新 Round。

完成 Round 会把已提交的可见 text block 投影成 AnswerNode：含工具调用的是可选
stage answer，无工具调用的是必需的 final answer。答案同时保存对应 assistant
message；final answer 发布后才能把 Run/Turn 标成成功。投影可重入：崩溃恢复时若
`answer_node_id` 已存在，只复用既有节点，不复制答案。
