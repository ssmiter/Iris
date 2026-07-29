# 03 · 工具平台：面向千级能力的后端设计

> 本文是 Iris 后端的核心文档。千级能力是压力目标，不是首版 KPI：模型要找得到、调得对、管得住，真实指标再决定索引和存储方案。

## 1. 设计原点

工具的三种命运：

| 数量级 |  naive 做法 | 后果 |
|---|---|---|
| ~20 | 全部 schema 塞进系统提示 | 可行 |
| ~1000 | 全部塞进 | 上下文爆炸、模型选择困难、成本失控 |
| 10000+ | 塞？ | 物理不可能 |

第一层可扩展答案是：**目录提供稳定地址，模型通过目录、搜索和情境视图逐步发现**。目录之外还需要 Working Set 与 Definition 生命周期，见 §6.1；搜索、对象、来源和个人别名是可重建视图，不必强行归入唯一树形本体。
本设计把“如何组织与呈现工具”与“工具本身的实现”解耦。加第 1001 个工具不需要中心路径映射，但绝不是零声明：Manifest 的 schema、风险、幂等、资源和证据字段缺一不可。

## 2. 工具契约（Tool Contract）

Tool 不是前后端同形状的裸函数。Frontend 只看到安全 Manifest 投影；Backend Registry 绑定精确实现，Tool Runtime 是唯一调用者。

```java
public interface Tool {
    ToolManifest manifest();
    PreparedOperation prepare(JsonNode input, ToolContext context);
    ToolOutcome execute(CommittedOperation operation, ToolContext context);
    VerificationResult verify(ToolOutcome outcome, ToolContext context);
}

public enum RiskLevel { READ_ONLY, STANDARD, ELEVATED, DESTRUCTIVE }
```

Manifest 的完整字段见 docs/02 §9；至少包含 identity、input/output schema、safety、runtime 和 outcome。`capabilityPath` 对外存在，但本地 Tool 由所在目录/package 派生，类内不能手写第二份路径。

风险等级语义：

| 等级 | 含义 | 默认行为 |
|---|---|---|
| read_only | 不改变任何外部状态 | 可直接执行，仍受身份、围栏和预算限制 |
| standard | 低影响、可回滚写入 | 审批挂起 |
| elevated | 发送、提交、覆盖或敏感访问 | 强审批、短过期 |
| destructive | 删除、支付、不可逆 | 强审批 + 额外核验；部分首版禁用 |

### 2.1 两层能力，不是两套平台

- **系统原语能力**负责客观观察、变换、行动和验证，接口尽量小、可组合、可单独测试；
- **生活领域能力**负责把真实场景中的对象、前置条件、成功证据和常见缺口说清楚，可以实现为领域 Tool、版本化 Pipeline 或 guidance；
- 两层都注册为 Capability，遵守同一发现、版本、审批、证据和历史规则；领域能力不得绕开 Tool Runtime；
- Agentic 负责在未知任务中发现并组合它们。长期竞争力来自高质量生活能力，而不是 Tool 数量或 Loop 复杂度。

## 3. 注册表

- `ToolRegistry` 启动时扫描 `tools/<domain>/<dir>/**` 下的 Tool，实现 `manifest.id + version → validated manifest + executor` 精确绑定；
- `PipelineDefinitionRegistry` 独立保存版本化固定流程及其冻结依赖；Pipeline **禁止实现 Tool 接口**；
- `CapabilityCatalog` 是两个 Registry 加 guidance 等来源的可重建 union view，不拥有执行身份；
- 注册即校验：name/path 冲突，或缺 description、schema、安全、幂等、资源、超时和证据策略 → 对应 provider registration rejected；其他 provider 仍可继续启动。

## 4. 目录即路径（DomainCatalog）

**铁律：文件目录 = 能力树路径，不允许第二套映射。**

