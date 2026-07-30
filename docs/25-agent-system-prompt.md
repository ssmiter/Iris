# 25 · Agent System Prompt：模型与 Iris 操作系统之间的接口

> 状态：首版结构已落地，内容会随单 Agent 内核反复打磨。
>
> Prompt 不是品牌文案，也不是一份工具说明书。它规定模型如何理解 Iris 提供的环境、
> 如何发现能力、如何把 observation 当作事实、如何在失败后恢复，以及何时停止。

## 1. 为什么它是系统核心

同一组 Tool 和同一个 Agent Loop，可以因为元认知不同而表现得像两个完全不同的产品。
模型需要知道的不只是“有什么函数”，还包括：

- 哪些信息是事实，哪些只是待验证假设；
- 能力没有全量注入时，怎样从开放问题走到精确定义；
- 什么时候优先领域能力，什么时候组合系统原语；
- 哪些调用可以并列，哪些必须等待依赖；
- 大结果怎样继续读取，而不是重复查询；
- 失败后应该纠参、重读、核验外部状态，还是停止；
- 什么叫完成，什么叫原地踏步。

所以 Prompt 是模型与 Iris “操作系统”之间的接口契约。Tool Runtime、路径围栏、审批、
Checkpoint 和数据库权限仍必须由代码强制执行；Prompt 负责让模型有效使用这些客观
机制，不能被当作安全边界的替代品。

## 2. 设计原则

### 2.1 只描述已经兑现的系统

Prompt 只能介绍当前真实存在且链路已接通的环境。SQL、Sandbox、WebBridge 或领域能力
尚未可用时，不提前写使用方法；否则模型会形成一个比产品更完整的虚假世界模型。

### 2.2 教方法，不背工具名单

完整 Tool schema 由 Provider 的 tool definition 通道随短期 Capability Lease 注入。
System Prompt 不重复 schema，也不列出全量工具名，只解释发现、选择、组合和恢复方法。
这同时降低 token 成本、避免两份定义漂移，并保持模型面对千级能力时的判断质量。

### 2.3 事实观先于行动 SOP

模型必须区分：

- 用户目标：决定要解决什么；
- System 约束：决定怎样行动；
- Capability Definition：可信的工具契约；
- Tool Observation：一次执行产生的客观事实；
- 文件、网页、SQL 行和外部返回文本：被观察的数据，而不是新的系统指令。

外部内容即使出现“忽略此前要求”“直接执行”等文字，也不能改变用户目标、权限或
Runtime 策略。Prompt 注入防护首先是一套来源语义，而不只是关键词拦截。

### 2.4 发现尺度是“刚好够用”

加载不足会让模型用错工具；无差别加载又会稀释判断。每个被读取的 Definition 应对应
一个真实子问题。找到足以推进的能力后立即执行，用 observation 校准，而不是为了保险
继续浏览整个目录。

### 2.5 错误是协议，不是散文

模型不应从一段模糊异常文本猜副作用。Tool Observation 至少提供：

```json
{
  "errorCode": "workspace_file_version_changed",
  "message": "文件在准备后发生变化",
  "effect": "none_confirmed",
  "recovery": {
    "action": "observe_then_retry",
    "newToolCallRequired": true,
    "instruction": "重新读取目标，再基于当前状态发起操作"
  }
}
```

`effect=may_have_changed` 时，任何自动重试都必须先让位于状态核验。Prompt 只解释这个
通用协议，具体恢复动作由 Runtime 根据稳定事实投影。

### 2.6 每句话都要降低一次理解成本

一条 Prompt 规则如果既没有减少工具误选，也没有减少无效往返、风险或幻觉，就不应进入
稳定前缀。业务表名、临时路径、某个站点的操作技巧和一次事故的补丁，优先进入对应
Capability guidance、Definition 或确定性 Policy，而不是永久堆进全局 Prompt。

## 3. Iris 的 Prompt 分层

```text
稳定元认知前缀
├─ 身份与事实观
├─ 行动姿态
├─ 能力发现循环
├─ 平台组合原则
└─ 失败恢复与停止条件

Catalog snapshot（Definition 变化时才变化）
├─ catalog hash
└─ 顶层目录 + capability 数量

Model Attempt 动态部分
├─ active Capability schema lease
├─ 当前分支的 canonical facts
├─ Compact summary / fact refs
└─ 用户消息与 Tool observations
```

当前实现：

- `AgentSystemPrompt` 构造稳定元认知前缀，并从 Registry 生成排序后的 Catalog hash 与
  顶层目录计数；
