# 33 · 后台执行：定时调度与运行可视化

> 状态：全部落地（M6a cron 后端、M6b 子 agent 前端投影、M6c cron 管理
> UI + Pipeline 运行记录）。回答"后台执行如何可管理、可视化"。
> 实现顺序：M6a 后端 cron → M6b 子 agent 前端投影 → M6c cron 管理
> UI + Pipeline 运行记录。

## 1. 问题：三类后台执行，三种不可见

Iris 的执行内核（docs/28）已经能异步做很多事，但用户全部看不见：

| 后台执行 | 后端现状 | 前端现状 |
|---|---|---|
| 定时任务 | **不存在**（全后端无一处调度） | — |
| 子 agent Run | 完整（durable Run + mailbox + 终态事件） | **零投影**（数据已到 `runsById`，无渲染） |
| 代码定义 Pipeline | 已在能力树可寻址（kind=pipeline） | 无运行记录视图 |

WonWork 的对应能力可借鉴但有明确弱点：cron 调度由前端 `setTimeout`
驱动（关页面即死）；子 agent 视图造了独立渲染器。Iris 的两个超越点：
调度真相放后端（Iris 是常驻进程，这本就是它的职责）；子 run 视图复用
现有对话读模型与时间线组件。

## 2. Cron：持久真相 + 进程内唤醒器

与 `AgentRunLauncher` 同一哲学——**SQLite 是真相，定时器只是唤醒**：

```
cron_task        持久真相：id / name / expression / prompt /
                 enabled / next_fire_at / created_from
cron_execution   每次触发一行：task_id / fired_at /
                 conversation_id / run_id / status
```

- 表达式解析用 Spring 自带的 `CronExpression`，不引 Quartz 或新中间件。
- 进程内唤醒器 `CronScheduleLauncher`（ApplicationRunner，类比
  `AgentRunLauncher`）只维护一个指向最近 `next_fire_at` 的定时器；
  每次触发或任务变更后重算。启动时补扫：已到期的启用任务立即触发
  一次并正常排下一棒——durable 真相的意义就是进程重启不丢任务。
- **到点行为（首版只有一种 payload）**：以 prompt 创建**新会话 + root
  Run**（`ConversationCommandService` 既有路径，来源标记
  `created_from = cron:<taskId>`）。标题 Pipeline 会自动为它起名；
  执行结果天然是可查看的会话，不需要第二套结果存储。
- **审批不变量无人值守也成立**：cron 拉起的 Run 遇到写工具照常挂起
  等审批；suspended 不消耗执行预算（docs/30 §4）。用户回来后批准
  即继续。这是制度性保障，不是缺陷。
- **模型侧工具**挂在 `/system/schedule`（docs/03 登记新域）：
  `create_schedule` / `set_schedule_enabled` / `delete_schedule` /
  `run_schedule_now` 均为写操作，走标准审批；读取不造工具——schedule
  作为目录叶子被 `list_capabilities` / `read_capability` 发现。
- **单次任务（docs/34 M8c）**：`once=true` + 精确到点的六位 cron 表达
  "明早 8 点提醒一次"。计划触发认领后自动停用；启动补扫时已过期的单次
  任务直接停用、不补跑。旧库经 `SchemaColumnMigration` 守卫迁移。

## 3. Cron 是能力树的第七种叶子

kind=schedule，DB 真相（与 kernel_skill、手工 MCP 连接器同类）：

- 目录投影（`ScheduleCatalogSource`）：`/system/schedule/<taskId>` 每
  个**启用**任务一个叶子；manifest 含 expression/prompt/next_fire_at/
  fire_count，availabilityReason 带下次触发时刻。停用任务不进模型视野
  （发现纪律：不会触发的东西不占用探索注意力），管理页经
  `/api/v1/schedules` 看全部——树投影与管理真相各看各的口径。
- 写路径回到自己的真相源：管理动作（新建/启停/删除/立即运行/查看
  结果会话）在统一能力页的 schedule 子视图与详情内完成，沿用
  McpConsole/MemoryConsole 的既有模式，不新增顶层导航。
- 这一叶子的落地即 goal 的验证点：执行类对象（定时任务）能否与工具、
  MCP、skill、文件一样被组织进目录。答案成立的话，Pipeline 运行记录
  （§5）是第二个证据。

