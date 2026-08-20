# 36 · 第三轮发散收敛：能力目录效果与全栈精制

> 状态：**M13/M14/M15/M16 已落地**（96 测试 0 失败 + 唯一历史遗留 error 基线不变；
> 前端 tsc + build 全绿）。M17 投机执行设计冻结，排第二波。
> 四路探索 → 主上下文裁决 → 五包并行实现（P1-P5）。
> 标尺沿用 docs/34 §6：手机 app 级顺滑 + macOS 级设计；重心在体验不在兜底。

> 落地注记：M16 建议的 4 组新测试（busy 重试 / model_not_configured /
> RunView.progressSummary / catalogPath 投影）随 M17 一波统一补；
> P5 留痕：CompactionLauncher 无 provider 静默分支（无 Turn 失败卡语义，不动）、
> DelegateTaskProjectionEnricher 与 ChildRunNodeProjectionService 的同构摘要逻辑
> 可待后续收敛（非错误，仅重复）。

## 1. 本轮主题

用户指定方向：**能力目录的效果与视觉** + 前端视觉与后端/agent 继续打磨。
"能力目录"有两面：模型侧的发现原语效果（目录/搜索/读取的输出质量），
人侧的能力中心管理页视觉。

## 2. 里程碑与裁决

### M13 能力目录发现效果（后端）

发现：骨架完整且符合 docs/03/31/32，但**内核高频目录无元数据**——
`/system/files`、`/system/capabilities`、`/system/context`、`/system/interaction`
等模型最常逛的目录落到空兜底文案，段名原样显示英文；搜索输出带 workspace
残留的 `line:1,column:1` 占位；`read_capability` 三种 kind 输出键不一致。

| 项 | 裁决 | 内容 |
|---|---|---|
| 内核目录元数据补齐 | **做** | `CapabilityDirectoryCatalog` 补高频目录 title/description |
| 段词典补齐 | **做** | `DomainCatalog.SEGMENT_LABELS` 补 capabilities/agents/pipelines/interaction/schedule/memory/personal/skills 等 |
| 搜索输出去占位字段 | **做** | capability 命名空间省略 line/column；preview 限长 160 |
| read_capability 键统一 | **做** | 统一 `invocation`（skill 注明作工艺正文），docs/03 同步 |
| list guidance 情境化 | **做** | 空目录提示换搜索；>20 项提示先搜索再读定义 |
| exactAnchor 放宽 | **做** | 整串命中 → 任一词元精确命中 name |
| ONNX 嵌入随发行版默认开启 | **缓做** | 涉及发行体积与模型选型，留用户决策；文档化开启方法即可 |
| 搜索文档缓存 / problems 聚合内核失败 / 树构建 O(n²) | **不做** | 兜底类，当前规模无感（不炸即收手） |

### M14 能力中心视觉精制（前端）

第一/第二梯队全做：标题层级倒挂（EditorHeading 24px>Modal 18px）、
kind chip 渲染英文枚举串、shadowed 6px 色点改 Badge、全页焦点环补齐
（a11y）、删除定时任务加确认 Modal（danger variant）、打开重取闪烁
（会话级缓存 + 保留选中/展开）、双滚动容器改两列各滚、树/卡/MCP 展开
chevron 单图标旋转 + 详情淡入、QuietState 分 loading/empty 两态、
MCP 工具清单三态（loading/空/列表）、**风险色与对话区同源**
（共享 `domain/capability/riskMeta.ts`，主上下文已建，对话区值为准：
read_only→success、standard→neutral、destructive 标签"破坏性"）。

第三梯队做：工具栏高度刻度对齐（h-8）、列表 divide-y 分隔、说明行左缘
对齐、状态徽标/开关分工、返回文案统一、Modal 描述随子视图适配、开关
旋钮去 bg-white、缩进魔法数消、记忆卡裸枚举中文化 + 置信度前缀、
"立即运行"按钮归尺寸档、ProblemsBanner 防跳动、返回焦点管理。

WonWork 迁移：W1 kind 图标砖（40px 图标砖 + kind 语义 soft 色）、
W3 搜索框前导图标（ui/Input 加可选 leadingIcon）、W5 结构化空态、
W7 子视图标题计数。

克制化：W2 卡片底部动作条重构缓做（本轮只做分隔线 + 详情 border-t 内嵌
替代 border-l 左边条）；不做 WonWork 的 text-[10px] 微标签 / 原生
confirm / hex 直写（既有禁令）。

### M15 对话区残留毛边（前端）

**P0 全做**：
1. 用户/补充气泡补 `whitespace-pre-wrap break-words`（三处）——比
   WonWork 更完善项；
2. CodeBlock 高亮底色硬编码蓝调 → `background: transparent` 让外层
   token 容器承载（暖/冷色调维度对代码块生效）；
3. 答案链接 `target=_blank rel=noopener` + img 对齐 ArtifactCard 克制策略；
4. 活跃轮摘要"0ms"→ active 时不渲染耗时段；
5. Turn footer 活跃期"0s"→ active 时隐藏。

**P1 做**：审批卡按 riskLevel 左边缘色条（elevated=warning/destructive=
danger，纯静态）；上下文水位死控件 button→span + >90% 红档 + min1% 规则；
删除 composer 常态快捷键 hint（WonWork v9.3 同款结论）；TaskBlackboard
布局内推挤 → 吸顶浮条（与审批条同一悬浮语言）；子运行浮层滚动跟随
（贴底 follow + 离底"回到最新"）。

