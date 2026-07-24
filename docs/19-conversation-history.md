# 19 · Conversation History 与读模型

> 状态：大陆 2 / 节点 2.2 已实现并通过统一验证
>
> 依赖：`docs/08-api-contract.md`、`docs/18-turn-command-and-sse.md`

## 1. 目标

在 2.1 的命令/Event Store 上补齐可恢复的 Conversation 工作集：

- Conversation 列表与稳定分页；
- 指定 Branch 的 `ConversationView`；
- title metadata 乐观并发更新；
- Message attachment、Run definition snapshot、Round 与 RenderNode projection 表；
- 读模型与 `eventCursor` 在同一只读 transaction 中取得。

历史事实永不由 Frontend localStorage 代替。

## 2. 读模型不是数据库实体外泄

`ConversationView` 由 Query Repository 装配：

```text
Conversation + Branch
→ page of Turn
→ related Run / Round / RenderNode
→ CompactBoundary / Attention projection
→ latest committed event cursor
```

只返回安全 View。SQLite rowid、内部 SQL、原始 provider payload 与秘密不进入响应。

## 3. 分页

- Conversation 列表按 `updatedAt DESC, conversationId DESC`；
- cursor 是服务端可解析的已有 Conversation ID，客户端不理解其排序值；
- Turn 页按 `turn.accepted` Event sequence，而不是相同毫秒的时间戳；
- `beforeTurnId` 必须属于当前 Conversation + Branch，否则返回明确错误；
- page 最大 100，默认 50。

## 4. Metadata 更新

`PATCH /api/v1/conversations/{id}`：

- 必须携带 `Idempotency-Key`；
- body 携带 `expectedVersion + title`；
- version 不同返回 `409 stale_version`；
- 成功时更新 metadata、递增 Conversation version，并持久化 `conversation.updated` Event；
- 同 key 同 body返回原响应；不同 body 返回 `idempotency_key_reused`。

标题更新不创建用户 Turn，也不启动模型。未来标题生成 Pipeline 复用同一 metadata command。

## 5. 新增持久化结构

```text
message_attachment
run_definition_snapshot
agent_round
render_node_projection
compact_boundary
attention_projection
```

RenderNode 的公共索引字段独立保存，安全联合类型 body 保存 JSON。更新采用完整 projection version 替换，不做含糊 merge patch。

## 6. 一致性

- POST 命令 transaction 写 canonical facts + Event；
- GET view 使用 read-only transaction；
- `eventCursor` 取 transaction 视野内最新 Event；
- Frontend 先 GET view，再从 cursor 订阅；
- 普通 SSE delta 不递增 Conversation metadata version；
- Message/Branch/title 结构变化递增 version。

## 7. 当前边界

节点 2.2 不实现：

- 模型 Round 生成；
- renderNode projector；
- Branch create；
- Compact command；
- Attention command。

但表与 View 容器先存在，2.3–2.6 只需写事实和 projection，不推翻 API 数据形状。

## 8. 验证

2026-07-24 与节点 2.1 统一验证：

- Spring context 可在独立临时 SQLite 文件启动，schema 初始化成功；
- 同幂等键重复创建 Conversation、Turn 与 rename 均返回原响应；
- 不同请求重用幂等键返回 `409`；
- ConversationView 恢复 Turn、附件、root Run、version 与最新 event cursor；
- 从 `turn.accepted` cursor 重放时，下一条稳定为 `run.started`；
- title 乐观版本更新、列表摘要与活动 Turn 统计一致。

测试数据库和 Maven 依赖缓存只存在于被 Git 忽略的构建目录，不接触用户的
默认 `~/.iris.db`。