```
tools/finance/express/QueryExpressTool.java   → /finance/express/query_express
tools/travel/train/QueryTicketTool.java       → /travel/train/query_ticket
tools/job/resume/FillFormTool.java            → /job/resume/fill_form
tools/life/notes/AppendNoteTool.java          → /life/notes/append_note
tools/industry/mes/_02mixing/_02plan/...     → /industry/mes/_02mixing/_02plan/...
```

路径由命名空间/包名推断（`tools.finance.express` → `/finance/express`），推断规则集中在 `DomainCatalog` 一个静态类中：

1. **通用工具集**：任何域都可见的基础工具（文件、搜索、计算）；
2. **受限域排除集**：某些域不暴露特定能力（如 `guest` 域不可见支付/写文件工具）；
3. **段语义标签**：目录段的通用语义词典（query/create/update/notify/sync 等动作词 + express/train/resume 等对象词），用于生成目录的展示名与搜索提示，与具体业务无关。

这里的“目录即路径”约束的是本地 provider **如何声明初始语义位置**，不意味着把
class 文件目录当持久化数据库。Capability Catalog 是独立的语义命名空间：

- 稳定身份是 `capabilityId + definitionVersion`，路径是该版本的发现位置；
- SQLite 保存已被接受或被历史引用的 Definition metadata、schema hash、snapshot
  reference 与生命周期事实；
- Registry 启动时把当前 provider binding 绑定到精确 Definition；实现缺席只改变
  availability，不删除历史 Definition；
- Catalog 树、统计和倒排搜索是可从 Definition 重建的投影，不是第二份执行真相；
- 以后移动能力目录时发布新 Definition version 或显式 alias，不能原地改写旧
  ToolCall 所引用的路径。

模型看到的是 `capability://<capabilityId>@<version>` 与 `/domain/path/name` 这样的
语义地址，不看到 Java class、SQLite row id 或对象仓物理路径。

### 4.1 `/system/files`：工作区文件原语

文件原语是通用 Agentic 内核的一部分，不属于代码 IDE 特例。只读观察底座包含三个能力：

| capability path | name | 作用 | 关键边界 |
|---|---|---|---|
| `/system/files/list_files` | `list_files` | 确认目录结构与候选文件 | 稳定排序、深度与数量预算、不跟随目录链接 |
| `/system/files/search_files` | `search_files` | 在工作区文本或只读语义目录中定位事实 | 默认字面量、可选正则、范围与命中预算、零命中也返回扫描证据 |
| `/system/files/read_file` | `read_file` | 按行读取一个文本文件 | 行号、范围、字符预算、编码与二进制识别、给出下一段游标 |

- 三个 Tool 都放在 `tools/system/files/`，因此目录路径天然一致；它们属于常驻工作区原语，
  模型可直接使用。
- 默认 `namespace=workspace`，输入只使用工作区逻辑相对路径，输出也只暴露 `/` 分隔的逻辑路径，不把 Windows 盘符和实际工作区根写入模型上下文。
- `search_files(namespace=capabilities)` 复用同一个“定位描述”原语搜索 Capability Catalog；此时 `path` 是能力绝对目录，结果路径可直接交给 `read_capability`。它只复用模型接口，不把 Capability Definition 伪装成物理工作区文件，也不允许 `read_file` 或写工具进入该命名空间。
- 有界输出不是静默丢弃：结果必须带 `truncated`、实际扫描范围与可继续行动的提示。搜索零命中也要说明扫描了多少文件、跳过了什么。
- `read_file` 与 `search_files` 只处理文本；图片、PDF、Office 等以后由内容类型专用原语处理，不能把二进制误解码后塞入上下文。
- 路径解析、链接围栏、编码检测与遍历策略由共享 Workspace 层实现。Tool 只负责契约、输入归一化和结果投影，禁止各自复制一套安全判断。
- `write_file / apply_patch / move_file / delete_file` 沿用相同逻辑路径和共享 Workspace 层，
  并经过 Operation Snapshot、策略、版本复核和 Checkpoint。

