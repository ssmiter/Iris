# 34 · 对话视觉对齐与企业级能力补强

> 状态：M7/M8/M9 全部落地（76 测试，唯一失败为历史遗留附件用例）。
> 剩 M10（prompt 阶段，最后做）。
> 方法：与 WonWork（对话质感参照）和 claude-code（原生 agent 内核参照）
> 逐项对比，每条差距三档裁决——值得对齐 / 克制化对齐 / 不对齐。

## 1. 对比方法与裁决纪律

- **吸收好的，拒绝坏的**：好的思想吸收，不好的、不清晰的、用得少的不移植。
  每项"不做"都必须在 §2-C / §4 留痕，防止日后反悔重提。
- **左侧子 agent 可视化要做**（2026-08-19 用户更正了早期的误判）：
  WonWork 的左缘浮层"子 Agent 房间"是好形态——左侧空间平时闲置，
  子运行有独立身份与通信入口。Iris 落地为 M7d。
- **逻辑在后端**：agent、功能、数据全部落在 Java 后端；前端只是视觉承载。
  前端能做的判断不新增后端状态，后端已有的数据不造第二份前端真相。
- **视觉克制约束所有对齐项**：对齐的是信息密度与排版，不是动效数量。
  本文件引入的新动效为零；周期动效变更只有**删减**（reveal-cursor）。
- **目标定义**（2026-08-19 用户指示）：把 Iris 做得比 WonWork **更完善**——
  不是兜底更多或功能更多，而是用户用起来无论视觉还是逻辑体验都更好。
  每个迁移项必须落到可感的体验提升上；堆功能不算完善。
- **大胆迁移条款**（2026-08-19 用户指示）：从 WonWork 及已跑通的功能
  系统性迁移 Iris 底层没有的基础与视觉，不受 docs 以往保守描述的限制
  （docs 是参考不是枷锁）。度的把握：**功能与视觉大步迁，架构哲学不换**——
  Iris 更强的部分（durable 内核、审批管线、目录发现、token 体系）不推倒，
  迁移是补齐与换壳。B 档"缓做"项因此整体升级为排期项（M7e）。
- **prompt 工程最后做**（用户指示）：技能薄清单注入、工具描述纪律、
  prompt 对比统一归入 M10，本轮只做视觉逻辑与内核逻辑。

## 2. 视觉对齐清单（对比 WonWork 逐项裁决）

### A 档 · 值得对齐（本期做）

