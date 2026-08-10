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

当前已贯通 `child_agent`、无工具的 `model_transform`、受控发布步骤 `publish_conversation_title`，以及严格绑定 Definition 版本的 `tool`。固定 Tool 步骤不另造执行器：参数模板解析后仍进入唯一 Tool Runtime，继续经过 schema 校验、operation snapshot、审批、commit gate、verify、结果落盘和前端投影；Pipeline 只负责编排依赖，不获得绕过真实动作边界的特权。

首轮根 Run 成功且会话仍为“新对话”时，系统事件启动 `conversation_title` Pipeline：短前缀模型只生成标题候选，发布步骤再次检查当前 metadata；用户若已手动命名便保留用户标题。整个过程不新增伪用户消息，也不阻塞原 Turn。

`compose_workspace_artifact` 是首个完整的动作型样例：一次有界模型变换生成成品正文，`write_file` 在工作区围栏和审批下写入，随后 `present_artifact` 冻结并呈现成果。它证明“模型加工 → 真实写动作 → 用户可见交付”能够复用同一套 Agent、Tool、Workspace、Artifact 和 SSE 事实，而不是由某个业务按钮暗中完成半套逻辑。

Pipeline 的失败默认只终结本 Pipeline Run，不拖垮仍可继续的父 Agent。只有同步调用明确声明结果是父任务的必要前置条件时，失败才作为结构化 observation 返回父 Agent。

Definition 还冻结结果交付策略：`notify_parent` 在终态向父 Agent 投递一次有界消息，适用于委派任务；`silent` 只持久化结果并发送产品事件，适用于标题等系统 metadata 流程。交付策略不能由模型在运行中更改。

## 4. 子 Agent 的隔离边界

父 Run 已进入长程 Task Ledger 时，委派输入携带 `taskId + stateVersion`。Backend 从该不可变版本生成有界交接视图并记录 Run–Task Link；父 Agent 不复制整段对话，子 Agent 也不能直接推进父任务 head。子结果回到父 Run 后仍需验证和合并。这一边界与 `docs/30-task-control-plane.md` 一致。

父 Run 创建子 Agent 时必须一次给全：

- `task`：自包含目标，不依赖父 Agent 未公开的思考；
- `context`：完成判断所需的已知背景、已经排除的方向和稳定引用，而不是整段父对话；
- `constraints`：职责边界与不可违反的限制；
- `work_mode`：`observe` 只允许观察，`workspace` 才允许在工作区内产生变更；
- `allowedTools`：允许的常驻原语子集，不能超过父级权限上限；
- `resultContract`：完成时应返回什么、怎样算完成，以及重要证据/Artifact 如何引用；
- `budget`：轮次、工具调用、时间和嵌套深度；
- `mode`：`join` 或 `background`。

子 Agent 不读取完整父对话，只读取自己的任务、自己的 Model/Tool 历史、被显式送达的消息以及允许的稳定 Artifact/Workspace 引用。它不继承父 Agent 的隐式思考、临时工具曝光或审批决定。

首版子 Agent 禁止再次委派，避免递归失控。以后开放嵌套时仍由后端根据深度和预算核验，不能靠提示词自觉。

`work_mode` 是运行时权限，不是提示词标签。观察型 child 即使发现了写能力，也不能越过 Tool Runtime 的只读边界；工作区型 child 仍需经过路径围栏、审批、commit gate 与 verify。父 Agent 必须显式选择可写模式，不能因为任务描述里出现“修改”就由子 Agent 自行扩大权限。

交付不是一段无法判断真假的散文。child 终态形成有界 Result Envelope：`status`、`summary`、稳定 `outputRef` 与从真实 Tool verification 汇集的 `evidenceRefs`。长正文仍留在 child Run 中按需读取；父 Agent 只消费摘要和引用，并对关键结论负责最终核验。

失败同样必须形成可行动的交接，而不是一句“子 Agent/Pipeline 失败”。Result Envelope 与
Mailbox 至少保留规范 `failureCode`、用户可读说明、`recoveryAction` 和已有 Evidence 引用；
父 Agent 据此决定自行重试、缩小任务、换路或形成用户卡点。技术堆栈不进入主上下文，但导致
失败的关键事实也不能只留在子 Run 的内部表中。Pipeline 包装子 Agent 时继续向上携带这份
失败事实，不能用新的泛化错误覆盖根因。

## 5. 同步与后台不是两套实现

`join` 与 `background` 创建完全相同的 durable child Run：

- `join`：调用方等待 child Run 终态，得到有界结果与引用；
- `background`：调用立即返回 `runId`，child Run 独立推进；完成、失败或取消后写入父 Run mailbox，并通过 SSE 发出 Run 事件。

后台 Run 不因父对话本轮结束或用户停止主 Run 而丢失。若父 Run 仍活动，通知在下一 Round 边界作为普通消息进入上下文；若父 Run 已结束，通知仍作为未消费事实保留，并由同一分支的下一次根 Run 原子领取，绝不静默丢弃，也不为了等待后台任务强行延长当前 Turn。

Tool Registry 在应用启动时只建立 Definition 与实现绑定，不能为了注册 `message_agent`、
`cancel_agent_run` 等控制工具而提前构造 Agent Launcher。Launcher 是进程内唤醒器，工具只在
真实 execute 边界按需解析它；Run、取消意图和 Mailbox 的持久事实仍由 Repository/Service
直接拥有。这样依赖方向保持为“定义层 → 持久控制面”，不会形成
`ToolRegistry → Tool → Launcher → ContextAssembler → ToolRegistry` 的启动环。