上下文恢复原语单独位于 `/system/context/read_tool_result` 与
`/system/context/query_tool_result`。前者按
`execution_id + start_character + character_count` 读取 Runtime 已持久化的完整结果，
后者以 JSON Pointer 精确选择节点并对数组或对象分页；两者都不混入 `/system/files`，
因为 Tool output 的规范身份属于对话执行历史，而不是用户文件。
这让“结果可找回”与“工作区不被系统缓存污染”同时成立。

### 4.2 `/industry`：脱敏工业能力样例

工业业务能力沿用同一 Capability Catalog 和 Tool Runtime，不另造一套“业务插件”
协议。首批样例从真实 MES 的组织经验中提炼，但只保留通用制造语义：

```text
/industry
  /mes
    /_01raw/inventory             原材料与库存
    /_02mixing
      /_02plan                    密炼计划及执行进度
      /_06equipment               停机与故障事件
      /_07quality                 胶料检验与质量汇总
    /_03semifinished              半制品
    /_04forming                   成型
    /_05curing                    硫化
    /_06quality                   成品质量
    /_07warehouse                 仓储
    /_11equipment/status          设备当前状态
    /_12technology                工艺与配方
    /_13mould                     模具
  /mens                           密炼执行系统目录骨架，暂不注册具体工具
```

- 路径表达“业务域 → 工序 → 业务对象”，序号只稳定展示顺序，Capability 的身份仍是
  `capabilityId + definitionVersion`；
- `CapabilityDirectoryCatalog` 允许语义目录先于具体 Tool 存在；空目录必须带人话说明并
  返回 `capabilityCount=0`，它只是地图，不产生 schema lease，也不能被调用；
- 样例中的企业、数据库、表、存储过程、物料、设备、人员和真实质量口径全部被替换；
  SQLite 只保存可公开理解的模拟制造数据，不能反推出参考系统；
- 全部样例能力共用一套数据模型、参数归一化、查询网关和只读工具生命周期；薄的领域
  Tool 只负责固定域、准确描述用户意图与声明 schema，禁止复制 SQL 与边界判断；
- 领域查询只读、可并行、结果可重取。它们不进入基础 schema lease，只有目录列举、
  搜索或精确读取 Definition 后才进入当前 Run Working Set；
- `query_sql` 仍是结构化数据的客观缺口出口；口径稳定、用户高频表达的业务问题才沉淀
  为领域 Capability。领域工具不是把每个页面或每张表机械映射成一个函数；
- 当前个人模式可观察全部目录。以后登录选域只收窄 Catalog 可见性和 Runtime 执行授权，
  不改变工具路径、Agent Loop 或模拟数据契约。

### 4.3 `/system/math`：客观计算原语

`calculate` 使用确定性的十进制表达式求值器处理 `+ - * / % ^`、括号与一元正负号，
由输入声明有效数字精度和固定舍入规则。金额、比例、工时和产量等计算不交给语言模型
猜测；首版不混入单位换算、日期或业务公式，这些语义以后由独立能力组合。

### 域过滤（FilterBySystem）

每个会话有系统/身份码（个人版默认 `personal`），决定可见域：

- 规则集中在 DomainCatalog，**注册表与能力服务调用同一处**——历史上最大的 bug 来源就是两处过滤规则不一致；
- 未知身份 fail-close（只看到通用工具），不 fail-open。

## 5. 能力树与统计（CapabilityService）

`GET /api/v1/capabilities?parentPath=/travel` 返回目录和 discovery card，**每个目录节点带统计**：

```json
{
  "parentPath": "/travel",
  "directories": [
    { "path": "/travel/train", "title": "火车", "capabilityCount": 45 },
    { "path": "/travel/hotel", "title": "酒店", "capabilityCount": 39 }
  ],
  "items": [],
  "nextCursor": null
}
```

统计是模型的方向感：“这个目录有 128 个 Capability”比“有个目录”更能引导探索。统计在启动时一次计算、注册变化时增量更新。

## 6. 发现接口（两个元工具 + 一个共享搜索原语）

