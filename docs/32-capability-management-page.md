# 32 · 统一能力管理页

> 状态：已定稿待实现（M5）。回答"能力是什么、管理页管什么、不管什
> 么"。实现顺序：M5a 后端（shadowed-by + 管理查询 API）→ M5b 前端
> （CapabilityCenter 重构为统一页）。

## 1. "能力"指什么

Iris 的能力 = **能力树上的全部可寻址对象**，比 WonWork 的"工具管理"
范围更广。一棵树，六种对象，种类（kind）是切面不是分页：

| kind | 对象 | 真相源 | 写入路径 |
|---|---|---|---|
| kernel_tool | 内核工具（Java 类，包名即目录） | 代码 | 改代码，无运行时写 |
| process / template | 过程插件（`*.tool.yml` + 执行体） | 拓展根文件 | 改文件（热重扫） |
| skill | SKILL.md 技能投影 | 拓展根文件 | 改文件 |
| knowledge | 知识库文档投影 | 拓展根文件 | 改文件 |
| mcp | MCP 声明与远端工具 | `*.mcp.yml` 文件 或 DB 连接器 | 改文件 / 管理页 |
| kernel_skill | 内核技能库（DB，版本化） | DB | 管理页编辑器 |

统一的是**呈现与发现**（同一棵树、同一套目录/搜索原语），不是存储。
每个 kind 的写路径回到它自己的真相源——管理页不在文件系统之外发明
第二套状态（目录即真相）。DB 真相的对象（kernel_skill、手工 MCP 连接
器、记忆）保留现有编辑器；文件真相的对象（四种投影）在管理页**只读**，
提供"揭示所在目录"的引导，编辑动作落回文件系统。

模型侧不变量：发现与读取全树同构（叶子即可调用的可读对象，invoke 即
读取）；写与生命周期按种类分化为语义明确的动作工具。管理页是**人**的
视图，不改变模型的发现契约（docs/03、docs/31 §3 不变）。

## 2. 现有资产盘点

- `CapabilityService` 已有全树投影：tree / list / search（内核注册表 +
  Pipeline + 拓展源 + 目录元数据 + DirectoryStatsService 实时统计）。
  它是**模型原语**（`/system/capabilities` 的 list_capabilities /
  read_capability）的后端，契约不变。
- 现有 `CapabilityCenter`（Skill / MCP / 记忆三标签弹窗）是旧机制的
  分裂管理面，被吸收进统一页：Skill 编辑器与 MCP 连接器编辑作为
  kind=kernel_skill / mcp 的**详情内编辑**保留，不再是顶层分页。
- 拓展侧缺：逐件冲突裁决（现在是整根 fail-closed）与来源根追踪。

## 3. shadowed-by：从整根拒绝到逐件裁决

docs/31 §5.2 的目标语义是"rank 小者整件胜出，被遮蔽项标注
shadowed-by 且仍可寻址"。当前实现是更强的整根 fail-closed——它防止
静默双活，但让管理页说不出"谁遮蔽了谁"。M5a 改为逐件裁决：

- 换入注册表时逐件检查冲突；冲突件**不注册**，记
  `shadowed_by = 胜出件的来源标识`（provider key），同根其余件不受影响。
- 与内核工具同名：同样逐件遮蔽（内核恒胜），不再整根拒绝。
- shadowed 件仍可寻址：管理查询 API 返回它（带 shadowed_by 与来源
  文件路径）；模型目录不出现它（不产生第二活绑定）。
- 裁决记录留在内存运行时视图（随重扫重算，不落库）——扫描顺序即
  rank，重扫即重裁，无状态漂移。

这一改动只影响冲突场景：无冲突的根注册结果与现在完全一致。

## 4. 后端管理查询 API（只读）

挂在 `/api/v1/capability-admin/` 下，与模型原语（`/system/capabilities`）
完全分离——管理投影进前端，不进模型上下文（前缀缓存纪律：模型侧
system prompt 与工具清单零变化）。

```
GET /tree                     目录树：path/title/count/每层 stats（沿用
                              CapabilityService.tree + DirectoryStatsService）
GET /items?path=&kind=&q=     某目录下的对象清单：name/path/kind/
                              description/risk/availability/source{origin,
                              root, file}/shadowed_by/stats
GET /items/detail?path=       单件详情：上面的字段 + 完整定义快照
                              （manifest JSON 或 SKILL.md 正文摘要）
```

- `source.origin` 枚举：`kernel` / `extension:<root>` / `skill_store` /
  `mcp_declared` / `mcp_manual`；`extension` 附根路径与清单文件绝对路径，
  前端据此渲染"在文件夹中显示"。
- `kind` 过滤是查询参数切面，不是分页；`q` 走本地名称/描述过滤（数据
  量小，不做服务端检索——检索原语是模型的，管理页不抢）。
- 写接口不新增：kernel_skill 沿用 `/api/v1/skills`，MCP 沿用
  `/api/v1/mcp/servers`，记忆沿用现有控制器。统一页只做**读**的统一。

## 5. 前端信息架构

CapabilityCenter 从"三标签弹窗"重构为"目录树统一页"（仍是 Modal，
入口不变——视觉克制：不新增顶层导航）：

```
┌ 能力 ────────────────────────────────────────┐
│ [搜索: 名称/描述本地过滤]        [kind 切面▾] │
├──────────────┬───────────────────────────────┤
│ 目录树        │ 当前目录的对象清单              │
│ /            │ ┌ 卡片：图标+名称+kind徽标      │
│ ├ industry   │ │ 描述(clamp-2) · 风险徽标      │
│ │ └ mes      │ │ 来源徽标 · shadowed-by 标注   │
│ ├ web        │ │ [详情展开：定义快照/编辑/揭示] │
│ ├ data       │ └ ...                          │
│ └ skills     │ （目录 stats 条：tool_count 等）│
└──────────────┴───────────────────────────────┘
```

- 目录树为脊柱，kind 徽标是语义色切面（kernel 灰 / process 蓝 /
  skill 绿 / knowledge 紫 / mcp 橙 / kernel_skill 青）；风险四档沿用
  对话内工具卡片的既有色。
- 详情卡内展开（不跳页不抽屉）：文件真相对象显示来源文件路径 +
  "在文件夹中显示"；DB 真相对象内嵌现有编辑器（Skill/MCP/记忆）。
- shadowed 件灰显 + "被 X 遮蔽"徽标，点击定位到胜出件。
- 内置（rank 50）与内核件不出现删除/停用按钮（内置不可删；它们的
  真相在发行物里）。
- 动画只用于注意力锚定：树展开与卡内展开用既有 duration-fast 过渡，
  无其他动效。

## 6. 边界（本期不做）

- 知识库 / cron / board 的专门管理实现（goal 明确排除）。
- 文件真相对象的页内编辑（编辑 = 改文件，管理页只引导）。
- 启停的内存态开关（不做第二真相源）。
- 统计的新口径（沿用 `_directory.yml` 声明的三个口径）。

## 7. 里程碑

- **M5a**：逐件 shadowed-by 裁决 + 管理查询 API（§3、§4）+
  ExtensionProviderIntegrationTest 覆盖遮蔽场景。
- **M5b**：CapabilityCenter 重构为目录树统一页（§5），旧三标签的
  编辑器作为详情内编辑保留；irisApi 增加 capabilityAdminApi。