| # | 项 | 内容 | 里程碑 |
|---|---|---|---|
| A1 | 工具节点耗时 + 摘要摘录 | 节点 meta 行：mono tabular-nums、0.1s 精度耗时 + 摘要首行摘录；目前只有 thinking 节点有耗时 | M7a |
| A2 | 停滞横幅 | 活跃轮超过 30s 无任何进展事件，节点体内出静态琥珀横幅（"不沉默"原则） | M7a |
| A3 | 工具调用内联详情 | 节点体内：mono 参数行（截断）+ 结果/日志区；现在只有 resultRef 一句话 | M7a |
| A4 | 上下文水位 | hintbar 右侧 mono 百分比 + 细条，>70% 变琥珀；数据优先取后端既有统计，没有才补最小只读接口 | M7b |
| A5 | 权限模式弹层 + Shift+Tab | 原生 select 换成 mono 小钮 + 弹出项，Shift+Tab 循环切换；样式沿用 Iris 菜单语言 | M7b |
| A6 | placeholder 延迟切换 | 运行满 5s 才把 placeholder 换成"可补充"文案，避免发送瞬间跳变 | M7b |
| A7 | 拖拽上传 | 文件拖入 composer 即入附件，复用既有上传链路 | M7b |
| A8 | 轮元行时间戳 | 每轮 footer 加 HH:MM，纯静态 | M7c |
| A9 | 删除 reveal-cursor | 无限闪烁光标是全页唯一非锚定周期动效；文字生长本身就是出字信号（WonWork 已拍板验证） | M7c |
| A10 | 审批参数预览 | 审批卡可展开看工具参数——批准决策需要看到参数 | M7c |
| A11 | 轮迹目录（TurnRail） | ≥8 轮才在顶栏出现入口，矩形目录卡、滚动跟随高亮、短对话零常驻 | M7c |
| A12 | 滚动条三态 hover | 纤丸 26%→50%→62% 墨色三态，纯 CSS | M7c |
| A13 | 左侧子 agent 浮层面板 | 左缘圆角浮层"子运行房间"：头部（身份+阶段+终止）/体（任务书→补充→完整瀑布→结果）/底部补充输入；替换 M6b 的居中 Modal，胶囊条保留为入口 | M7d |
| A14 | 排版渲染逐项对齐 | 标题阶梯/表格全边框/行内代码药丸/hr 间距/列表与任务列表/代码块/引用块/链接/行高 1.8/ remark-breaks；顺带消除 prose-sm 默认 gray 主题的深色模式风险（全走语义 token） | M7f |
| A15 | 用户消息内联编辑 | hover 编辑钮 → 原位 textarea，Esc 取消、Ctrl/Cmd+Enter 以编辑后文本建分支变体（复用"从这里改问"路径） | M7g |
| A16 | TurnRail 远跳插值校正 | 虚拟化远跳先估算落地、渲染稳定后 scrollIntoView 精校，防"点目录差一屏" | M7g |
| A17 | 流式答案"输出已停止"眉标 | 停止后答案本体加克制微标，防半成品被当完整答案（排在 M7e，等 M7f 让出 AnswerBlock） | M7e |

### B 档 · 克制化对齐（大胆迁移条款下升级为排期项）

| # | 项 | 克制化方案 | 排期 |
|---|---|---|---|
| B1 | settling 尘埃落定 | 单次 opacity 过渡，沿用 --motion-fold，不引入循环动画 | M7c |
| B2 | 回到最新 smooth 滚动 | smooth + follow 恢复兜底（滚动期间新内容到达则让位给跟随） | M7e |
| B3 | 列宽档位 | 2 档（当前 820 + 一档窄 680），过渡 ≤350ms 单次 | M7e |
| B4 | 水合加载骨架 | 静态灰条，禁用脉冲动画 | M7e |
| B5 | 选中引用浮条 | 选中正文浮条 → 引用 chip 入输入框 | M7e |
| B6 | FlowGroup 并列分组 | 需后端先投 groupId 语义，暂挂 | 待内核轮评估 |

### C 档 · 不对齐（附理由，防止日后反悔重提）

- **浮动毛玻璃 composer + 底部渐隐遮罩**：Iris 流内 scrim 布局更稳、无遮挡，改浮动是退化。
- **chip 回弹缓动 / 发送钮 hover 放大**：弹性拟物与几何缩放超出克制边界。
- **顶栏自动隐藏热区**：Iris 顶栏承载连接态/分支/整理真实入口，隐藏增加发现成本。
- **审批整条点击=批准**：误触风险高于收益。
- **主时间线内的子 agent 嵌套递归瀑布**：主流内只留 ChildRunCard 摘要，完整子运行由左缘浮层（M7d）承载，不造递归渲染器。
- **补充消息不上屏**：Iris 气泡 + 链内 pill 的可追溯性更完整，方向应反转。
- **自定义 accent 单色**：5 预设已覆盖，自由取色破坏 soft/foreground 对比度保证。
- **Ctrl/Cmd+Enter 补充语义与排队消息 ArrowUp 召回**（二轮发散）：Iris 运行中 Enter 已是补充，修饰键重复；排队召回依赖 WonWork 的 queuedMessages 模型，Iris pendingSupplements 语义不同，收益低。
- **斜杠命令菜单**（二轮发散）：对高级用户有效，但显著扩大界面表面积；与技能用户直连通道（slash/pin）一起归 M10 prompt 阶段再评估。