| 原语 | 作用 | 要点 |
|---|---|---|
| `list_capabilities(path?)` | 看目录树（带统计） | 顶层调用返回各域与工具数；懒加载，不返回 schema |
| `read_capability(path)` | 读取精确 Capability Definition | 返回判别联合 `ToolManifest | PipelineDefinition | GuidanceDefinition` |
| `search_files(namespace="capabilities", query, path?)` | 定点搜索能力描述 | 复用文件搜索心智，覆盖 name/description/目录段/参数名；结果按能力聚合并返回扫描证据 |

`list_capabilities` 与 `read_capability` 位于 `/system/capabilities`；`search_files`
仍只有 `/system/files` 下的一份 Definition，通过显式 namespace 路由到只读 Catalog
projection。基础 lease 不再等同于“只给模型一张工具目录”：它固定保留两个目录入口，
以及 `list_files / search_files / read_file / make_directory / write_file / apply_patch`
这组有界的工作区原语，并保留 `read_tool_result / query_tool_result` 两个结果读取原语。
后者必须与 Context micro-compaction 同时可用，否则系统虽然能把旧结果收敛成引用，模型却
不能立刻读回。常见的观察、创建与局部编辑因此可以直接开始；复制、移动、删除、恢复等
低频或影响更大的操作仍按需发现。系统不再注册语义重复的 `tool_search`。
一次有界的 Capability 搜索会把其 `available` 命中作为下一 Model Step 的预激活候选；
列举到叶目录时，当前目录直接返回的 `available` items 也形成同一短期候选组，但上层目录
不会递归激活后代。`read_capability` 的成功 observation 则把精确 Definition 作为更高
确定性的候选。三者都不直接等于 active lease：候选仍须通过当前 availability 与独立
schema token budget，只有实际进入 Exposure 的工具才允许调用。基础原语是
不可逐出的 required 集合；其余候选来自当前 Run 已发生的有界搜索命中、成功 inspect，
以及本 Run 实际调用过的能力。首版以 Run 作为 Working Set 的稳定作用域：新候选按首次
激活顺序追加；上一 Round 已形成的不可变 Exposure 是下一轮的 Working Set 基线，
Run 内不因几个快速 Round 没有使用就抖动或重排，Run 结束后整体释放。
新 Run 只把同一分支上一 Run 真正调用过的能力及其叶目录作为一次有界暖启动；若本 Run
没有继续使用，该能力组不会再传给下一 Run。这样“继续刚才的任务”无需重新发现，也不会
把整个对话曾经出现过的 schema 永久累积到后续上下文。
浏览器 Session、待审批操作和 outcome_unknown 等活对象另有资源生命周期，后续可用显式
pin 续接到下一 Run，不能与 schema lease 的释放混为一谈。若上一 Round
的工作区写入形成 `outcome_unknown` 且确有 Checkpoint，策略会直接激活
`inspect_workspace_change`，使安全恢复不再额外经过一次目录发现。
超出预算的 Definition 不进入本轮 Exposure，但不会从目录或历史中删除；后续 Round
仍可重新 inspect。候选数量上限只用于约束查询成本，不能替代 token budget。这样既
避免长对话把曾经检查过的所有工具永久泄露进上下文，也避免少数巨型 schema 挤掉
用户请求和工具观察。

**搜索索引首版基线**：Java 后端在 Registry 完成校验后编译紧凑的结构化搜索文档
（name、description、目录段、参数属性名、风险与副作用），查询直接在内存 projection
上完成，不生成 Markdown、不经过前端、不维护第二份执行真相。先用召回率、误选率、
schema token 成本和延迟观察真实数据；只有规模和轨迹证明线性扫描不够时，才替换为
倒排、Lucene 或向量混合索引，模型侧契约保持不变。

### 6.1 能力 Working Set 与生命周期

“加载能力”必须拆成四个独立生命周期，不能用一个布尔值混在一起：

