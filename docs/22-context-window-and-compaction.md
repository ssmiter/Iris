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

## 2. 预算

首版使用保守估算器，不伪装成 provider tokenizer。预算包含：

- system instruction；
- 本轮租用的工具 name / description / input schema；
- 当前视野内的 user / assistant / tool facts；
- 固定协议余量与输出保留量。

Provider Profile 后续可以替换为精确 tokenizer，但替换不改变 Planner 契约。预算和
估算结果写入 `model_context_snapshot`，便于定位 prompt-too-large 与调整误差系数。

## 3. 裁剪单位

Planner 从最新事实向前选择原子组：

- 普通 user/assistant text 是单独一组；
- ToolCall 与它唯一的 ToolResult 是同一组；
- 缺结果、孤立结果、重复结果是协议错误，不参与猜测；
- 最新用户请求是硬保留项，单独就超预算时显式返回 `prompt_too_large`。

被裁掉的事实仍保留在 canonical history。存在 CompactBoundary 时，后续将由经过验证
的 summary artifact 替代它覆盖的旧视野；边界本身不复制或删除原始历史。

## 4. 快照

`model_context_snapshot` 保存规范化请求事实、工具租约、估算值、预算和裁剪数量。
相同 hash 可安全复用；相同 hash 对应不同 payload 时 fail-close。快照不保存密钥、
Authorization header 或未清洗的 provider metadata。

快照中的每个租用工具形成一条不可变 Capability Exposure。模型提交 ToolCall 时必须
按 `context_hash + tool_name` 找到唯一 Exposure，并保存显式关联；未租用工具即使
Registry 中存在也不能执行。Lease 是模型可见性，不替代 Runtime 的审批与策略检查。

## 5. Prompt 过大

本地 Planner 已判定超限时不请求 Provider。Provider 仍返回 prompt-too-large 时，
旧 attempt 明确失败；调度器只能创建新的压缩/裁剪决策和新 attempt，不能修改旧
attempt 的 context hash 后原地重试。
