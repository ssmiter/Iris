# Pipeline、子 Agent 与异步运行时

> 本文定义 Iris 在单 Agent 内核之上的第一层组合能力：版本化 Pipeline、隔离的子 Agent，以及贯穿工具、按钮和系统事件的持久化异步通信。

## 1. 目标不是更多 Loop，而是更多受约束的入口

Iris 只保留一套 Agentic 内核。主对话、同步子任务、后台子任务和 Pipeline 中的 Agent 步骤都复用相同的 Round、Model Attempt、Tool Runtime、审批、证据与上下文窗口实现；差异只来自运行边界：

- 输入事实：完整分支历史，或一份自包含任务；
- 可见能力：主 Agent 的有界常驻原语，或按职责收窄后的工具面；
- 预算：时间、轮次、工具调用和嵌套深度；
- 交付契约：自然语言结论、结构化结果或 Artifact 引用；
- 调度方式：父调用同步等待，或后台运行后异步通知。

因此 Pipeline 不是第二套 Agent，子 Agent 也不是复制一份主对话。它们只是同一运行内核上的不同 Context Frame 与调度策略。

## 2. 三种入口，一个 Run 事实源

同一份版本化 Pipeline Definition 可以从三个入口启动：

1. 主 Agent 通过已发现的 Pipeline capability 调用；
2. 用户点击按钮、右键选区或提交结构化表单；
3. 后端在明确的系统事实出现后触发，例如首轮标题、压缩水位线或后台 Run 完成。

入口只负责组装 `PipelineInvocation`：definition identity、规范化输入、触发来源、会话/分支、父 Run 与幂等键。接受后立即冻结 Definition hash、输入 hash、依赖版本和预算，随后统一交给 Run Coordinator。Controller、Tool 和定时器都不能直接执行 Pipeline 步骤。

对话内工具只能从活动 Run 启动子 Pipeline；按钮和系统事件可以把新 Pipeline 挂在已结束 Run 上，以复用当时的分支、Turn 与展示锚点。它们不会重新打开旧 Run，也不会改写旧回答。

## 3. Pipeline 的首版尺度

首版只实现代码定义的顺序步骤，不实现任意 DAG 或图形化 DSL。每个步骤有稳定 `stepId`、类型、输入映射、结果契约和失败策略，并独立持久化为 `PipelineStepRun`。

步骤输入使用显式选择器：`input:/json/pointer` 读取冻结的初始输入，`step:<stepId>:/json/pointer` 只读取已经成功的前序步骤输出。禁止读取后序或仍在运行的步骤，因此数据依赖天然保持为可恢复的有向无环关系，而不需要首版引入图调度器。

允许的执行单元逐步扩充为：

- `model_transform`：一次有界模型变换，适合标题、摘要、记忆整理；
- `tool`：通过唯一 Tool Runtime 执行真实观察或动作；
- `child_agent`：创建一个隔离且受预算约束的 Agentic child Run；
- `gate`：检查结构化前置条件或等待用户输入；
- `publish`：把内部结果显式发布为用户可见 Artifact、记忆或技能。

当前已贯通 `child_agent` 与无工具的 `model_transform`：前者覆盖“把一个明确子目标交给同一 Agentic 内核”，后者覆盖标题、选区提炼等一次模型转换。后续新增步骤处理器时不改变 Definition、Run 和事件协议。

Pipeline 的失败默认只终结本 Pipeline Run，不拖垮仍可继续的父 Agent。只有同步调用明确声明结果是父任务的必要前置条件时，失败才作为结构化 observation 返回父 Agent。

## 4. 子 Agent 的隔离边界

父 Run 创建子 Agent 时必须一次给全：

- `task`：自包含目标，不依赖父 Agent 未公开的思考；
- `allowedTools`：允许的常驻原语子集，不能超过父级权限上限；
- `resultContract`：完成时应返回什么，以及重要证据/Artifact 如何引用；
- `budget`：轮次、工具调用、时间和嵌套深度；
- `mode`：`join` 或 `background`。

子 Agent 不读取完整父对话，只读取自己的任务、自己的 Model/Tool 历史、被显式送达的消息以及允许的稳定 Artifact/Workspace 引用。它不继承父 Agent 的隐式思考、临时工具曝光或审批决定。

