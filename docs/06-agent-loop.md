# 06 · 对话内核（Agent Loop）

> 对话循环是体验的心脏：轮次怎么切、补充怎么进、上下文怎么压缩、分支怎么长。
> 核心 Loop 只在 Java 后端；前端提交命令并渲染持久化事件投影。总体决策见 docs/02，正式 REST/SSE 契约见 docs/08。

## 1. 轮次模型（Turn → Run → Round / Pipeline Step）

- **Turn**：从一条用户消息开始，到下一用户消息之前的全部内容。
- **Run**：一次可恢复的求解过程；通常一个 Turn 有一个 root Agentic Run，也可以包含 Agentic/Pipeline child Run。
- **Round**：Agentic Run 中一轮“读取 Context → 模型输出 → 观察工具结果”。Pipeline 使用版本化 Step，不伪装成模型 Round。
- 渲染数据：**renderNodes**——thinking / tool / answer / attention / artifact / supplement / run 七类节点组成过程流；Round 与 Pipeline Step 的投影记录来源和统计。

```
Turn
└── Agentic Run
    ├── Round 1: thinking → tool(read) → tool(search)
    ├── child Pipeline Run: 固定检查 → tool(write) [审批]
    ├── Round 2: observation → thinking
    └── answer（最终回答）
```

Pipeline 与 Agentic 共用 Run、Tool Runtime、审批、证据和事件底座。Agentic 可以探索未知过程，经过多次验证和人工发布后沉淀 Pipeline；Pipeline 遇到声明外的未知分支，可以在安全边界创建有界 Agentic child Run。

### 1.1 用户澄清是可恢复的 Loop 边界

当 `ask_user` 被调用时，当前 Round 保持 `awaiting_tools`，ToolExecution 进入
`awaiting_input`，root Run 进入 `suspended`。用户选择不是新的任务消息，也不在前端内存中
临时拼接；它先以版本化 UserInputRequest 决议原工具调用，产生可观察的 Tool result，再由
Launcher 恢复同一 Run。这样审批、澄清和后续人工接管虽然有不同语义，却共享
“事实落盘 → Attention 投影 → 用户决议 → observation → 恢复”的运行骨架。

### 1.2 首个 child Agent 边界

首版 child Agent 只考虑隔离、可验证的单任务委派：父 Run 提交自包含任务、允许的窄工具
表面、预算和返回目标；子 Run 使用自己的 Context Frame，不继承父 Agent 的隐式思考，也
不再暴露递归委派工具。父子通过 Workspace/Artifact/Tool result/Task work state 等稳定引用
交换事实，子 Run 结束后只把有界结论与引用作为父 Run observation。共享完整上下文、动态

具体的同步/后台语义、durable mailbox 与 Pipeline 组合协议见 [28-pipeline-child-agent-and-async-runtime.md](28-pipeline-child-agent-and-async-runtime.md)。
组队、DAG、角色市场和自动状态 Agent 都不进入这一地基阶段；在隔离与返回契约没有兑现前，
不把 `agent` 暴露为可调用工具。

## 2. 补充注入（Supplement）——不打断的中途指令

用户运行中再输入，不是排队也不是打断：

1. 先以独立 `pending Supplement` 事实持久化，尚不创建 Message，避免上下文提前读到；
2. 在**下一个 loop 边界**（模型即将发起下一次调用前）创建普通 User Message 并注入上下文；
3. 视觉：composer 上方 chip 淡出，在对应 Round 位置出现与最初提问同层的用户消息气泡；
4. 若 turn 在边界前结束：补充自动作为新 turn 发出；
5. **手动停止 = 完全停止**：未注入的补充转为排队 chip（不自动发），无自动续跑——杜绝"停不下来"的死循环。

竞态规则：Supplement 注入只发生在 loop 边界的一个点，注入后清空 pending。Stop 命令则立即持久化并禁止创建新活动：运行中的模型/只读动作可合作取消，已经进入副作用的动作必须 verify 或闭合为 `OutcomeUnknown`。两者不能共用“只在边界生效”的语义。

## 3. 压缩线（Compact Lines）——历史不动，视野滑动

上下文接近上限时压缩，但**历史一个字都不删**：

- 压缩 = 生成 summary Artifact + 画一条线：`{ id, cutoffEventSequence, cutoffMessageId, sourceContextFrameId, summaryArtifactRef, factRefs, pipelineRunId, trigger }`；
- 线前的记录保持原样；线后的新对话，上下文装配 = 摘要 + 线后原文；
- ToolCall/Exposure/Resolution 已在 canonical history 保存 provenance；Boundary 不复制全部用过的 Capability；
- 压缩进度有细轨道进度条，完成"✓ 已压缩"短暂停留后淡出；
- 手动 `/compact` 与超长自动压缩同一语义。

## 4. 分支多叉树（Branch Tree）