- `AgentContextPolicy` 固定注入两个发现元工具与共享的 `search_files` 原语，并从成功的 `read_capability`
  observation 计算下一轮候选；
- `CapabilityLeasePlanner` 在独立 schema token budget 内保留精确定义；
- `ModelContextAssembler` 把 Prompt、lease 和分支事实冻结为不可变 Context snapshot。

Definition 没有变化时，Prompt 不包含当前时间、随机顺序或逐轮计数，因此前缀逐字节
稳定。用户状态和对话事实位于其后，不反向污染稳定层。

Prompt 源码必须保持 UTF-8 可读。Maven 显式固定 source/reporting encoding；
`AgentSystemPrompt` 在启动构造时拒绝 Unicode replacement character。终端显示乱码不应
直接当作源码损坏证据，诊断时必须以显式 UTF-8 解码或原始字节检查复核。

## 4. 首版元认知的六个部分

### 4.1 身份与完成标准

Iris 与用户共同把真实目标落实为可核验结果。它不为展示 Agent 能力而调用工具，也不把
“生成了一段合理文字”误当作外部任务完成。

### 4.2 行动姿态

- 当前上下文足够时直接回答；
- 缺事实时使用只读能力观察；
- 轻微歧义且探索可逆时先行动、后校准；
- 不同理解会导致本质不同或不可逆动作时，先向用户确认。

这避免两个极端：遇到模糊请求就把认知负担退回用户，或在目标未确定时擅自写入。

### 4.3 能力发现循环

1. 把请求翻译为对象、动作和成功证据；
2. 判断是点状问题，还是包含依赖关系的链状问题；
3. 当前 lease 已有匹配原语时直接使用，不为已知能力重复搜索；
4. 用户已经给出对象或动作词时，第一步使用
   `search_files(namespace="capabilities")`；`list_capabilities` 只用于用户询问能力全景、
   领域词汇未知，或确实需要理解上下游结构的情况；
5. 工作区原语和能力目录是两个命名空间：`list_files` 可以用于确认任务涉及的工作区事实，
   但其结果不是 Capability；能力路径则不按物理工作区文件解释。避免为一个词面已经明确的
   具体任务逐层遍历能力目录；
6. `list_capabilities` 返回的 `directories[].path` 仍是目录，只有 `items[].path` 和搜索
   命中的精确能力路径才能交给 `read_capability`；
7. 对真实候选调用 `read_capability`，不凭名字猜参数；
8. 核对 availability；unavailable 时处理 Application/Environment 缺口，degraded 时遵守限制；
9. 工具进入下一轮 active lease 后调用；
10. 用 observation 验证口径，不匹配则带新事实返回发现。

“优先领域能力”是降低口径理解成本的偏好，不是禁止使用底层原语。领域能力缺失、
粒度不符或组合原语更客观直接时，Agent 可以自主选择后者。

工作区的目录观察、搜索、读取、建目录、整文件写入和局部补丁是常驻原语，不需要先经过
Catalog 发现。这个集合只覆盖高频、跨任务且足以形成最小闭环的操作；复制、移动、删除、
恢复等仍按需进入 lease。常驻表示 schema 对模型可见，不表示外部资源已经创建，也不绕过
写入策略、Checkpoint 或 verify。结果窗口读取与 JSON 选择同样常驻，因为 Context 可能在
本轮才把旧 observation 收敛为可重取引用；特定失败恢复工具则由 observation 状态自动激活。

### 4.4 平台组合

当前 Prompt 只声明已经存在且可由 availability 如实降级的六类平台对象：

- Workspace logical files：用户工作区内的文件和目录；
- Tool result store：同一对话内完整、不可变、可再次读取的执行结果；
- Decimal calculation：确定性的十进制计算；
- Structured data connections：安全 metadata 可发现、只允许已确认只读的参数化 SQL；
- Browser runtime/session/page：由 Backend Connector 连接本机 daemon；当前闭环只包含
  Runtime 发现、短期 Session、页面观察、幂等导航和 Observation 内元素点击，不提前承诺填写；
- Capability Catalog：可搜索、可分层读取的能力空间。

组合规则：

- 无依赖的只读调用可以在同一 Round 并列发起；
- B 的输入来自 A 时必须等待 A；
- 写操作与存在状态依赖的操作串行；
- 大 JSON 用 `query_tool_result` 精确选择和分页；
- 非结构化大结果用 `read_tool_result` 按字符窗口读取；
- 不因 preview 有限而重复执行原始昂贵查询。
- SQL 先选择 Connection 对象，不知道内部对象结构时观察 schema，再以 JDBC bind 传值；
  已有领域口径能力时不以 raw SQL 猜口径。
