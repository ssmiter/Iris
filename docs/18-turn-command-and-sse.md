# 18 · Turn Command 与 Conversation SSE

> 状态：大陆 2 / 节点 2.1 已实现并通过统一验证
>
> 依赖：`docs/06-agent-loop.md`、`docs/08-api-contract.md`、`docs/13-backend-study.md`

## 1. 节点目标

建立后端第一条持久化主链：

```text
HTTP Turn Command
→ SQLite transaction
→ Conversation / Message / Turn / root Run / Event
→ commit
→ in-process event signal
→ Conversation SSE replay + live tail
```

本节点不调用模型、不执行工具、不生成假回答。root Run 保持 `running`，节点 2.3 接入 Agentic Loop 后消费它。

## 2. 删除旧旁路

删除 `/api/chat/proxy`。它允许 Frontend 提交 provider、baseUrl、messages 和 tools，并直接消费上游 delta，违反：

- Loop 只在后端；
- API key 与 provider 配置不由客户端自报；
- Turn/Run/Message/Event 必须先持久化；
- Frontend 只消费安全投影；
- 断线不能等于取消或历史丢失。

后续模型适配器是 Backend 内部 port，不再开放 raw chat proxy。

## 3. 首版 endpoint

```text
POST /api/v1/conversations
POST /api/v1/conversations/{conversationId}/turns
GET  /api/v1/conversations/{conversationId}/events
```

创建 Conversation 是让 Turn endpoint 可独立走通所需的最小前置能力，不扩展列表、重命名或分支 API。

## 4. 原子事实

接受自然语言 Turn 的同一 SQLite transaction 写入：

1. user Message；
2. Turn，phase=`active`；
3. root Agentic Run，phase=`running`；
4. `turn.accepted` Event；
5. `run.started` Event；
6. idempotency response record。

任意一步失败，全部回滚。事件只有 commit 后才通知 SSE hub。

`turn.accepted` cursor 返回给 POST caller；随后以该 cursor 连接 SSE，可以读到同 transaction 中更晚的 `run.started`，不会错过。

## 5. 幂等

幂等域：

```text
conversationId + endpoint + Idempotency-Key
```

保存 canonical request hash 与完整 acceptance response：

- 同 key + 同 body：返回原 acceptance，不创建第二个 Turn；
- 同 key + 不同 body：`409 idempotency_key_reused`；
- `clientRequestId` 只关联 UI 乐观项，不替代 HTTP 幂等键。

单进程首版使用固定数量的 striped locks 串行化同一 Conversation 的 sequence 与命令写入；SQLite unique constraints 仍是最终防线。锁数量固定，不按 Conversation 无限增长。

## 6. Event Store

`conversation_event` 使用 `(conversation_id, sequence)` 主键：

- sequence 在单 Conversation 单调递增；
- eventId 是 opaque cursor，服务端通过表查询解析，不要求客户端理解；
- payload 保存完整安全 View upsert；
- envelope 字段单独存储必要索引，读取时重建；
- provider 原始 delta、秘密和未清洗工具输出禁止进入。

SQLite 是 canonical source，内存 hub 只发“新事件已提交”信号。

## 7. SSE 无缝交接

连接算法：

1. 先订阅该 Conversation 的 commit signal；
2. 再读取数据库 watermark；
3. 从 cursor 后回放到 watermark；
4. 将回放期间进入内存队列且 sequence 大于 watermark 的事件按序排出；
5. 进入 live tail；
6. 重复 sequence 去重。

这样不依赖“先查数据库还是先订阅”的竞态运气。断开只释放 subscriber，不改变 Turn/Run。

无 cursor 时，watermark 之前的事件不回放，只接收连接建立后的新事件。未知或属于其他 Conversation 的 cursor 返回 `410 event_cursor_unavailable`。

心跳使用 SSE comment，不写业务 Event。

## 8. 阻塞边界

项目使用 WebFlux，但 SQLite/JDBC 是阻塞式：

- Controller 与 SSE 入口返回 Reactor 类型；
- 所有 JDBC 工作在 `boundedElastic`；
- transaction 内不调用模型、网络或长任务；
- commit 后才 emit 内存信号；
- 不把 JDBC 放到 Netty event loop。

## 9. 首版表

节点 2.1 只建立：

```text
conversation
conversation_branch
message
conversation_turn
agent_run
conversation_event
idempotency_record
```

节点 2.2 再扩展完整历史读模型、分页、projection 与迁移策略。schema 使用 `CREATE TABLE IF NOT EXISTS`，不在本节点引入第二个数据库或消息中间件。

## 10. 包边界

```text
com.iris.conversation
├── api
├── application
├── domain
└── infrastructure
```

- api：HTTP/SSE transport；
- application：command、transaction、stream handoff；
- domain：稳定 DTO 与事件语义；
- infrastructure：SQLite repository 与内存 commit hub。

## 11. 验证

节点 2.1 与 2.2 在同一轮完成以下验证：

- 相同幂等键只创建一个 Turn；
- 不同 body 重用 key 返回 409；
- transaction 中 Message/Turn/Run/Event 要么全有要么全无；
- cursor replay 顺序稳定，无重复；
- 无 cursor 不回放旧历史；
- cursor 不属于 Conversation 返回 410；
- SSE 断开不改变 Run；
- JDBC 不运行在 event loop；
- application context 能在临时 SQLite 文件启动。

验证命令：

```bash
cd backend
./mvnw test
```

2026-07-24 验证结果：Java 21 编译通过，Spring Boot context 使用临时 SQLite
文件启动成功；幂等创建与 Turn、Message/Run/Event 原子落库、cursor replay
顺序及历史视图链路均通过集成测试。SQLite 仅使用 `spring-jdbc` +
`JdbcClient`，不引入需要额外方言层的 Spring Data JDBC。