首版子 Agent 禁止再次委派，避免递归失控。以后开放嵌套时仍由后端根据深度和预算核验，不能靠提示词自觉。

## 5. 同步与后台不是两套实现

`join` 与 `background` 创建完全相同的 durable child Run：

- `join`：调用方等待 child Run 终态，得到有界结果与引用；
- `background`：调用立即返回 `runId`，child Run 独立推进；完成、失败或取消后写入父 Run mailbox，并通过 SSE 发出 Run 事件。

后台 Run 不因父对话本轮结束或用户停止主 Run 而丢失。若父 Run 仍活动，通知在下一 Round 边界作为普通消息进入上下文；若父 Run 已结束，通知仍作为未消费事实保留，并由同一分支的下一次根 Run 原子领取，绝不静默丢弃，也不为了等待后台任务强行延长当前 Turn。

## 6. Mailbox：异步通信的持久事实

进程内回调只能用于唤醒，不能承载真相。每条消息先写 `run_mailbox_message`：

- 稳定 message id、source/target Run；
- `instruction`、`completion`、`cancellation` 等语义类型；
- 人可读正文和可选结构化 payload；
- `queued → injected` 生命周期；
- 实际注入的 Round id 与时间。

发送给运行中子 Agent 的补充信息不会插入正在流式生成的请求，而是在下一步骤边界注入。完成通知同理。这样 Provider 请求前缀、工具调用配对和压缩水位线不会被并发消息撕裂。

终态通知只携带有界摘要和 Run 引用，不自动把长结果重新灌回上下文。摘要不足时，主 Agent 使用 `read_agent_result` 按字符窗口读取同一分支中的持久结果；这与大型 Tool result 的按需读取遵循同一原则。

## 7. 上下文与前缀缓存

隔离不意味着任意重写系统提示词。主/子 Agent 共用稳定的核心元认知前缀，角色差异放在稳定前缀之后的 Run Context 中。工具面只在确有职责边界时收窄，并按固定顺序规划。

Pipeline 的一次模型变换使用独立、版本化的小提示定义；它不触碰主对话消息数组，也不把一次性输入写入长期系统前缀。输入、输出、使用量和失败均归属自己的 Run/Step。

## 8. 与压缩、记忆和 Skill 的关系

Compact、记忆与 Skill 都是“信息经过受约束过程变成另一种长期对象”，但对象生命周期不同：

- Compact 只改变当前视野，原始历史永不删除；
- 记忆是可撤销、带来源的用户事实，不等于对话摘要；
- Skill 是可发现的工艺骨架，保存适用情境、步骤、工具依赖和验证方法，不保存某次任务的隐式思考；
- 标题是会话索引，不进入任务事实。

右键选区、按钮或系统水位线都先生成统一 Invocation，再由各自 Pipeline 定义决定输入如何变换和发布。未来 BERT/Embedding 只负责候选召回；最终是否注入、合并或遗忘由带来源和版本的记忆 Pipeline 决定，向量分数不能直接成为事实。

Skill 生成 Pipeline 的输入应是主 Run 的“骨架事实”：目标、关键选择、成功工具链、验证证据、失败后修正和 Artifact 引用。它不能复制完整隐藏推理，也不能仅凭一次偶然成功自动发布。

## 9. 恢复与终态

- Pipeline 重启后从持久化 Step 状态重建；成功步骤不重跑。
- 等待 child 的步骤由 child terminal event 唤醒；进程重启时通过未闭合 parent/child 事实恢复。
- 后台取消先写取消意图，再通知进程内句柄；已提交写动作仍走 verify/reconcile。
- child Run 的部分成果与最终文本先持久化，再发送完成通知。
- 父 Run、child Run 和 Pipeline Run 分别闭合；child 结束不能提前结算整个 Turn。

## 10. 近期实现顺序

1. Pipeline Definition/Run/Step 的持久化骨架与统一触发命令；
2. 隔离 child Agent Context、同步/后台调度、结果持久化；
3. durable mailbox、消息/取消工具和 terminal event 唤醒；
4. Agent 与按钮复用的 Pipeline invocation API；
5. 标题、Compact 适配、记忆整理与 Skill 候选生成等具体定义；
6. 有真实体验数据后再决定并行 join、通用 DSL、向量模型和多 Agent 拓扑。

这条顺序先保证“同一个内核能自然连接起来”，再增加场景数量。