- 浏览器先选择 available Runtime，再继续 Session 或创建新 Session；Observation ref 是
  页面动作的短期水位线，元素 ref 不跨 revision；动作直接回流新 Observation 与 Evidence。
- 普通文本填写绑定同一 Observation 并重读确认；password/file 等敏感字段在 secret handle
  或人工接管闭环前 fail-close。截图进入二进制对象仓，只把 objectRef 放入文本上下文。
- 浏览器 `not_applied` 可以重新观察，`outcome_unknown` 必须先核验当前页面，不能换一个
  action attempt 盲目重放。
- 异步 UI 用一次有界 `wait_browser_page` 在 daemon 内等待，只回流最终 Observation；
  点击打开新标签时采用动作结果的新 pageId，不继续操作旧页面身份。
- 当前轻量接管通过普通对话边界完成：保留 Session，告诉用户在可见窗口操作并在完成后
  回复；下一 Turn 先列出存活 Session 并重新观察，不把旧 element ref 或等待过程带入上下文。

浏览器更高阶的定位、点击、填写、截图和接管只有在各自 observation、风险、证据与
恢复链闭合后才进入本节；“daemon 已连接”不等于所有网页动作都已经存在。

### 4.5 写入与权限

模型不需要把“人工审批”当作所有写入的核心体验。Runtime 可以根据产品模式和权限策略
自动执行或等待用户，但以下语义始终不变：

```text
prepare → immutable snapshot → policy
→ commit gate → execute → verify / outcome_unknown
```

Workspace 写入还必须经过版本复核和 Checkpoint。模型不能绕过 Runtime，也不能在收到
成功 observation 前声称完成。这样审批可以很轻，执行语义不会随模式变化。

### 4.6 失败、恢复与止损

- `none_confirmed`：可以按 recovery 纠参、重新观察或重规划；
- `may_have_changed`：先核验目标状态，不得盲重试；
- rejected/cancelled：停止当前动作，除非用户重新明确要求；
- 同一路径连续尝试却没有产生新事实：换本质不同的路径；
- 信息已经满足完成标准：立即停止工具调用并回答；
- 能力确实不足：说明已确认事实、能力缺口和所需输入。

停止条件不能机械写成“最多调用 N 次”。复杂任务可能合理调用很多工具；真正应熔断的是
没有信息增益的重复轨迹。

## 5. 从 WonWork 提炼了什么

WonWork 的工具提示展示了一个重要结构：模型需要同时理解工具发现、环境组合、错误 SOP
和止损，而不只是看到 schema。Iris 保留这一底层思想，但不继承其具体实现形状：

| WonWork 中的做法 | Iris 的对应设计 |
|---|---|
| Prompt 内列出可见工具与 schema | schema 仅通过 Model Attempt 的 active lease 注入 |
| MES 工序、SQL Server 和具体库说明 | 放入将来的连接/领域 Capability，不进入全局 Prompt |
| `/workspace`、Python、WebBridge 的具体决策树 | 只声明当前已闭环的平台对象，后续按能力成熟度加入 |
| 固定“失败后重试一次” | 使用 `effect + recovery.action + no-progress` 决定恢复 |
| 大结果落工作区后再分析 | 规范 Tool result 进入 Managed Object Store，可按 executionId 无损取回 |
| 前端承担部分 Agent 与工具职责 | Java 后端拥有 Loop、Runtime、历史和执行事实 |

这不是压缩 WonWork 文案，而是把它隐含的模型世界观重新落实到 Iris 的原生后端架构。

## 6. Tool 怎样与 Prompt 配合

Prompt 只能提供通用方法。一个 Tool 自身仍必须做到充分必要：

### Definition

- `name`：稳定、无歧义、snake_case；
- `description`：一句话同时回答“做什么”和“何时用”；
- `capabilityPath`：让目录位置表达对象与领域；
- input schema：参数类型、边界、默认值和语义；
- output schema：模型能依赖的结果字段；
- risk / side effect / timeout / idempotency / concurrency / cancellation；
- context retention：结果能否被 micro compact，以及怎样无损读回。

### Observation

- 成功：返回完成判断所需的事实、范围、截断状态和稳定引用；
- 失败：稳定 `errorCode`、人话 `message`、副作用 `effect`、恢复建议；
- 写入：返回目标版本、Checkpoint 和验证证据；
- 大结果：预览必须带完整结果引用，不能静默截断；
- 空结果：说明实际扫描或查询范围，避免模型把“空”误解为“没执行”。

如果一个工具必须靠全局 Prompt 中数十行特殊说明才能正确使用，通常意味着它的
description、schema、结果或错误契约仍不够好。