未终态的 child 也不能在压缩后“消失”。每次根 Agent 组装上下文时，Harness 都从持久 Run 图投影一个有界的 `agent_run_state`，只列出当前分支仍在运行或挂起的 child id、阶段、工作模式和任务摘要。它用于防止重复委派和支持补充/取消，不注入 transcript，也不要求模型轮询进度。

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

召回不固定为一种公式，而是可解释的计划：先按对象状态、作用域、类型与来源过滤合法集合；关键词、短语和编号命中提供高精度锚点，归一化向量余弦补足同义、口语和跨语言表达。两路可以并行融合，也可以先用廉价索引粗召回再对小集合语义重排。结果保留 lexical/semantic 分项、模型版本和阈值作为候选证据；模型不可用或超时时降级到关键词，不阻塞主 Agent。向量缓存以内容哈希、模型 identity 和归一化版本为键，不能只用原始文本形成无版本缓存。

Skill 生成 Pipeline 的输入应是主 Run 的“骨架事实”：目标、关键选择、成功工具链、验证证据、失败后修正和 Artifact 引用。它不能复制完整隐藏推理，也不能仅凭一次偶然成功自动发布。

## 9. 从 Claude Code 场景得到的边界

Claude Code 中标题、自动压缩、离开摘要、输入建议、任务摘要和 Skill 生成看起来都“调用了模型”，但它们不是同一种运行形态。Iris 只吸收其职责划分：

- **压缩**属于上下文基础设施：由水位线或用户入口触发，输入是版本化历史视野，输出是可追溯边界；它不能退化成普通摘要 Pipeline，更不能删除原历史。
- **离开摘要与输入建议**属于可丢弃的界面辅助：只读近期有界窗口，使用小模型、无工具、可取消、失败静默，不得写回任务事实或抢占主 Run。Iris 等前端具备可靠的焦点/空闲事实后再接入，而不是先造后台定时器。
- **任务摘要**属于运行索引：服务于“当前在做什么”的列表或进程视图，可在长 Run 的步骤边界刷新，但不是父子 Agent 的通信正文，也不能替代 durable task state。
- **标题**属于会话索引：模型只提候选，代码依据当前版本和用户是否已命名决定是否发布；Iris 已按此闭环实现。
- **Skill 草稿**属于经验提炼：输入是成功路径的骨架事实，输出先是可审阅草稿；只有持久对象、来源、适用条件、依赖和发布生命周期齐全后，才值得接上生成 Pipeline。

据此，Pipeline 的判断标准不是“这个功能用了模型”，而是同时具备**固定入口、已知的数据变换骨架、明确的持久对象或系统动作**。需要根据新观察自由选择路径的研究、浏览器探索和领域求解继续使用主 Agent 或隔离子 Agent。这样既复用 Agentic 能力，也不会把每个产品功能都包装成另一种小 Agent。

WonWork 的 APS 写任务进一步说明了一种可复用但不应硬编码成通用角色的模式：执行 Agent 负责求解和行动，state Agent 维护的是“可证伪、可预测、可闭环的当前任务态势”，而不是聊天摘要或第二份计划。它应区分观测事实、工作假设、有效决策、预期后果和写后偏差；只有写动作的必要前提或授权边界不成立时才阻断，不能用“不确定”机械否决可逆探索。Iris 首先提供隔离 Context、只读 work mode、稳定 Run/Artifact 引用和结构化交付，具体领域再按真实需求装配 state Pipeline，避免把一个业务范式膨胀成全局多 Agent 框架。

## 10. 恢复与终态

- Pipeline 重启后从持久化 Step 状态重建；成功步骤不重跑。
- 等待 child 的步骤由 child terminal event 唤醒；进程重启时通过未闭合 parent/child 事实恢复。
- 后台取消先写取消意图，再通知进程内句柄；已提交写动作仍走 verify/reconcile。
- child Run 的部分成果与最终文本先持久化，再发送完成通知。
- 父 Run、child Run 和 Pipeline Run 分别闭合；child 结束不能提前结算整个 Turn。
- SQLite 使用 WAL 与有界 `busy_timeout` 吸收正常的短时写竞争；事件追加只对明确的
  `SQLITE_BUSY` 做少量原地重试，不把普通并发抖动升级为 Agent 问题。
- Launcher 捕获逃出 Agentic Coordinator 的大故障。有限自恢复后仍失败时，必须把 Run
  终结为带用户说明和恢复建议的 durable Failure，让 child Result、Pipeline、Mailbox、
  Task Activity 与 SSE 继续正常汇合；禁止只写日志并留下永久 `running` 的假象。

## 11. 近期实现顺序

1. 已完成 Pipeline Definition/Run/Step、隔离 child Agent、durable mailbox 与统一触发入口；
2. 已完成首个系统 metadata 闭环：标题模型转换与受控发布；
3. 已完成固定 Tool 步骤复用唯一 Tool Runtime，并以工作区成品生成与 Artifact 呈现打通动作闭环；
4. 已补齐子任务 Assignment、只读/可写运行边界、压缩后活动状态投影和结构化 Result Envelope；下一步以真实任务验证 coordinator + worker/state 的协作，不先增加团队拓扑；
5. 已建立可降级的混合候选召回内核；后续让既有 Compact 接入统一调度事实，再实现可撤销的记忆候选与 Skill 草稿；
6. 离开摘要、输入建议等界面辅助等待可靠的前端触发事实；不以增加 Pipeline 数量作为进度；
7. 有真实体验数据后再决定并行 join、通用 DSL 和更复杂的多 Agent 拓扑。

这条顺序先保证“同一个内核能自然连接起来”，再增加场景数量。
