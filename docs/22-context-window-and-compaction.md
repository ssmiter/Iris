# Context Window 与压缩边界

> 状态：大陆 2 / 节点 2.4 第一阶段已实现并通过统一验证
>
> 依赖：`docs/19-conversation-history.md`、`docs/21-run-round-and-model-protocol.md`

## 1. 不变量

上下文裁剪只改变一次 ModelAttempt 的当前视野，不删除消息、模型 block、ToolCall、
ToolObservation 或分支事实。每次实际发送的上下文保存为不可变快照，并由
`model_attempt.context_hash` 精确引用。

工具定义仍来自本轮 schema lease。预算不足时只能减少历史视野，不能偷偷把全量能力
目录换成摘要，也不能拆开 `assistant tool call -> tool result`。

Tool output payload、Tool Observation 与 Context projection 是三层不同实体：payload
保存完整结果，Observation 保存当时实际回注模型的不可变内容，Context projection
决定某次 attempt 是否还能看见它。清理 projection 不能反向改写前两层。

## 2. 预算

首版使用保守估算器，不伪装成 provider tokenizer。预算包含：

- system instruction；
- 本轮租用的工具 name / description / input schema；
- 当前视野内的 user / assistant / tool facts；
- 固定协议余量与输出保留量。

Provider Profile 后续可以替换为精确 tokenizer，但替换不改变 Planner 契约。预算和
估算结果写入 `model_context_snapshot`，便于定位 prompt-too-large 与调整误差系数。

Capability lease 还有一个先于整个窗口规划的子预算。三个发现原语是 required
Definition，必须完整放入；它们自身超限时 fail-close。其余 Definition 只能来自本
Run 最近成功的 `read_capability`，按新近程度逐个准入，某个 Definition 过大时跳过
它并继续检查后续候选。快照 payload 同时记录 schema 预算、估算使用量和遗漏数量；
数量上限只约束候选查询成本，不能充当 schema 成本估算。

## 3. 裁剪单位

Planner 从最新事实向前选择原子组：

- 普通 user/assistant text 是单独一组；
- ToolCall 与它唯一的 ToolResult 是同一组；
- 缺结果、孤立结果、重复结果是协议错误，不参与猜测；
- 当前 Turn 的原始用户请求和已经注入的全部用户补充都是硬保留项；它们共同构成这次
  Agentic Run 的任务约束，不能因为某条补充更新而静默淘汰最初目标。
- 当前 Turn 中不可安全重取的 Tool Observation 及其 assistant ToolCall 轨迹也是硬保留
  项，包括写操作、审批、失败、`outcome_unknown` 和当前 Definition 已无法核验的结果；
  Planner 不能先拒绝 micro compact、随后又按普通旧事实把整组淘汰。
- 最新用户请求仍是兜底硬保留项。硬保留的当前 Turn 指令单独就超预算时显式返回
  `prompt_too_large`；当前 Turn 指令与不可重取证据共同超限时也一样，不能让模型在遗忘
  约束或外部影响的情况下继续执行。

被裁掉的事实仍保留在 canonical history。存在 CompactBoundary 时，后续将由经过验证
的 summary artifact 替代它覆盖的旧视野；边界本身不复制或删除原始历史。

### 3.1 Tool Observation 的两级收敛

- **结果预算**发生在 Tool 完成时：完整 payload 按 executionId 保存，Observation
  超预算时变成“预览 + hash + `tool-result://` 引用 + 读回方法”。
- **micro compact**发生在后续 attempt 组装时：只处理声明为可重取的 read/list/search
  等旧 Observation，保留工具名、输入摘要、executionId、payload hash 和结果状态。
- 最近若干个 Tool Observation 必须保留原文；数量和 token 水位由真实数据决定，
  不能把某个参考实现的常量写成产品真理。
- 写操作、`outcome_unknown`、审批、验证 evidence 与用户不可重新取得的外部返回，
  禁止自动 micro compact。
- 结果替换决策一旦进入某个 Context Frame 就被冻结；后续组装不得因当前总长度变化
  反复改写旧前缀。这样上下文行为可解释，也让 Provider prompt cache 有稳定前缀。

## 4. 快照

`model_context_snapshot` 保存规范化请求事实、工具租约、估算值、预算和裁剪数量。
相同 hash 可安全复用；相同 hash 对应不同 payload 时 fail-close。快照不保存密钥、
Authorization header 或未清洗的 provider metadata。

快照中的每个租用工具形成一条不可变 Capability Exposure。模型提交 ToolCall 时必须
按 `context_hash + tool_name` 找到唯一 Exposure，并保存显式关联；未租用工具即使
Registry 中存在也不能执行。Lease 是模型可见性，不替代 Runtime 的审批与策略检查。
Tool Runtime 还必须把该 Exposure 的 `tool_name + manifest_hash` 与当前 binding 精确
比对；Definition 已变化时旧 ToolCall fail-close，不能用新 schema 解释旧参数。

## 5. Prompt 过大