第二轮发散的反向结论（Iris 领先，记录防误改）：发送失败的即时反馈、
审批 TTL 倒计时、连接态与 SSE 重连、结构化恢复建议、触顶分页锚定。
流式渲染策略（空行封印分块 vs 容错前缀单渲染）是架构级差异，WonWork
跳动更小但 Iris 已封印块不重渲染——列为待评估项，不在本期动。

反向结论（Iris 已领先，无需动作）：色彩 token 体系、重连/失败态、
滚动 detach 识别、增量 Markdown、打字机引擎（WonWork 移植自 Iris）。

## 3. 企业级功能（收敛结果）

五域审计结论：**数据网关已超参考方基线，不需重做**；真正要补的是
四个 P1 缺口与一队 P2 增强。

### 域裁决

| 域 | 裁决 | 要点 |
|---|---|---|
| 数据网关 | **基本不动** | `/data/sql` 共享进程插件已落地：只读三重门（声明 + JDBC readOnly + 词法证明 fail-close）严于 WonWork 关键词分类；截断/预算/对象仓回读齐备。仅 P2：核实 connections.json 变更后常驻进程连接缓存是否失效 |
| 定时任务 | **补缺** | 主体已完整（docs/33）。唯一真缺口：**单次任务**（"明早 8 点提醒一次"无法表达）——WonWork 证明这是高频意图。时区对账/多次补偿是 WonWork 前端 setTimeout 不可信的补丁，Iris 后端常驻不需要 |
| 技能 | **补缺（随 prompt 阶段）** | 机制双通道完整；缺口是**技能薄清单注入**——两个参考方独立收敛到"一层 name+截断 desc 常驻清单是被发现的前提"。docs/31 §7 本就允许目录卡片注入块，不违反发现优于塞满。因触碰注入块与前缀缓存，排入 M10 |
| 客户工具包 | **补缺** | 机制层三方最完整（热重扫/逐件 shadowed-by/目录即真相）。缺口全在开发者体验：**扫描 problems 只进日志**，插件作者写错清单只能翻后端日志——投影进管理页 |
| MCP | **补缺** | 双传输 + 六态生命周期 + hint 映射已完整。缺口：**管理页只能建 HTTP 连接器**（生态绝大多数是 stdio）；断线无自动恢复（execute 遇 not_connected 先 refresh 一次再报错，不违反"调用不自动重试"） |

### P2 梯队（记录不排期）

kernel_skill 导出 SKILL.md；插件进程可观测性（崩溃/stderr 投影）；
SSE legacy 传输；MCP prompts/resources → skill 投影；技能用量统计与
slash/pin 用户直连通道；插件脚手架。打包分发/市场不做（个人版阶段）。

## 4. Agent 内核（收敛结果）

### 已强项（不作为差距，防止误改）

durable Run/Round 状态机 + 崩溃恢复（强于 CC 的 transcript 重放与
WonWork 的内存+guard）；审批 prepare/commit/verify 三段管线；结构化
错误回传（recovery.action 指令族，三者最佳）；协议配对 fail-closed；
两级结果收敛（boundedOutput + micro-compact）。

### M9a 内核可靠性三项

1. **反应式上下文溢出恢复**：provider 拒绝（prompt_too_large）不再终结
   Run——withhold 错误 → 触发更紧窗口/压缩 → 新 attempt 重试
   （CC query.ts:801-824 同款）。落点 AgenticRoundCoordinator
   handleAttemptFailure + CompactionLauncher。
2. **Round 级聚合工具结果预算**：当轮多个大结果回注前就地投影为
   tool-result:// 引用，防顶爆硬保留区。落点 RoundToolCoordinator
   汇总阶段，复用 micro-compact 投影原语。
3. **重试与降级强化**：每 Round attempt 3→5；后台/子 Run 的
   Retry-After 容忍放宽到 60s（root 交互 Run 保 10s）；
   ModelProviderRegistry 增加 fallback profile（限流时降级续跑）。

