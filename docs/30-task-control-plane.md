# 任务控制面：从对话运行到可恢复执行

## 1. 目标

Iris 已经能够在一次对话中运行 Agent、调用工具、生成 Artifact 和委派子任务。任务控制面进一步回答四个跨轮次问题：

1. 用户真正要达到什么结果；
2. 当前已经确认了什么、下一步是什么；
3. 中断或重启后从哪一个稳定位置继续；
4. 把工作交给另一个 Run 或用户时，哪些事实必须一并交付。

它不是第二套 Agent Loop，也不是把聊天摘要改名为状态。它是现有 Run、Tool Runtime、Pipeline、Artifact 和上下文投影共同使用的持久事实层。

## 2. 五类对象

```text
Task Definition
  稳定目标、约束、完成标准

Task Work State
  阶段、步骤、阻塞项、证据与成果引用、有界摘要

Task Control State
  当前焦点、待用户/系统决策、下一动作、交接说明

Task Checkpoint
  指向一个不可变 Work State 版本的恢复锚点

Run–Task Link
  哪个 Run 创建、推进、观察或接手了任务
```

Work State 和 Control State 共享同一个 `stateVersion`。Control State 使用独立扩展表保存，使已有 SQLite 数据无需伪造字段；缺少扩展行的旧状态按空控制信息读取。

Checkpoint 不复制任务正文。它冻结 `taskId + branchId + stateVersion`，并保存一句恢复摘要。每个不可变状态版本本身都可回读，但只有用户接受、里程碑、暂停、阻塞和终态等稳定边界进入检查点索引。

## 3. 状态与叙事分离

任务状态只保存下一次决策真正需要的有界信息：

- `currentFocus`：当前正在推进的唯一焦点；
- `pendingDecisions`：必须由用户、外部系统或后续验证解决的选择；
- `nextActions`：恢复后可以直接执行或核验的动作；
- `handoffNote`：交接时不能从普通步骤状态推出的短说明；
- Evidence、Artifact 和 Tool Result 只保存稳定引用，不复制 payload。

模型的解释、网页原文、长脚本和报告正文仍分别属于 Conversation、Managed Object Store 或 Workspace。Task Control State 不承担知识库或 Artifact 的职责。

## 4. 检查点与恢复

恢复不是“重新把完整聊天记录塞给模型”。Backend 按以下顺序重建当前视野：

1. 读取 Branch 当前 `task_head`；
2. 读取对应不可变 Work/Control State；
3. 读取最近 Checkpoint 与仍有效的 Evidence/Artifact 引用；
4. 读取 Run–Task Link，区分尚在运行、已经交付和需要 reconcile 的工作；
5. 把有界状态作为动态尾部上下文注入，不改变稳定 Prompt 前缀。

状态版本继续使用乐观前置条件。旧 Run 或迟到的子 Agent 不能覆盖新版本；它们只能提交新的 observation，由当前协调 Run 决定是否合并。

### 4.1 异常不是产品主界面

正确设计优先于异常分支数量。Backend 只区分会改变下一条恢复路径的大问题，例如“可以自行换路”“必须核对副作用”“缺少用户输入”和“确定无法继续”，不为每个技术异常建立一套业务状态机。

短暂失败首先是 Agent 的 observation：它应重新观察、纠正参数或选择另一种能力。只有自动恢复已经无法带来新事实时，才把稳定卡点写入 `blockers` 或 `pendingDecisions`。此时交给用户的不是堆栈或一句“失败了”，而是：

- 已经完成并确认的部分；
- Iris 自己尝试过的路径；
- 仍阻塞的具体事项；
- 用户只需回答或接管的最小清单。

理想投影始终让用户看到三种状态之一：任务正常推进、Iris 正在自行解决问题、Iris 带着明确卡点请求协助。底层诊断继续按需读取，不挤占用户的主要注意力。

等待用户不是 Agent 的执行时间。Run 因 Attention 挂起时，Backend 冻结活动时间预算；用户回答后从同一持久化 Run、Round 和 Task Checkpoint 恢复，并开始新的有界活动片段。历史工具调用仍累计，等待期间不消耗执行时限。由此既不能借接管无限刷新成本，也不会发生“用户刚排除卡点，任务立即因等待超时失败”。

同一外部依赖不可达时，自动恢复只保留能产生新事实的动作：一次重新探测、一次有依据的恢复路径。仍不可用就写入稳定 blocker，并把已完成部分、已尝试路径和最小协助项投影给用户；反复加载同一能力定义或重复同参调用不算推进。

## 5. 交接语义

交接不是自由文本消息，而是一个可核验视图：

```text
task identity + definition version + state version
+ current focus + next actions + pending decisions
+ evidence/artifact references
+ latest checkpoint
+ related active/terminal runs
```

同一视图服务三类消费者：

- 下一轮主 Agent：压缩或重启后继续；
- 子 Agent / State Agent：在隔离上下文中接收明确边界；
- Frontend：呈现轻量任务黑板，让用户查看进度和接管点。

子 Agent 的结果不会直接推进父任务 head。父 Run 验证结果后，才通过统一 Task Ledger 提交新版本。

## 6. 事件与前端边界

任务创建或推进后追加 `task.updated` Conversation Event，payload 携带完整安全 `TaskView`。Frontend 按 `taskId + version` upsert，不解析回答文本推断任务状态。

首次水合使用任务查询接口；SSE 只负责之后的增量时效。详细 Evidence、Artifact 和 Tool 输出仍按引用懒加载，避免任务黑板成为第二份大结果存储。

## 7. 当前刻意不做

- 不自动把每次对话变成长程任务；
- 不让 State Agent 每轮审查主 Agent；
- 不建立通用 DAG 编辑器或任意状态机 DSL；
- 不允许检查点回滚外部世界；外部写入恢复仍遵循 verify/reconcile；
- 不把任务状态、个人记忆、知识材料和领域对象合并成万能 JSON。

## 8. 后续纵切

任务控制面稳定后，按真实场景继续验证：

1. 浏览器观察—动作—验证—接管与 Task Checkpoint 对齐；
2. Pipeline Step 和子 Agent 通过 Run–Task Link 汇合；
3. 在一个长程任务中试点里程碑触发的 State Agent；
4. 从可回放的成功轨迹中提出 Skill/Pipeline 草稿，而不是自动发布。

浏览器动作的瞬时 `not_applied` 或首次 `outcome_unknown` 不自动污染 Task Work State；它们先
作为 Tool Observation 交给当前 Run 自行恢复。只有核对后仍缺少外部事实、权限或用户判断时，
才写入 `pendingDecisions/blockers` 并创建 Attention。这样任务状态记录稳定卡点，浏览器运行时
记录客观执行事实，两者通过 Run 协作而不互相冒充。