任何用户消息可编辑重发，长出分叉：

```
                      ┌─ 变体1（原始提问）─ 后续...
锚点用户消息 ─────────┼─ 变体2（改问法A）─ 后续...
                      └─ 变体3（改问法B）─ 后续...
```

- **BranchAnchor**：`{ anchorId, anchorText, variants[], active }`；变体保存完整尾部事实与稳定引用（含 Run、renderNodes、工具结构——不裁剪，切换无损，但不要求物理深拷贝）；
- 同一锚点最多 5 个变体（快照体积约束）；
- 气泡下 ‹ 2/5 › 切换；切换只改变历史视野，工作区恢复是独立、可预览、受审批的写动作；
- **key 恒为首个变体的锚点消息 id**——从非首变体上再编辑时按变体 anchorMsgId 找回真锚点（否则会长出"永远只有 2 个分支"的伪锚点）。

## 5. 压缩 × 分支的统一：位置语义

两者交汇处是最容易出 bug 的地方，规则只有一条：

> **在哪个位置分叉，就用那个位置该用的上下文。**

- 分叉点（稳定 message/event sequence）在压缩线后 → 该轮压缩摘要有效；
- 分叉点在线前 → 落回更早的线（或第 0 条线 = 无压缩，全原始上下文）；
- 多轮压缩 = 多条线，选"切点早于最早分叉点"的最新一条；
- 判定函数唯一：`selectActiveBoundary(messages, boundaries, branches)`，装配、分隔线渲染、token 估算三处共用。

## 6. 系统提示组装

分层注入（优先级从高到低）：

1. identity（你是谁/行为准则）
2. **有界 Catalog snapshot**：epoch/hash + 少量顶层目录 + 恒定发现原语 + 禁令（docs/03 §6）
3. 工作区说明（路径围栏、产物机制）
4. 当前上下文状态（压缩摘要、激活的项目/技能）
5. 用户记忆（`/remember` 关键词检索注入）

完整领域 Tool schema 不属于永久系统提示，也不因发现结果动态改写 Provider tools 数组。
每个 Model attempt 只暴露有界常驻原语与稳定 `invoke_capability`；非驻留 ToolCall 必须链接
代理 Exposure、当前 Run 已读取的精确 Definition observation，以及 Runtime 冻结的真实
binding resolution。CompactBoundary 只保留 source range、summary/fact refs 和少量未来
求解 hints，不把曾读过的 schema 提升为永久系统能力。

用户附件属于 User Message 的 canonical fact，但附件正文不常驻模型上下文。上下文只携带
稳定 Artifact 引用、名称、类型、大小和哈希；Agent 需要观察时分窗读取，需要批处理时把
引用直接传给对应 Runtime。分支和压缩保存引用而不是复制内容，因此同一事实可以贯穿
对话、工具执行、工作区检查点、成果发布与后续轮次。

稳定的工具元认知提示只负责四件事：建立“结果必须来自客观 observation”的事实观，
说明目录/搜索/读取 Definition 的发现循环，说明工作区、结果对象与计算等平台如何组合，
以及根据结构化 `effect + recovery.action` 处理失败和止损。它不罗列全量工具，不写某个
业务域的临时 SOP，也不提前承诺尚未接通的 SQL、沙箱或浏览器环境。Catalog 摘要只含
Definition hash 与顶层目录计数；Definition 未变化时，系统提示前缀保持逐字节稳定。

## 7. 持久化

| 数据 | 位置 | 说明 |
|---|---|---|
| Message / Turn / Run / Round / ToolCall | 后端 SQLite | canonical facts，结构完整 |
| Task Definition / Task Work State | 后端 SQLite | 任务目标与中间状态分别版本化；压缩只改变视野，不改写二者 |
| RenderNode / ConversationView | 后端 SQLite | 可迁移重建的持久化投影 |
| 分支 / 压缩边界 / Context Frame | 后端 SQLite | 只改变历史或模型视野，不删除原事实 |
| 检查点 | Managed Object Store + SQLite | 不可变原文对象 + 结构化 metadata |
| 展开 / 滚动 / 草稿 | 前端 View State | 可丢弃、可重建，不是历史真相 |

SQLite 事务先提交事实和事件，再由 SSE 投影。前端刷新从 ConversationView 的 event cursor 续传；IndexedDB/localStorage 不能成为分支、压缩或审批的唯一来源。

## 8. 长程任务的 harness 工作记忆

长程任务不能依赖模型在回答里不断复述最初要求，也不能把 HTML、脚本或 TODO 文本当作
任务真相。首版把四层对象明确分开：

```text
Task Definition   用户目标、稳定约束、完成标准；不可变版本
Task Work State   阶段、步骤、阻塞项、Evidence/Artifact 引用；不可变版本
Model Narrative   思考说明和中间回复；属于对话历史，不驱动状态机
User Artifact     HTML、Excel、脚本、报告；属于工作区，可由事实重新生成
```