本地 Planner 已判定超限时不请求 Provider。Provider 仍返回 prompt-too-large 时，
旧 attempt 明确失败；调度器只能创建新的压缩/裁剪决策和新 attempt，不能修改旧
attempt 的 context hash 后原地重试。

## 6. 水位线与分支

CompactBoundary 的 `beforeTurnId` 对应一条不可变的
`turn.accepted.sequence`，该 sequence 就是分支当前的上下文水位线。水位线以下的
canonical history 仍完整保留，只在后续 ModelContext 中由 summary artifact 代替。
持久化时它不是孤立标记，而是一个 Context Frame：

```text
origin(frame, waterline=0)
  -> compact(frame, source=(0, 42), waterline=42)
  -> compact(frame, source=(42, 87), waterline=87)
```

每个新对话拥有一个空的 origin Frame。每次 Compact 都引用唯一 parent Frame，并把
source range 固定为 `(parent.waterline, current.waterline)`；Branch 保存创建瞬间选中的
base Frame。由此模型当前视野始终是：

```text
base Frame 的上下文 + base waterline 到目标位置的 canonical facts
```

- 同一条分支路径上的有效水位线只能向前推进，不能回退或重复。
- 创建子分支时，从 source Branch 的 Frame 链向上选择严格位于分叉锚点之前的最近
  Frame，并把它固定为子分支 head；不能选择覆盖了分叉点或其后事实的 Frame。
- 祖先分支在分叉点之后的水位线、Turn 和 summary 都不可泄露给子分支。
- 父分支在子分支创建后形成的新 Frame 不得追溯性改变子分支 head；历史重放必须稳定。
- 子分支可以在继承水位线之上继续 Compact；新 summary 的 source range 从上一条
  有效水位线开始，到新水位线结束，不能重复注入已覆盖事实。
- Compact 的 cutoff 必须是所选分支可见路径上的 Turn，并且覆盖区间内所有
  ModelAttempt、ToolCall 和 Run 都已闭合。
- `ConversationView`、历史分页、Compact cutoff 选择和 `ModelContextRepository`
  必须使用同一条递归 branch path 规则，不能各自推断“可见历史”。

因此 Branch 与 Compact 的组合不是复制摘要：它是“固定 Frame 链 + 分支可见路径 +
单调水位线”的确定性计算。创建分支、刷新页面或对话压缩都不能改变既有边界的
适用范围。

## 7. Compact Pipeline

手动 Compact 不接受 Frontend 指定 cutoff 或 summary。Backend 在 Conversation lock
内完成以下 Prepare：

1. 从当前 head 之后的已闭合可见 Turn 中选择水位线，并保留最近四个 Turn；
2. 冻结 `parent Frame summary + (parent waterline, new waterline)` 中的 canonical
   user、assistant、ToolCall 和 ToolObservation；
3. 保存带 content hash 的 `compaction_source_snapshot`；
4. 创建 `kind=pipeline` 的 Run、单个模型步骤和 `compaction_run` 投影；
5. 写入 `compaction.started` 后异步唤醒。

模型只能读取冻结快照，不得在 retry 或进程恢复时重新查询当前 ConversationView。
它不租用工具，只输出可持久化 Frame 正文。ModelAttempt、context hash、provider
identity 和 token 预算仍遵循普通模型协议。

成功提交 ModelAttempt 后，Run 进入 verifying；新 Context Frame、CompactBoundary、
branch head 推进和 Compaction Run completed 在同一事务中闭合，然后发送
`compaction.completed`。任何失败只产生 terminal failure，不写半截 Boundary，也不
改变旧 branch head。进程在 Provider stream 中断时保留 interrupted attempt，并把本次
Compact 标记失败；用户可用新的幂等命令重新开始。

## 8. 完整对话验证场景

实现阶段不以大量孤立测试替代真实体验。接入实际 Provider 后，按一条连续对话验证：

1. 连续完成至少八个 Turn，期间包含普通回答、只读 Tool、需审批 Tool、Supplement
   和一次 Stop，刷新后过程与最终状态仍一致；
2. 手动整理上下文，观察 `accepted/running/completed`、SSE Boundary 和页面水位线，
   并确认旧 Turn 仍可滚动查看；
3. 在新 Frame 后继续提问，核对 ModelContext 只含 Frame summary 与水位线后的事实；
4. 从水位线之后的旧提问创建分支，确认继承当前 Frame 加增量历史；
5. 从水位线之前创建分支，确认沿 parent 链回退到更早 Frame（最早退化为 origin）；
6. 父分支再次 Compact，确认既有子分支 head 不变；子分支 Compact 后形成自己的叶子；
7. 在 Provider stream 中断一次，确认旧 attempt 为 interrupted、Compact 失败、旧 head
   不动；重新发起后使用新的 Run/Attempt；
8. 最后在主线和两个子分支之间切换、刷新并继续对话，比较 UI 历史、水位线、
   source snapshot、context hash 和模型实际回答的一致性。

验证时 API key 只通过本地环境变量注入，不进入配置文件、事件、日志、快照或 Git。
