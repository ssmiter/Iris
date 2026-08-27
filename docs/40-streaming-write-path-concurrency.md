# 40 · 流式写路径并发模型：消灭 BUSY_SNAPSHOT（设计稿）

> 状态：**已落地**（2026-08-27：IMMEDIATE 全局生效、`SqliteBusyRetry` 接入
> ModelAttemptService 7 个事务点 + AnswerStreamProjector.complete、
> category()/failureCode() 存储分类修正 + storage_busy 人话文案；
> 129 测试 0 失败、历史遗留基线不变）。
> 起因：2026-08-27 事故 trace_3f——流式回答中 SQLiteException
> `[SQLITE_BUSY_SNAPSHOT]` 被误分类为 `provider_stream_failed`，
> 升级 `round_advance_failed`，运行被打死（「Iris 没能安全完成这次任务」）。
> 用户裁决（同日）：**把逻辑写对是第一位的**——并发模型修到这类错误没有
> 产生的土壤；降级/保险丝只是物理故障的兜底，不是工作机制。
> 与 [37 §2.5](37-capability-room-and-app-shell.md) 无关；本稿是任务 #13
> （后端流式写路径结构优化）的事故驱动前置篇，写放大/单事务合并仍在 #13 排队。

## 1. 根因（已用 DB 记录 + 代码双重证实）

- 全库**没有任何 `@Transactional`**，事务全部是编程式 `TransactionTemplate`
  + 自动装配的 `DataSourceTransactionManager`；xerial 默认
  `transaction_mode=DEFERRED`，配置里没改。
- DEFERRED 事务「先读后写」是 BUSY_SNAPSHOT 的标准形态：连接 A SELECT
  （开读快照）→ 连接 B 提交写入 → A 升级写锁时快照过期。
  `busy_timeout` 对它无效（同事务内重试必然再失败）。
- 流式期间的并发写者（Hikari 池 4 连接随机取用，无专用连接）：
  流线程（projection autocommit + appender 事务）、投机工具线程
  （ToolRuntime 多事务）、生命周期事件、其他 run/会话的写。
  三把进程内分段锁（ConversationLocks / ModelAttemptService / ToolRuntime）
  互不相干，挡不住跨连接的交错。
- 带整事务重试的只有 `ConversationEventAppender`（×2，粒度正确）；
  **`ModelAttemptService` 全部事务与 `AnswerStreamProjector.complete`
  是裸的先读后写**——事故的直击点。
- 误分类链：DB 异常从 `doOnNext` 下游以原始 DataAccessException 到达
  `handleAttemptFailure` → `category()` 兜底 `provider_stream_failed`
  → `failureCode()` 兜底 `round_advance_failed`；只有逃逸到
  `AgentRunLauncher.failUnexpected` 才有 isBusy → `runtime_storage_busy` 的
  正确映射。

## 2. 修复层次（按用户裁决排序：先把逻辑写对）

### 2.1 根因修复：写事务全局 IMMEDIATE（配置级）

`application.yml` 的 `data-source-properties` 增加 `transaction_mode: IMMEDIATE`：
所有事务 BEGIN 即拿写锁（xerial 驱动级支持），事务内**不可能**再出现快照过期；
锁竞争集中在 BEGIN 点，由既有的 `busy_timeout: 5000` 正常排队等待——
等待是可重试的 BUSY，不是不可重试的 BUSY_SNAPSHOT。

- WAL 下读完全不受影响（读不拿写锁）；本应用写事务都很短，
  全局串行化写者的吞吐损失可忽略。
- DLP 透明加密放大的 I/O 延迟会拉长写锁持有时间，上线后观察；
  若成为瓶颈再演进到单写者执行器（方案 C，本稿不做）。
- `SqliteContention.isBusy` 补注释说明 BUSY_SNAPSHOT 的消息形态
  （既有子串匹配已覆盖，无需改代码）。

### 2.2 裸事务补整事务重试

把 appender 的「整事务回滚重试」模式推广到流式链路的关键裸事务
（重试粒度是整个事务，不是语句——快照过期后必须重新 SELECT）：

- `ModelAttemptService`：begin / commit / fail / cancel 等事务点
- `AnswerStreamProjector.complete` 的事务
- 抽共享工具 `com.iris.storage.SqliteBusyRetry`（复制 appender 既有模式，
  ×2 退避 50/100ms，仅 isBusy 重试，其他异常直接抛）。

IMMEDIATE 之后这些是第二道防线（BEGIN 等锁超 5s 的极端情形），
不是主机制。

### 2.3 分类修正：存储故障不再伪装成 provider 故障

- `AgenticRoundCoordinator.category()`：开头加 `SqliteContention.isBusy`
  分支 → `storage_busy`；`retryable()` 同样识别（存储 busy 可重试）。
- `AgenticRunCoordinator.failureCode()`：加 isBusy → `runtime_storage_busy`，
  不再逃逸到 launcher 才被识别。
- 效果：同类事故以后在 DB 里一眼可辨（category=storage_busy），
  不再污染 `model_attempt_failure_detail` 的 provider 统计。

### 2.4 保险丝（仅物理故障兜底，理论上不触发）

存储错误不应杀死健康的模型流——这是事故里最荒谬的一点，但**它是保险丝，
不是设计目标**。本期只做最小动作：分类修正后 `runtime_storage_busy` 走
`recovery_action=retry_same`（既有映射），用户可从当前任务继续。
「落盘降级缓冲、settle 补写」等机制性降级**不做**——掩盖配置/并发错误
会让根因永远修不好；只有 2.1–2.3 全部落地后仍复现，才回头评估。

## 3. 不做（防反悔）

- 不做单写者执行器/专用写连接（方案 C）：改动面全库 Service/Repository，
  IMMEDIATE + busy_timeout 已覆盖故障面，过度工程。
- 不动 projection 写放大与「projection UPDATE 与 event append 同事务」——
  那是 #13 的结构优化，本稿只消灭锁故障类。
- 不引入 AOP/@Transactional 改造：编程式事务现状一致性好，不造第二套。

## 4. 验收标准

1. `application.yml` 带 `transaction_mode: IMMEDIATE` 且启动后生效
   （日志可见 profile 注册正常，无驱动告警）；
2. `ModelAttemptService` / `AnswerStreamProjector.complete` 事务走
   `SqliteBusyRetry`，重试仅命中 isBusy；
3. `category()` / `failureCode()` 对 SQLite busy 输出 storage 系分类，
   不再出现 `provider_stream_failed` + `SQLiteException` 的组合记录；
4. 后端全量测试通过（基线 129 测试 + 唯一历史遗留 error 不变）；
5. 真实对话复跑 trace_3f 场景（流式 + 投机工具并发）不再失败。