每个对话分支的 `task_head` 只指向该分支当前可见的 Definition 和 Work State 版本。模型
通过有界的任务状态原语创建、读取和提交新状态；更新必须携带
`expected_state_version`，并发或过期上下文不能覆盖新事实。分叉时，Backend 按 fork
event 水位线复制当时可见的状态头；两个分支随后独立推进，不能读到对方的“未来进度”。
旧版本永久保留，因此暂停、恢复、Compact 和后续多 Agent 协作都不依赖某一段模型文本。

### 动态工作状态不是聊天历史

每次 `ModelContextAssembler` 在规范分支事实之后追加三个有界、代码维护的状态对象：

- active Task work state：目标、步骤、阻塞项和 Evidence/Artifact 引用；
- explicitly published Artifact context index：只含冻结成果的元数据与 `artifact://`
  引用，不含正文；
- Capability runtime state：当前常驻 Provider 工具表面中降级能力的限制原因与检查时间；
- Runtime pulse：当前 Run 的轮次、工具调用和时间预算水位。

它们都位于动态区，不污染稳定 System Prompt；Window Planner 把它们视为当前决策所需
状态。工具大结果仍以 `tool-result://executionId` 留在不可变对象仓，模型按窗口观察，
Python 等 Backend runtime 可以按引用直接消费完整字节。这样上下文裁剪改变“当前看见
什么”，不会改变事实、成果或工作状态本身。

任务状态是 harness 的控制平面，不是外部世界写操作：它无需用户审批，但仍经过 Tool
Runtime、Operation Snapshot、版本前置条件和 verify。浏览器 Observation、数据库查询和
用户文件仍是数据平面；账本只保存稳定引用与有界摘要，不复制网页全文、长脚本或 Artifact
payload。Python 或其他受限计算环境以后只消费显式输入、产出 staged Artifact，不能成为
任务状态的唯一存储。

单 Agent、双 Agent 和 Pipeline 都只是 harness 的执行拓扑。若某个场景适合把偏好归纳与
行动决策隔离，两个角色读取同一版本化 Task Definition，并通过 Work State/Evidence 交换
结构化结果；它们不共享隐式“记忆”，也不能各自改写一份目标。

Task Ledger 一旦被当前 Run 主动创建或更新，就参与一次有界的收尾一致性检查：模型返回
无 ToolCall 的答案，但该 Ledger head 仍是 `active` 时，Backend 把这段回答保留为 stage，
并最多追加一个 Round，明确要求模型继续完成，或把状态如实改成 blocked/paused/completed。
这不是让代码判断开放目标是否真正完成，也不扫描用户措辞猜“是否需要写操作”；没有在
当前 Run 使用 Ledger 的短对话完全不受影响。一次提醒后仍无行动则正常收尾，避免 readiness
机制自身形成昂贵循环。

### 8.1 Runtime Pulse 不是任务状态

每个 Round 在模型上下文末端加入一条由 Backend 计算的有界 Runtime Pulse：

```text
round index
tool calls used / limit
elapsed time / time limit
observed time / local time zone / host platform
active capability schemas
omitted capability candidates
recent tool calls / failures / outcome unknown
latest phase / latest error code / same-input same-failure count
```

最近工具活动按最后执行时间有界选择，不把整个 Catalog 统计塞入上下文。它回答“这一轮
执行已经走了多远、哪条路径正在重复碰壁、还剩多少客观预算”，不保存任务语义，也不由模型维护。
累计调用、失败和结果未知数量只是历史水位；路径纠偏只能读取全局最近活动的最新终态。
旧失败之后已经成功，或相同输入曾经成功调用多次，都不能被投影成“当前仍在重复失败”。
Task Work State 记录目标推进；Runtime Pulse 记录执行水位。两者分开可以避免模型为了
更新计数反复改写账本，也避免把动态计数放进稳定 System Prompt 破坏前缀缓存。Pulse
固定在该 Model Attempt snapshot 中；它提供节奏感，但不把预算耗尽机械等同于任务完成。

## 9. 防死循环红线

- 手动停止不触发任何自动发送；
- 自动压缩失败后退避，不立即重试；
- Runtime 根据稳定 failure code、`recoveryAction` 和 `sideEffectOutcome` 决定 `retry_same / reprepare / rediscover / reconcile / user_input / none`；不能用“同类错误三次”覆盖副作用语义；
- 预算同时限制重复 code、相同资源和无进展 observation，熔断结果作为结构化 Failure 回注；
- 审批超时 = `expired`，不是用户 `rejected`，且不静默重发。
- 模型因单次输出上限中止时，由内核在新 Round 中有界续接；截断内容保留为 stage，
  最多自动续接 4 次，不把半截回答误判为 Turn 已完成。