### M9b 子 Run 并发额度

`agent_run_slot` 从只记录变为真约束：按 root Run 统计活跃子 Run，
上限 3（对齐 WonWork 信号量语义），超额时 delegate_task 返回"排队中"
结构化 observation 而不是失败。落点 ChildAgentRunService +
AgentRunLauncher。

### 缓做与不做

- **流式中投机执行只读工具**（CC 流式工具执行）：延迟收益真实，但与
  durable 执行模型有张力、改动面大——待 M9a/b 稳定后再评估。
- 不做：任意深度子 agent/swarm 拓扑（嵌套深度=1 由代码强制）；
  worktree 隔离（开发者工具语义）；agent 循环放前端；schema 租约驱逐
  （目录发现从源头不塞满）；MCP 工具无边界直通；hooks/proactive 主动式
  功能（违反审批与克制不变量）；消息队列中间件（单表+进程内唤醒已够）。

## 5. 里程碑

- **M7a（已落地）过程链信息密度**：A1 工具耗时+摘要、A2 停滞横幅、A3 参数/结果内联。
- **M7b（已落地）输入区**：A4 上下文水位（SSE 推送 + 水合 GET，禁轮询）、A5 权限弹层+Shift+Tab、A6 placeholder 延迟、A7 拖拽上传。
- **M7c（已落地）对话细节**：A8 时间戳、A9 删 reveal-cursor、A10 审批参数预览（含后端投影 parameters/argumentsSummary）、A11 TurnRail、A12 滚动条三态、B1 settling 单次淡化。
- **M7d（已落地）左侧子 agent 浮层面板**：A13 + delegate_task 投影为
  run 节点（DelegateTaskProjectionEnricher + ChildRunNodeProjectionService +
  child_run_render_link），链内卡片真正可达。
- **M7e（已落地）体验补齐**：B2 smooth 滚动兜底（≤50 轮 smooth）、
  B3 列宽两档（820/680，持久化）、B4 水合静态骨架、B5 选中引用浮条
  （markdown 引用块前缀，不发明后端字段）、A17"输出已停止"眉标。
- **M7f（已落地）排版渲染对齐**：A14 全项 + 深色模式 token 化 + remark-breaks。
- **M7g（已落地）操控型细节**：A15 内联编辑（sendTurn 显式分叉点参数）、
  A16 远跳校正。
- **M8a（已落地）拓展 problems 进管理页**：GET /capability-admin/problems + 告警区。
- **M8b（已落地）MCP 管理页 stdio + 断线重连一次**。
- **M8c（已落地）cron 单次任务**：once 语义 + SchemaColumnMigration 守卫。
- **M9a（已落地）**：反应式溢出恢复（0.85 紧预算 ×2 上限）、聚合结果预算
  （24000 tokens）、重试强化（5 attempts、子 Run Retry-After 60s）。
- **M9b（已落地）**：子 Run 并发额度（accepted durable 排队，默认 3）。
- **M8a（排期中）拓展 problems 进管理页**：ScanResult.problems 投影进
  /api/v1/capability-admin + 管理页告警区，纯投影零架构变更。
- **M8b（排期中）MCP 管理页 stdio + 断线重连一次**：ServerDraft 加
  transport+command（mcp_server_stdio 表与 upsertDeclared 路径现成）；
  execute 遇 not_connected 先 refresh 一次。
- **M8c（排期中）cron 单次任务**：cron_task 加 once 语义（fire 后自动
  停用，过期不补跑）；create_schedule 加 once 参数；ScheduleConsole
  加"单次"开关。工具描述纪律随 M10。
- **M9a / M9b（排期中）**：内核可靠性三项 / 子 Run 并发额度，见 §4。
- **M10（最后做）prompt 阶段**：技能薄清单注入（核实目录卡片注入块现状）、
  create_schedule 等工具描述纪律、与两个参考方的 prompt 对比。