## 4. 子 agent 前端投影：数据已齐，只做渲染

关键事实：child Run 与父共享 conversation/branch/turn，
`ConversationQueryRepository` 的投影按 turn 加载**全部** Run 与
Round；SSE 的 `run.started/updated/settled` 也已进入 `runsById`。
因此本里程碑**不新增后端 API**，纯粹把已有事实渲染出来：

- **嵌套节点**：主时间线中 `delegate_task` 的工具卡可展开，内嵌子 Run
  摘要（目的、阶段、耗时、轮数）；展开后再点"查看完整运行"进完整视图。
  默认折叠——不打扰是默认态。
- **运行中胶囊**：ComposerDock 上方的胶囊条，仅列出当前会话**仍在
  运行/挂起**的子 Run（呼吸点作注意力锚定，终态即静止消失）。这是
  唯一的新动效，符合视觉克制不变量。
- **完整子运行视图**：从胶囊或嵌套节点进入，用现有时间线渲染组件
  按 `run.roundIds → rounds → render nodes` 渲染该子 Run 的完整
  过程。**不造第二套渲染器**——这是与 WonWork 的分界线。
- 语义色与徽标沿用 docs/11 设计系统 token；子 agent 不是新视觉物种。

## 5. Pipeline 运行记录可见性

Pipeline 已可寻址（kind=pipeline 在树里），缺运行记录：

- 后端：`/api/v1/capability-admin/items/detail` 的 definition 快照之外，
  对 kind=pipeline 附**最近 N 次运行**（run id、触发来源 trigger_kind、
  阶段、起止时间），数据全部来自既有 `PipelineRunRepository` 与
  `run_invocation`，零新表。
- 前端：详情卡内"最近运行"区块，列出触发来源徽标（系统事件/工具
  调用/定时任务/界面动作）与阶段；不跳页。
- 管理投影仍只进管理页，不进模型上下文（前缀缓存纪律不变）。

## 6. 边界（本期不做）

- cron 的 pipeline 直发 payload（"无父 Run 的根 Pipeline"是 docs/28
  未定义的形态，等真实需求）；错过触发的补跑多次策略（只补一次）；
  时区选择（首版用系统时区）。
- 子 agent 的消息补发 UI（`message_agent` 是模型的工具；人给子 Run
  补消息等真实体验后再说）。
- 通用多 agent 拓扑、嵌套深度放开（仍为 1）、Pipeline 执行语义变更。

## 7. 里程碑

- **M6a（已落地）**：cron 后端。`cron_task` / `cron_execution` 表
  （schema.sql），`CronScheduleLauncher` 唤醒器（启动补扫 + 24h 兜底
  重扫 + 变更事件重排；`claimFire` 先推进再执行，崩溃最多漏一棒），
  到点创建会话+root Run；`/system/schedule` 四个模型工具（docs/03
  已登记）；管理 REST `/api/v1/schedules`（docs/08 §8.8）。
  CronScheduleIntegrationTest 覆盖 CRUD/认领/手动触发/目录投影。
- **M6b（已落地）**：子 agent 前端投影。`ChildRunView.tsx` 三件套——
  嵌套节点（FlowNode 'run' 节点展开为 ChildRunCard：阶段徽标/轮数/耗时/
  progressSummary + "查看完整运行"）、运行中胶囊（ComposerDock 上方
  ChildRunCapsules，仅非终态子 Run，执行中呼吸点、挂起静止、终态消失）、
  完整视图（ChildRunDialog = Modal + RunSection，展开状态对话框局部，
  打开时继承全局已播种节点）。卡片直接订阅 store 绕过 FlowNode 的 memo
  比较器；纯前端，零新 API。
- **M6c（已落地）**：cron 进能力树 + Pipeline 最近运行。
  `ScheduleCatalogSource` 把启用任务投影为 kind=schedule 叶子；
  `CapabilityAdminService.detail` 补上 pipeline 分支（此前 404）并附
  `recentRuns`（`PipelineRunRepository.recentRunsByDefinition`，上限
  10 条）；前端 ScheduleConsole 子视图（列表/启停/立即运行/编辑器 +
  最近触发）+ 详情卡"最近运行"区块。CronScheduleIntegrationTest 增
  投影与运行记录用例（7 个全绿）。docs/08 §8.7/§8.8、docs/32 §1、
  docs/31 路线图已同步。
