# Runtime 对话投影

> 状态：大陆 2 / 节点 2.6 纵向接通中

## 1. 投影边界

ModelAttempt、ToolExecution、Approval 与瀑布流节点不是多套真相。模型、工具和审批表
保存 canonical facts；投影器只把当前可见、安全的状态写入 RenderNode / Attention，
供 ConversationView 水合与 SSE 增量消费。

ToolExecution、Approval 与瀑布流节点不是三套真相。Runtime 表保存执行事实，投影器把
安全子集写成 ToolNode / AttentionNode；SSE 与 ConversationView 只读取投影。

- 每个 ToolCall 最多一个 ToolNode；
- 每个 Approval 最多一个 AttentionNode；
- 等待审批时 ToolNode 保持验证/等待语义，同时创建就地 AttentionNode；
- 批准、拒绝、过期或执行终止后，原节点原位更新，不追加伪造的新调用；
- 投影只含人话影响、状态和稳定 ID，不含工具输入、密钥或原始 provider payload。

投影表可重建，`tool_execution` 与 `tool_approval_request` 才是 canonical facts。

### 1.1 工具详情按需读取

前后端不往返完整 Tool output：

- SSE 的 ToolNode 只携带 `toolExecutionId / toolName / status / summary /
  resultRef / evidenceSummary`，不发送结果正文；
- ConversationView 水合相同轻量投影，未展开的 Tool 卡片不会读取、解析或进入前端状态树；
- 用户展开结果时，Frontend 才通过 conversation-scoped detail endpoint 按字符窗口读取；
- 收起卡片后详情是可丢弃缓存，不写回 canonical ConversationView；
- 模型的 `read_tool_result` 直接访问 Backend payload store，与 Frontend 是否在线、是否
  展开完全无关。

Artifact、表格或图片以后可以声明专用 preview projection；默认仍是短摘要 + 稳定引用。
后端不能因为“前端可能会展示”而提前序列化和推送完整 payload。

## 2. Answer 流的节点身份

一次 ModelAttempt 的可见文本使用确定性节点 ID：

```text
node_answer_<attemptId>
```

- 第一个 text delta 创建 `streaming` AnswerNode；
- 后续 delta 只更新同一节点，并携带 `baseVersion / targetVersion / chunkSequence`；
- attempt 提交成功后，节点原位变为 `completed`，写入 `sourceMessageId`、内容 hash 与
  `role=stage|final`，同时把 `agent_round.answer_node_id` 指向它；
- provider 在第一个 delta 前失败时无需创建节点；已有 delta 后失败则删除临时投影并发出
  `render_node.invalidated`；
- provider 没有产生 delta、但最终事实含可见文本时，由完成投影器补建同语义节点。

流式节点不能在完成时另建第二个 AnswerNode。前端看到的增量节点就是最终水合节点，
断线重连不会出现“半条回答 + 一条完整回答”。

Provider 事件仍逐个进入 canonical assembler，但 UI 投影允许在很小的字符/时间窗口内
合并连续 text delta。合并只减少 SQLite 与 SSE 写放大，不改变最终文本、block 顺序或
attempt 完整性；attempt 结束前必须冲刷最后一段。任何 JDBC 投影不得阻塞 provider 的
网络事件线程。

## 3. 事件提交顺序

状态事实必须先提交，再追加安全事件：

```text
round.started
round.updated(model_streaming)
render_node.added / render_node.delta
round.updated(model_completed|awaiting_tools|completed)
render_node.updated(completed)
run.updated / run.settled
turn.updated
```

SSE 是唤醒与增量通道，不拥有状态。客户端发现事件版本不连续时重新读取
ConversationView；不得从残缺 delta 猜测完整答案。

## 4. 审批后的恢复

审批 HTTP 命令只负责提交一份绑定 snapshot hash 与 expected version 的决议。它不能把
“批准”直接解释成整轮成功：

1. Tool Runtime 接受首份合法决议并重新经过 Commit Gate；
2. 原 ToolNode 与 AttentionNode 原位更新；
3. 工具进入明确终态后形成 ToolObservation；
4. 若所属 Run 正处于 `suspended`，进程内 launcher 只发送一次恢复唤醒；
5. Run 从持久化 Round 继续，而不是复用原 HTTP 调用栈。

重复的同一 `Idempotency-Key` 返回既有决议结果；不同键竞争同一审批时只有第一份合法
决定获胜。客户端断线不影响审批事实，进程重启后仍可从 `awaiting_approval` 恢复。

## 5. 投影也是交互时序契约

前端的丝滑不能依赖猜测后端状态。每种可见实体都必须给出稳定 identity、单调 version
和明确的出生/变化/退场语义：

- Answer：`added → delta* → updated(completed)`，失败则 `invalidated`；
- Tool：同一 ToolCall 原位经历 waiting/running/verifying/terminal；
- Attention：`requested → updated(resolved|expired)`，不在决定瞬间删除；
- Supplement：排队先发 `supplement.updated(pending)` 供 Composer 显示 chip，真正进入
  模型上下文时原位变为 `injected`，并在瀑布流中增加位置稳定的 SupplementNode；
  该节点按普通用户追加消息渲染，不显示“已注入”状态卡；模型上下文同样只得到普通
  User Message，生命周期元数据不进入提示词；
- Run/Round/Turn：完整 View upsert 永远晚于对应事实提交。
- Stop：`turn.updated(stop.state=requested|draining)` 只表达停止进度；只有 Run、Round
  和必要 ToolExecution 安全闭合后，才发送 `turn.updated(phase=stopped,
  stop.state=completed)`。

前端可以对这些事件做克制的过渡动画，但不能自行发明业务终态。刷新后的
ConversationView 与实时事件必须得到同一节点 ID、顺序和最终内容。
