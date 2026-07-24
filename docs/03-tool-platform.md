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
```

路径由命名空间/包名推断（`tools.finance.express` → `/finance/express`），推断规则集中在 `DomainCatalog` 一个静态类中：

1. **通用工具集**：任何域都可见的基础工具（文件、搜索、计算）；
2. **受限域排除集**：某些域不暴露特定能力（如 `guest` 域不可见支付/写文件工具）；
3. **段语义标签**：目录段的通用语义词典（query/create/update/notify/sync 等动作词 + express/train/resume 等对象词），用于生成目录的展示名与搜索提示，与具体业务无关。

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

## 6. 发现原语（模型可调用的三个元工具）

| 原语 | 作用 | 要点 |
|---|---|---|
| `list_capabilities(path?)` | 看目录树（带统计） | 顶层调用返回各域与工具数；懒加载，不返回 schema |
| `read_capability(path)` | 读取精确 Capability Definition | 返回判别联合 `ToolManifest | PipelineDefinition | GuidanceDefinition` |
| `tool_search(query, limit?)` | 关键词搜索 | 覆盖 name/description/目录段/参数名；返回 total 让模型知道截断 |

**搜索索引首版基线**：内存倒排（name、description、中英文 description、目录段、参数属性名）。先用召回率、误选率、schema token 成本和启动耗时观察真实数据，再决定是否引入 Lucene 或向量检索。

### 6.1 能力 Working Set 与生命周期

几千个 Capability 被良好组织，不代表一次长对话可以无限累计 schema。每个 Model Step 从三个层次按需收敛：

```text
Capability Card → inspected Manifest → active schema lease
```

- Card 只给 ID、path、kind、description、version、risk 与 availability；
- inspect 一次只读取少量精确 Definition，数量由 schema token budget 和任务歧义决定，不写成协议硬上限；
- active schema 受 Context token budget 和 Model Step lease 限制；
- 下一 Model Step 重新计算相关性，未继续使用的 schema 逐出；
- canonical ToolCall/Exposure 永久保存 provenance；CompactBoundary 只带 source range、summary/fact refs 和明确需要的少量 capability hints，不复制全部历史 ID 或 schema；
- Pipeline pin 精确 Definition snapshot/hash 和依赖 Manifest version，不依赖模型工作集里“碰巧还留着”；
- Pipeline 的固定 Tool 依赖不占模型 Working Set；只有某个 model node 实际收到 Tool schema 时才创建 Exposure，每个 tool node 独立创建 ToolCall + ToolExecution。

Definition status 只有 `active / deprecated / retired`；注册校验是一次性的 `accepted / rejected` 结果；当前 binding availability 是独立的 `available / degraded / unavailable + checkedAt / lastSeenAt`。`CapabilityExposure` 又是某个 Context/attempt 实际看到精确 schema 的不可变事实，ToolExecution 则是一次调用状态。历史引用永远可读；客户端重启时重建 Registry/Catalog 和 binding availability，不删除缺席 provider 的历史。

### 系统提示中的元认知注入

系统提示必须包含（见 docs/06 §系统提示组装）：

- 一个有界 Catalog snapshot summary（epoch/hash + 少量 top-level roots），以及恒定可用的发现原语；它不永久罗列所有已加载域；
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

个人版默认用 SQLite；若接入外部数据库：

- 按连接标识路由到对应数据源（demo SQLite / 个人 PostgreSQL）；
- 只读账号连接外部库（数据库层兜底，不只靠应用层）。

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