```text
常驻轻量 Catalog index
→ 按需读取 Definition
→ 当前 Model Step 的 active schema lease
→ 调用时取得 executor 与外部资源
```

- Catalog index 像目录项，只保存发现所需的紧凑字段，不意味着 schema、实现或连接都已载入；
- 少量跨任务高频且可组合的基础原语随每个 Model Step 常驻，其范围由真实轨迹收敛，
  不是把某个完整工具域永久塞入上下文；
- Definition 可以被预取和缓存，但只有预算明确准入后才进入模型的 active lease；
- 无状态 Java executor 可以保持轻量 binding；插件、脚本、远程 Provider 等重实现以后由
  lazy executor handle 在首次调用前物化，不要求 JVM 卸载普通工具 class；
- 数据库连接、浏览器会话、进程和临时产物在 prepare/execute 时创建或从池中借出，
  按调用、会话或 TTL 回收，不能被 Tool 单例偷偷永久持有。

几千个 Capability 被良好组织，不代表一次长对话可以无限累计 schema。每个 Model Step 从三个层次按需收敛：

```text
Capability Card → inspected Manifest → active schema lease
```

- Card 只给 ID、path、kind、description、version、risk 与 availability；
- inspect 一次只读取少量精确 Definition，数量由 schema token budget 和任务歧义决定，不写成协议硬上限；
- active schema 先受独立 schema token budget 限制，再与历史事实共同接受整个
  Context Window 预算；预算决策和遗漏数量进入不可变 Context snapshot；
- 下一 Model Step 重新计算相关性，未继续使用的 schema 逐出；
- 首版不使用“连续 N 个 Round 未调用”作为淘汰条件；一个 Run 内保持有界且顺序稳定，
  只在发现边界成批追加，以免多步 Agentic Loop 和 provider 前缀缓存因每轮抖动受损；
- canonical ToolCall/Exposure 永久保存 provenance；CompactBoundary 只带 source range、summary/fact refs 和明确需要的少量 capability hints，不复制全部历史 ID 或 schema；
- Pipeline pin 精确 Definition snapshot/hash 和依赖 Manifest version，不依赖模型工作集里“碰巧还留着”；
- Pipeline 的固定 Tool 依赖不占模型 Working Set；只有某个 model node 实际收到 Tool schema 时才创建 Exposure，每个 tool node 独立创建 ToolCall + ToolExecution。

Definition status 只有 `active / deprecated / retired`；注册校验是一次性的 `accepted / rejected` 结果；当前 binding availability 是独立的 `available / degraded / unavailable + checkedAt / lastSeenAt`。`CapabilityExposure` 又是某个 Context/attempt 实际看到精确 schema 的不可变事实，ToolExecution 则是一次调用状态。历史引用永远可读；客户端重启时重建 Registry/Catalog 和 binding availability，不删除缺席 provider 的历史。

Availability 由当前 Application/Environment probe 产生，并贯穿 Card、Definition、
active lease 与 Runtime 提交前核对。`unavailable` Definition 仍可发现和读取，以便模型
解释缺少的连接、进程或会话，但不能进入可调用 lease；`degraded` 可以进入 lease，同时
必须把限制原因暴露给模型。Registry 中存在 Java class 只证明 executor binding 已注册，
不等于它依赖的数据库连接、浏览器 daemon 或编程环境当前可用。

### 系统提示中的元认知注入

系统提示必须包含（见 docs/06 §系统提示组装）：

- 一个有界 Catalog snapshot summary（epoch/hash + 少量 top-level roots），以及恒定可用的
  目录入口和工作区基础原语；它不永久罗列所有已加载域；
- 发现流程五步法（意图→目录统计→读 schema→必要时澄清→调用）；
- 禁令：不凭名字猜参数、不调用未获得 active lease 的工具；inspect 数量受 schema token budget 约束。

## 7. 审批闸门（Approval）

除 `read_only` 外，任何改变外部状态的 Tool 在执行前挂起：

