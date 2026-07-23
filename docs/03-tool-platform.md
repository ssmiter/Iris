# 03 · 工具平台：1000+ 工具的后端能力设计

> 本文是 Weave 后端的核心文档。目标：当工具从 20 个涨到 1000 个乃至 10000 个时，
> 模型找得到、调得对、管得住，而系统结构不需要任何范式变化。

## 1. 设计原点

工具的三种命运：

| 数量级 |  naive 做法 | 后果 |
|---|---|---|
| ~20 | 全部 schema 塞进系统提示 | 可行 |
| ~1000 | 全部塞进 | 上下文爆炸、模型选择困难、成本失控 |
| 10000+ | 塞？ | 物理不可能 |

唯一可扩展的答案：**工具像文件一样按目录组织，模型像人一样按目录找**。
本设计把"如何组织与呈现工具"与"工具本身的实现"彻底解耦——加第 1001 个工具 = 在对的目录放一个文件，零配置。

## 2. 工具契约（Tool Contract）

一切工具实现同一接口，前后端同形状：

```java
public interface Tool {
    String name();                 // snake_case，全局唯一：query_express
    String description();          // 一句话，发现时的唯一线索，必须写清"做什么+何时用"
    String path();                 // 能力树路径：/finance/express —— 由所在目录推断，见 §4
    RiskLevel riskLevel();         // read_only / standard / elevated / destructive
    JsonNode parametersSchema();   // JSON Schema（发现阶段按需读取）
    ToolResult execute(JsonNode args, ToolContext ctx) throws Exception;
}

public enum RiskLevel { READ_ONLY, STANDARD, ELEVATED, DESTRUCTIVE }
```

风险等级语义：

| 等级 | 含义 | 默认行为 |
|---|---|---|
| read_only | 不改变任何外部状态 | 直接执行 |
| standard | 常规操作（如创建本地草稿） | 直接执行，记录审计 |
| elevated | 写操作（改文件、发请求、提交表单） | **审批挂起** |
| destructive | 删除、支付、不可逆 | 审批挂起 + 醒目标记 |

## 3. 注册表（ToolRegistry）

- 启动时扫描 `tools/<domain>/<dir>/**` 下所有 Tool 实现注册；
- 双索引：按类实例 + 按 `name()` 的 `Map<String, Tool>`（snake_case 调用 O(1) 命中，避免 O(N) 遍历兜底）；
- 注册即校验：name 冲突、缺 description、缺 path → 启动失败（fail-fast，问题留在开发期）。

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

`GET /api/capabilities/tree` 返回目录树，**每个目录节点带统计**：

```json
{
  "path": "/travel",
  "name": "出行",
  "toolCount": 128,
  "children": [
    { "path": "/travel/train", "name": "火车", "toolCount": 45, "children": [] },
    { "path": "/travel/hotel", "name": "酒店", "toolCount": 39, "children": [] }
  ]
}
```

统计是模型的方向感："这个目录有 128 个工具"比"有个目录"更能引导探索。统计在启动时一次计算、注册变化时增量更新。

## 6. 发现原语（模型可调用的三个元工具）

| 原语 | 作用 | 要点 |
|---|---|---|
| `list_capabilities(path?)` | 看目录树（带统计） | 顶层调用返回各域与工具数；懒加载，不返回 schema |
| `read_capability(path)` | 读某工具完整 schema | 一轮建议 ≤5 个；读完才可调用 |
| `tool_search(query, limit?)` | 关键词搜索 | 覆盖 name/description/目录段/参数名；返回 total 让模型知道截断 |

**搜索索引**：内存倒排（name、description、中英文 description、目录段、参数属性名）。1000 量级内存索引足够；上万再换 Lucene。

### 系统提示中的元认知注入

系统提示必须包含（见 docs/06 §系统提示组装）：

- 当前已加载的域及各自工具数（"你当前可见：/finance 128、/travel 87…其他域已过滤"）；
- 发现流程五步法（意图→目录统计→读 schema→必要时澄清→调用）；
- 禁令：不凭名字猜参数、不调用未读 schema 的工具、单轮读 schema ≤5。

## 7. 审批闸门（ApprovalGate）

elevated/destructive 工具执行前挂起：

```
模型调用 → 执行器识别风险 → 生成 ApprovalRequest
  { toolCallId, toolName, impactStatement, rawParams, riskLevel, expiresAt }
→ SSE 推送到前端 → 对话框上方浮出审批条
→ 用户批准/拒绝（或超时过期）→ 结果回注模型
```

- **impactStatement 必须是人话**：不说"调用 write_file"，说"将覆盖 ~/Documents/旅行清单.md（原有 2.3KB 内容）"。由工具的 `describeImpact(args)` 方法生成，写工具时必实现；
- 会话级权限模式：全部自动 / 读自动写确认 / 全部确认 / 沙箱禁写——模式只提升严格度，永不降低工具自身风险等级的判定（fail-close）；
- SQL 类工具单独分类器：SELECT/PRAGMA 放行，写操作审批；
- 超时（默认 5 分钟）自动过期为 rejected。

## 8. 执行器（ToolExecutor）

统一入口：风险检查 → 审批（如需）→ 执行 → 审计日志 → 结果截断。

- **结果截断**：工具输出 >N tokens 时截断并提示（防上下文被一次查询塞爆）；
- **审计**：每次执行记录（时间/工具/参数摘要/结果大小/审批人），SQLite 单表；
- **超时与取消**：每个工具声明超时；用户停止对话时传播取消信号（`ToolContext.cancelled()`）。

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
- [ ] 声明了真实的风险等级
- [ ] 写操作实现了 describeImpact（人话）
- [ ] 参数有 JSON Schema 且每个属性有描述
- [ ] 超时合理，大结果会自截断