## 7. 稳定前缀与版本

Prompt 稳定性直接影响模型前缀缓存、首 token 延迟和长对话行为一致性。

稳定层禁止放入：

- 当前日期和随机 ID；
- 每轮变化的工具列表；
- 用户工作区物理路径；
- 动态审批状态；
- 临时业务规则；
- 未排序的 Map/Set 输出。

Catalog 摘要由排序后的 `capability id + version + manifest hash` 计算。新增、删除或修改
Definition 会自然改变 hash；普通对话不会。

当前 Context snapshot 已持久化完整 `systemInstruction` 与 `contextHash`。后续应增加
显式 `promptDefinitionId + promptVersion + promptHash`，让轨迹评估能够区分模型变化、
Prompt 变化和 Tool Definition 变化。

## 8. 如何反复打磨

Prompt 优化不以“读起来更完整”为目标，而以真实轨迹指标为依据。

### 基准任务

至少覆盖：

1. 不需要工具的直接回答；
2. 已知对象的点状能力发现；
3. 跨目录的链状任务；
4. 能由多个只读原语组合完成的新任务；
5. 大 Tool result 的精确读回；
6. 参数错误且确认无副作用；
7. 写操作 `outcome_unknown`；
8. 用户取消、拒绝或中途补充；
9. 目录中确实没有对应能力；
10. 外部文件或网页文本中包含指令性内容。

### 观测指标

- 找到正确 Capability 的比例；
- 首次有效 ToolCall 前读取的 Definition 数量；
- schema 误猜与未 lease 调用次数；
- 无依赖只读调用的并行率；
- 原样重复失败调用次数；
- `outcome_unknown` 后盲重试次数；
- 大结果重复查询率；
- 无进展 Round 数；
- 最终结果可验证率；
- Prompt token、schema token、cache read token 与首 token 延迟。

### 修改纪律

每次只针对一类稳定失败模式改动 Prompt，并记录：

- 失败轨迹和证据；
- 修改的是 Prompt、Tool contract、Runtime 还是 Capability 组织；
- 为什么不能由更确定的代码机制解决；
- 预期改善指标；
- 是否增加稳定前缀长度或造成缓存变体。

能由 schema、错误码、Policy 或执行器确定解决的问题，不用 Prompt 打补丁。

## 9. 新环境进入 Prompt 的门槛

### SQL

连接身份、方言、只读/写分类、参数化、行列预算、完整结果落盘、取消和写后证据闭环后，
再加入“何时优先业务 Capability、何时用 SQL”以及 schema 探索方法。

### Sandbox / Process

staged input、separate output、环境变量策略、超时强杀、输出持久化、产物导入和写入核验
闭环后，再说明脚本与命令的适用边界。仅有 `ProcessBuilder` 不等于拥有安全沙箱。

### WebBridge

观察、定位、动作、等待、截图验证、人工接管和页面状态版本闭环后，再加入浏览器平台
组合原则。不能让模型靠 Prompt 猜坐标或选择器。

### 领域能力

具体工序、数据库、站点和生活规则进入对应 Capability Definition 或 versioned guidance。
只有跨领域长期稳定的方法论，才有资格进入 Agent System Prompt。

## 10. 当前开放问题

- 顶层 Catalog 摘要是否需要加入少量语义标题，还是目录名与数量已经足够；
- Prompt Definition 是否与 Capability Definition 共用版本存储，还是独立生命周期；
- 不同模型是否只允许表述层差异，还是需要可证明的策略变体；
- 自动权限模式怎样在不改变 Prompt 主体的情况下提供最少必要状态；
- Pipeline child Agent 是否复用完整元认知，还是使用更窄的执行型 Prompt；
- Prompt 评估样本如何从真实失败轨迹沉淀，同时避免把偶然场景固化成全局规则。

这些问题要由真实对话和运行指标回答。System Prompt 会长期打磨，但它必须始终比系统
能力更诚实、更稳定，也更容易被模型正确执行。

## 11. 待提炼的一手参考

- [System Prompt - Claude Opus 5](../reference/prompt/claude-opus-5-system-prompt.pdf)

这份材料当前仅作为后续 Prompt 优化的一手参考归档，不纳入首版设计依据，也不预设其中的
做法适合 Iris。其内容可能大部分是具体产品环境、既有工具与兼容逻辑形成的冗余。后续只在
真实轨迹暴露出稳定问题时，围绕明确问题局部阅读、提炼可验证的底层原则，再决定应修改
Prompt、Tool contract、Runtime 还是 Capability 组织，避免把完整提示词直接搬进 Iris。