```
模型或 Pipeline 提交 Invocation
→ Runtime prepare / preflight
→ 冻结不可变 Operation Snapshot
→ 生成 ApprovalRequest
  { approvalId, toolExecutionId, snapshotHash, impactStatement,
    affectedResources, targetVersions, riskLevel, expiresAt }
→ SSE 推送到前端 → 对话框上方浮出审批条
→ 用户批准/拒绝（或超时过期）
→ Commit Gate 再核验 → 执行 / 失效 → 结果回注
```

- **impactStatement 必须是人话**：不说“调用 write_file”，说“将覆盖 workspace/旅行清单.md（原有 2.3KB 内容，已创建检查点）”；它来自 PreparedOperation 的安全预览；
- 前端只提交 `approvalId + decision + snapshotHash + expectedVersion`，不能把 raw params 或 `approved=true` 当事实；
- 会话级权限模式只能提升严格度，不能让写动作免批（fail-close）；
- SQL 类工具单独分类器：SELECT/PRAGMA 放行，写操作审批；
- 超时（默认 5 分钟）进入独立 `expired` 终态，不伪装成用户 `rejected`。

## 8. 执行器（ToolExecutor）

统一入口：

```text
normalize → validate → durable claim → prepare → snapshot
→ policy / approval → Commit Gate → execute → verify → evidence / reconcile
```

- **结果截断**：工具输出 >N tokens 时截断并提示（防上下文被一次查询塞爆）；
- **审计**：执行前已经保存 Manifest version、action hash、资源、审批和状态；日志不是事后补一行；
- **超时与取消**：每个工具声明超时；停止向下传播，但已经可能生效的动作进入 verify/`OutcomeUnknown`，不能直接当作失败重试；
- **唯一入口**：Agentic、Pipeline、Controller、Cron、MCP 与 WebBridge 都不能直接获得 Tool 实例。

## 9. SQL 工具的路由（可选能力）

个人版默认用 SQLite；若接入外部数据库，SQL 环境分为连接目录、语句分析、执行与结果
证据四层：

| capability path | name | 作用 |
|---|---|---|
| `/data/sql/list_sql_connections` | `list_sql_connections` | 返回模型可用的安全连接 metadata，不暴露 URL 与凭据 |
| `/data/sql/inspect_sql_schema` | `inspect_sql_schema` | 有界观察表、视图、列、主键与外键，把结构化对象映射给模型 |
| `/data/sql/query_sql` | `query_sql` | 在声明为只读的连接上执行一条被分析器确认为只读的参数化 SQL |
| `/web/browser/list_browser_runtimes` | `list_browser_runtimes` | 发现本机浏览器 Runtime 及可用性，不暴露 daemon 地址与令牌 |
| `/web/browser/list_browser_sessions` | `list_browser_sessions` | 读取仍存活的短期 Session/Page 引用，明确识别失效对象 |
| `/web/browser/open_browser_session` | `open_browser_session` | 创建短期 BrowserSession/Page；改变本机 Application 状态并默认审批 |
| `/web/browser/observe_browser_page` | `observe_browser_page` | 读取有界 Page Observation 与当前 revision 的短期元素引用 |
| `/web/browser/wait_browser_page` | `wait_browser_page` | 在 daemon 内等待变化/ready/文本，只向上下文回流最终 Observation |
| `/web/browser/navigate_browser_page` | `navigate_browser_page` | 在期望 Observation 上执行幂等导航，并返回新 Observation 与证据 |
| `/web/browser/click_browser_element` | `click_browser_element` | 消费当前 Observation 的短期元素 ref；准备时生成可读影响，提交时拒绝过期页面 |
| `/web/browser/fill_browser_field` | `fill_browser_field` | 填写可安全持久化并重读的普通文本字段；敏感类型 fail-close |
| `/web/browser/select_browser_option` | `select_browser_option` | 使用 Observation 给出的 option value 修改原生下拉框并重读 |
| `/web/browser/capture_browser_screenshot` | `capture_browser_screenshot` | 图像字节直接进入 Managed Object Store，模型只接收稳定对象引用与 metadata |
| `/web/browser/inspect_browser_action` | `inspect_browser_action` | 按原 execution/idempotency identity 读取 daemon 动作日志，不产生第二次动作 |
| `/web/browser/close_browser_session` | `close_browser_session` | 显式释放短期 Session/Page handle；历史 Observation 与 ToolCall 仍保留 |