**P2 做**：无语言代码块包进 border 容器；气泡宽度三套收敛一个常量；
FlowNode 头行 items-baseline；▴/▾ 文本字符统一 lucide；font-sans 栈与
body 栈同步；子运行补充输入单行 input → autosize textarea；
PermissionModeSelect Esc 关闭 + title 明示 Shift+Tab；FlowNode memo
比较器补 onToggle/onOpenChildRun。

**P1 缓做**：批量同工具审批合并（≥3 同 tool+risk 合一卡）——中低频，
留下轮。**P2 缓做**：attention waiting 计时。

**做（用户点名"能力目录视觉"）**：ToolNode 投影补 `catalogPath`，
FlowNode 展开体首行 muted caption 呈现能力树路径（不进头行增杂）。
前端类型字段主上下文已加（models.ts）。

### M16 内核小项 + 投影（后端）

- **做**：标题发布链 busy 重试（复用 SqliteContention + ConversationEventAppender
  模式，2-3 次 50/100/200ms；标题写天然幂等）——修 Run 卡死；
- **做**：无 provider 静默 → `AgentRunLauncher.start` 改走
  `failRun("model_not_configured")`（configuration/user_input 语义照
  provider_auth_failed 先例），一处覆盖 launch/恢复/排队子 Run 三路径；
  前端零新组件（失败卡管线现成），WaterfallTurn 失败卡在
  recovery=user_input 时补一行配置指引；
- **做**：`RunView` 补 `progressSummary`（仅 child Run 非 null，复用
  ChildRunNodeProjectionService 的 phase+taskText 逻辑）；
- **做**：ToolNode 投影 `catalogPath`（配 M15）。
- **不做（留痕）**：TurnStats.toolCallCount 口径（改名/计入都得不偿失）；
  FlowGroup groupId 不投孤立语义（待投机执行稳定后随分组渲染一起评）；
  pipeline Run 未配置 provider 保持 durable idle（无 Turn 失败卡，语义正确）。

### M17 流式投机执行只读工具（后端架构项，第二波）

设计已冻结（探索材料 B，全文要点）：投机不是旁路执行器，而是**流中
BlockCompleted 即提前调用同一个 `ToolRuntime.invoke`**；toolCallId 公式
确定性（`ModelStreamAssembler.toolCallIdFor` 提为 public static）；对账靠
`findByToolCall` 幂等早退（零改动）；资格层 `PARALLEL_SAFE + READ_ONLY +
sideEffect==NONE` fail-closed，审批结构性双保险；SSE 零新事件、DB 零
schema、前端零改动；孤儿 execution 行接受不回收；配置
`iris.agent.speculation.enabled`（默认 true）/ `max-parallel`（默认 2）。

改动面：`ModelStreamAssembler`（提静态方法）、新类 `StreamingToolSpeculator`、
`ToolRuntime.speculationEligible`、`AgenticRoundCoordinator.consume` 接线、
配置。不改：`RoundToolCoordinator`/`ModelAttemptService.commit`/
`ToolObservationService`/SSE/DB/前端。

克制边界（不做）：写工具无任何投机通路；不提前投工具卡；不做孤儿回收；
不做 CC 的 sibling-error 级联；不动批次调度与结果预算；不做 progress
流中透传。

## 3. 包划分（文件区分界）

| 包 | 内容 | 独占文件区 |
|---|---|---|
| P1 | M13 目录后端 | `tools/catalog/*`、`tools/system/capabilities/*`、`tools/system/files/SearchFilesTool.java` |
| P2 | M14 能力中心 | `components/capabilities/*`、`ui/Input.tsx`、`ui/Modal.tsx`、`domain/capability/*`（riskMeta.ts 已存在只读引用） |
| P3 | M15 对话 A 面（排版渲染） | WaterfallTurn、RoundSection、ProcessSummary、CodeBlock、IncrementalMarkdown、FlowNode、tailwind.config.ts、styles/base.css |
| P4 | M15 对话 B 面（交互）+ M16 前端接线 | PendingApprovalStack、ComposerDock、PermissionModeSelect、TaskBlackboard、ConversationApp、ChildRunView |
| P5 | M16 内核小项+投影 | GeneratedConversationTitleService、AgentRunLauncher、AgenticRunCoordinator、ConversationViews、查询装配、ToolNode 投影 |

第二波：P6 = M17 投机执行（ModelStreamAssembler、StreamingToolSpeculator、
ToolRuntime、AgenticRoundCoordinator、配置）。

跨包约定（主上下文已先行落地）：`domain/capability/riskMeta.ts` 共享风险表；
`models.ts` ToolNode.catalogPath 字段；RunView.progressSummary 前端类型已存在。

## 4. 防反悔记录（本轮新增不做）

- 批量审批合并、waiting 计时、ONNX 默认打包：缓做非不做，下轮可重提。
- 搜索缓存 / problems 聚合 / O(n²)：兜底类不做，规模到千级再议。
- W2 动作条重构：本轮只做分隔与 border-t，完整重构缓做。
- groupId 孤立语义不投；toolCallCount 口径不改。