- 按连接标识路由到对应数据源（demo SQLite / 个人 PostgreSQL）；
- 只读账号连接外部库（数据库层兜底，不只靠应用层）。
- Connection Definition 只暴露稳定 ID、方言、说明和读写能力，不暴露 JDBC URL、账号
  或密码；缺少当前 provider binding 时保留历史 Definition，但 availability 为 unavailable。
- SQL 先经过理解字符串、引用标识符、注释、括号深度和 CTE 的词法分析；无法确定读写
  时返回 ambiguous 并 fail-close，不能用关键词正则默认放行为 SELECT。
- `query_sql` 与未来 `execute_sql` 是两个 Tool：前者静态 `read_only`，允许并行且只接受
  分析器确认的读语句；后者静态写契约，经过 Operation Snapshot、策略、事务提交和
  verify。拆分源于副作用与恢复语义不同，不是为了增加工具数量。
- 参数和值必须走 JDBC bind，连接 ID、标识符和 SQL 文本不能相互替代；查询设置超时、
  行列与单元格预算，规范完整结果仍由 Tool Runtime 落 Managed Object Store，并通过
  `query_tool_result / read_tool_result` 按需取回。
- `query_sql.parameters` 首版采用与 `?` 占位符顺序一致的标量数组；列 metadata 与行值
  分离返回，避免重复列名覆盖，超预算单元格明确标记截断。
- 业务口径明确时优先领域 Capability；SQL 是结构化数据的客观原语和缺口出口，不在
  System Prompt 中预设某家工厂的表名或查询 SOP。

本地 adapter 在被忽略的 `application-local.yml` 中配置；连接 ID 是模型可见的稳定对象
身份，URL 与凭据不是：

```yaml
iris:
  sql:
    connections:
      mes_read:
        title: MES 只读库
        description: 生产、工单与设备的只读分析连接
        dialect: SQLITE
        access-mode: READ_ONLY
        url: jdbc:sqlite:file:E:/data/mes.db?mode=ro
```

账号密码若暂时通过配置注入，只能放在本机忽略文件或环境变量；它们不进入 Manifest、
Capability snapshot、Tool observation 或日志。最终 Windows 产品仍应切换到经过验证的
凭据存储 adapter，不能把本地 YAML 当作终态秘密方案。

## 10. 扩展路线：1000 → 10000

| 手段 | 何时引入 |
|---|---|
| 目录树 + 发现原语 | 第一天 |
| 内存倒排搜索 | 第一天 |
| 搜索结果域洞察（"匹配主要集中在 /travel/train"） | >500 工具 |
| 命名空间懒加载（未访问域不实例化工具） | >1000 工具 |
| Lucene/向量混合检索 | >5000 工具或语义查找明显失效时 |

**不做的事**：不为工具数量发明新 UI；不让模型预读全量 schema；不在工具接口里塞业务特例（特例进工具自己的实现）。

## 11. 检查清单（新工具入库前）

- [ ] name snake_case 且全局唯一
- [ ] description 一句话说清"做什么、何时用"
- [ ] 放在正确目录（路径自动正确）
- [ ] input/output JSON Schema 完整且属性有描述
- [ ] 显式声明 risk、side effect 和 approval policy
- [ ] 能由输入生成 Resource Claims、目标版本和人话影响
- [ ] 声明幂等、verify/evidence 和 recovery 语义
- [ ] 超时、结果预算和并发策略合理
- [ ] 写操作经过 Operation Snapshot 和审批，测试路径也不能绕过 Runtime
