# 27 · 工业业务域全景：脱敏 MES/APS 业务工具设计

> 状态：实施中（MES 闭环样例 + 公共骨架重构 + 目录/标签同步）
> 依据：对成熟 MES/APS 产品的业务工具面与端到端链路的调研，全部概念脱敏转述为行业标准概念——ISA-95 活动模型、MESA 功能分类、APS 两级计划体系直接沿用，不自造工业界不存在的名词；不复制任何具体企业的 SQL、表结构、字段命名或业务数据，只沉淀“工厂是怎样运转的”这一通用理解。

## 1. 目标与验收标准

把 Iris 现有工业样例补充为**贯通上下游全链路的 MES 业务样例**。不复刻任何单一产品的工具清单，也不把第二业务域当作数量证明；目标是用少量可组合能力验证 agentic 闭环（发现 → 查询 → 组合 → 写操作审批 → 追溯），并为未来真实连接器留下清晰边界。

**通用性原则**：演示工厂是一家多工序离散制造厂，但领域模型本身与行业无关——轮胎、汽车零部件、任何”原材料 → 多工序 → 最终制品”的工厂都由同一组柱子撑起：需求、计划、排产、物料、人员、设备、工艺、模具、质量、仓储、追溯、报表。密炼/成型/硫化只是这组通用柱子上的一套示例工序实例，换成冲压/焊装/涂装故事不变。

验收标准：

1. **拆分合理**：每个工具一个明确业务问题，不多不少；段（segment）按工序/横切域组织。
2. **语义明确**：工具名、路径、record_type、状态机用词一致；读工具只读，写工具显式审批。
3. **元信息充分必要**：描述必须说清”什么时候用 + 不包含什么”，输入 schema 每个参数有描述，manifest 风险/副作用/幂等/证据策略配对正确。
4. **表结构完整承载**：链路每个环节的实体都有表或明确的 record_type 承载，种子数据跨表自洽（同一批号能在计划→批次→质检→半制品→成品→仓储里走通）。
5. **Java 后端**：全部实现于 `com.iris.tools.industry` + `com.iris.industry.demo`，沿用既有骨架模式。

## 2. 业务全景（脱敏转述）

把对真实工厂的链路理解转述为通用离散制造故事：**需求 → 两级排产 → 发布 → 四工序执行 → 质检 → 仓储 → 发运**，人员/设备/工艺/模具横向支撑，执行数据回写驱动滚动重排。

```
需求订单 demand_order（客户要什么、多少、何时交）
   │
   ▼ AP 主计划 master_plan（天粒度、长周期、模具即资源，revision 版本化）
   │
   ▼ 齐套：物料需求（原料库存核对）＋ 工单
   │
   ▼ AS 班次排程 schedule（机台×班次粒度、短周期；先排瓶颈工序硫化，再反推上游）
   │
   ▼ 换模计划 mould change_plan（换模从下一个早班开始）
   │
   ▼ 发布 publish（三闸门式校验；冲突策略 block/append；已开始执行的计划锁定不可覆盖）
   │
   ▼ 生产计划 production_plan（scheduled → running → completed）
   │
   ▼ 密炼执行：批次 batch ─ 投料消耗 consumption ─ 胶料快检 quality_measurement
   │
   ▼ 半制品 production/inventory（上游产出 ↔ 下游需求的缓冲）
   │
   ▼ 成型 plan/production ＋ 在制品 wip
   │
   ▼ 硫化 plan/production（模具、周期、合格产出）
   │
   ▼ 成品检验 inspection ＋ 质量异常 exception（处置闭环：rework/concession/scrap）
   │
   ▼ 仓储 inventory/movement → 发运 shipment
   │
   ◄── 横向：人员 teams/output、设备 status/events/maintenance、
   │        工艺 recipes/standards/boms、模具 status/changes
   ◄── 计划底座：工厂日历与班次模板 calendars、排产规则词表 rules
   ◄── 报表：reports（计划执行、质量汇总）
   ◄── 追溯：trace/genealogy（批次全生命周期，跨表一线串珠）
```

关键业务规则（标准 MES/APS 语义）：

- **锁定规则**：计划一旦开始执行（已完成量 > 0 或状态为 running/completed）不可取消、不可被发布覆盖。
- **revision 版本**：排产调整不原地改，复制为新 revision，原版本保留。
- **瓶颈优先**：排程先排瓶颈工序再反推上游；产能视图暴露瓶颈标记。
- **换模节奏**：换模计划总是排在下一个早班开始。
- **质量闭环**：异常必须有处置（返工/让步/报废）才算闭环；处置后状态 open → disposed。

## 3. 现状盘点与缺口

### 3.1 已有（13 工具 / 7 表）

| 段 | 工具 | 承载 |
|---|---|---|
| `_01raw/inventory` | query_mes_material_inventory | material_stock |
| `_02mixing/_02plan` | query_mes_mixing_plans | production_plan |
| `_02mixing/_06equipment` | query_mes_mixing_equipment_events | equipment_event |
| `_02mixing/_07quality` | query_mes_mixing_quality | quality_measurement |
| `_03semifinished/production_inventory` | query_mes_semifinished_production_inventory | process_record(semifinished) |
| `_04forming/plan_execution` | query_mes_forming_plan_execution | process_record(forming) |
| `_05curing/plan_execution` | query_mes_curing_plan_execution | process_record(curing) |
| `_06quality/finished_records` | query_mes_finished_quality_records | process_record(quality) |
| `_07warehouse/inventory_movements` | query_mes_finished_goods_inventory_movements | process_record(warehouse) |
| `_11equipment/status` | query_mes_equipment_status | equipment_state |
| `_12technology/recipes` | query_mes_process_recipes | reference_object(recipe) |
| `_13mould/status` | query_mes_mould_status | reference_object(mould) |
| `aps/demand_schedule` | query_mes_aps_demand_schedule | process_record(aps) |

骨架模式：统一信封 dataset/simulated/domain/view/filters/rows/rowCount/truncated/guidance；工具只选择固定数据视图并归一化参数，表、SQL、行预算集中在仓储层；`CapabilityDirectoryCatalog` 目录先行；`DomainCatalog.SEGMENT_LABELS` 段展示名。实现现为内建共享进程插件 `extensions/industry/mes/`（docs/31 §11 M3c）：`Mes.java` 常驻宿主 + 内嵌仓储层，DDL/种子随插件 `seed.sql` 自播到 `{workspace}/industry/mes-demo.db`，内核不再内置这些类与表。

### 3.2 缺口（对照全景）

- **链头缺失**：需求订单、AP 主计划、产能负荷都是薄记录（aps 段 2 行种子），无发布动作。
- **链路断点**：批次谱系无表（质检的 batch_no 无处可查）；原料流转/投料消耗缺失（库存与密炼之间断开）；换模计划缺失（排程与硫化之间断开）。
- **横切不全**：设备事件只有密炼视角；无点检维护；工艺只有配方无标准/BOM。
- **闭环缺失**：质量异常无处置动作；全部为只读，没有演示四阶段写契约 + 审批的业务场景。
- **报表缺失**：成熟 MES 普遍提供查询/报表双轨（计划达成、合格率、产量日报），Iris 一个报表工具都没有。
- **人员缺失**：ISA-95 人员管理（班组、班次、人员产出）整根柱子空白。
- **计划底座缺失**：工厂日历、班次模板、排产规则词表无处可查——"排产怎样排产量最高还合乎实际"没有可解释的依据面。
- **多域边界待真实需求验证**：`/industry/mens` 保留语义目录，不用一组与 MES 同构的模拟工具证明隔离；出现独立数据源、权限或业务口径时再实现。
- **种子不自洽**：process_record 引用 CU-02/CU-03/FM-02 等设备，equipment_state 里没有；equipment_event 无 process 维度，新种子会串工序。

## 4. 领域模型与表设计

### 4.1 新增 4 张表（形状与 process_record 通用结构确实不同的实体）

```sql
-- 链头：需求订单
industrial_demo_demand_order (
  domain_code, demand_no PK, item_code, item_name,
  quantity REAL, unit, due_date, priority,           -- high/normal
  state,           -- unscheduled/scheduled/released/completed
  source, updated_at, PRIMARY KEY (domain_code, demand_no))

-- 谱系主键：批次
industrial_demo_batch (
  domain_code, batch_no PK, item_code, item_name,
  plan_no, equipment_code, process_code,             -- 产出工序（mixing）
  produced_at, quantity REAL, unit,
  quality_state,   -- pending/pass/fail
  downstream_ref,  -- 下游去向（半制品库存记录号等）
  updated_at, PRIMARY KEY (domain_code, batch_no))

-- 原料收发存（有方向与关联单号，通用 record 承载会丢语义）
industrial_demo_material_movement (
  domain_code, movement_no PK, material_code, material_name,
  movement_type,   -- receipt/issue/return
  quantity REAL, unit, warehouse_code,
  related_no,      -- 关联计划/批次/单号
  occurred_at, PRIMARY KEY (domain_code, movement_no))

-- 质量异常处置闭环（写操作需要显式状态机 + 乐观锁版本）
industrial_demo_quality_exception (
  domain_code, exception_no PK, item_code, item_name,
  source_record_no, defect_category, affected_quantity REAL,
  status,          -- open/disposed/closed
  disposition,     -- none/rework/concession/scrap
  version INTEGER, -- 乐观锁
  opened_at, updated_at, PRIMARY KEY (domain_code, exception_no))
```

### 4.2 既有表扩 record_type（同构“记录型”视图不建新表）

| 表 | 新 record_type / object_type | 视图 |
|---|---|---|
| process_record(raw) | inspection | 来料检验 |
| process_record(mixing) | consumption | 投料消耗 |
| process_record(forming) | wip | 成型在制品 |
| process_record(warehouse) | shipment | 发运 |
| process_record(equipment) | inspection / maintenance | 点检与维护 |
| process_record(mould) | change_plan | 换模计划 |
| process_record(aps) | master_plan / capacity | AP 主计划、产能负荷 |
| process_record(personnel) | shift_output | 班组班次产出 |
| reference_object | process_standard / bom | 工艺标准、BOM |
| reference_object | team / calendar / shift_template / scheduling_rule | 班组、工厂日历、班次模板、排产规则 |

### 4.3 种子自洽性原则

一条能走通的故事线：需求 DMD → master_plan（rev）→ schedule → publish 生成 plan → batch（BATCH-C11-017 等既有质检批号全部入批次表）→ 快检（017 pass / 018 fail）→ 半制品 → 成型 → 硫化 → 成品检 → 异常（开 1 闭 1）→ 入库 → 发运。补齐 equipment_state 缺失的 FM-02/CU-02/CU-03；equipment_event 通过 equipment_state 反查工序（不加列，JOIN 过滤）。时间线沿用 2026-07-28…30。

## 5. 工具拆分设计

命名延续 `iris.industry.mes.<视图>` / `query_mes_<视图>`；描述必须说明它回答的问题、适用时机和关键边界。

### 5.1 mes 域新增只读（21）

> 其中 3 个（需求订单、质量异常台账、延误计划）来自对真实 MES 后端工具实现的
> 质量校准：链头需求可见是排产对话的起点；异常台账必须暴露 version 才能驱动
> dispose 的乐观锁；延误视图是成熟 MES 各工序普遍提供的通用视图（脱敏转述）。

| 路径 | 工具 | 语义 |
|---|---|---|
| `_01raw/movements` | query_mes_material_movements | 原料收/发/退流转，关联计划与批次；不含实时库存（见 inventory） |
| `_01raw/incoming_quality` | query_mes_raw_incoming_quality | 来料检验记录与判定；不含密炼在线快检 |
| `_02mixing/batches` | query_mes_mixing_batches | 批次谱系主档：计划、机台、产出、质量状态、下游去向 |
| `_02mixing/consumption` | query_mes_mixing_consumption | 投料与消耗明细（组分、用量、关联批次） |
| `_04forming/wip` | query_mes_forming_wip | 成型在制品缓冲（半制品用料、龄期、去向计划） |
| `_07warehouse/shipments` | query_mes_shipments | 发运记录（车位、方向、包数）；不含库存台账 |
| `_11equipment/events` | query_mes_equipment_events | 跨工序设备事件（按工序/设备/严重度过滤） |
| `_11equipment/maintenance` | query_mes_equipment_maintenance | 点检与维护记录、结果与下次到期 |
| `_12technology/standards` | query_mes_process_standards | 工艺标准版本与参数摘要 |
| `_12technology/boms` | query_mes_boms | 产品/半制品 BOM 组成 |
| `_13mould/changes` | query_mes_mould_changes | 换模计划（从/到模具、计划开始、原因） |
| `_14personnel/teams` | query_mes_shift_teams | 班组主数据（人数、技能标签、适用工序） |
| `_14personnel/output` | query_mes_personnel_output | 班组班次产出（出勤、产量、所在工序） |
| `_10plan/calendars` | query_mes_plan_calendars | 工厂日历与班次模板（工作日、班次起止、资源可用） |
| `aps/rules` | query_mes_aps_rules | 排产规则词表（硬/软约束、适用范围、业务解释）——"为什么这样排"的依据面 |
| `aps/master_plan` | query_mes_aps_master_plan | AP 主计划结果（revision、资源、起止、关联需求） |
| `aps/capacity_load` | query_mes_aps_capacity_load | 线组产能与负荷、瓶颈标记 |
| `_08trace/genealogy` | query_mes_batch_trace | 批次全生命周期追溯：按批号/物料跨表串出 计划→批次→快检→半制品→成型→硫化→仓储 各段行 |
| `_10plan/demand` | query_mes_demand_orders | 链头需求订单（数量、交期、优先级、排产状态）；排产对话的起点 |
| `_10plan/delays` | query_mes_plan_delays | 截至基准日仍未完成的延误计划（延误天数、剩余量）；交期风险排查 |
| `_06quality/exceptions` | query_mes_quality_exceptions | 异常台账（缺陷、影响数量、处置状态、version）；dispose 的乐观锁来源 |

### 5.2 mes 域新增报表（2，`_09reports`）

报表 = 确定性聚合视图，rows 为分组行、summary 给合计，沿用信封。

| 路径 | 工具 | 语义 |
|---|---|---|
| `_09reports/plan_execution` | report_mes_plan_execution | 按工序×日期聚合计划量/完成量/达成率 |
| `_09reports/quality_summary` | report_mes_quality_summary | 按物料聚合测量数/合格率/未闭环异常数 |

### 5.3 mes 域新增写工具（3，EXTERNAL_WRITE + 审批）

写工具走完整四阶段契约：prepare 只校验与组装，execute 重读校验、检查取消并在提交边界前 fail-close，verify 独立重读。它们声明 `RiskLevel.ELEVATED`、`SideEffect.EXTERNAL_WRITE` 和 `EvidencePolicy.REQUIRED`；发布操作使用幂等键并把排程状态、计划行和需求状态放在同一事务中，其余写操作由状态机与乐观锁防止重复生效。

| 路径 | 工具 | 语义与守护 |
|---|---|---|
| `aps/publish` | publish_mes_aps_schedule | 把 accepted 排程发布为生产计划；conflict_policy=block（默认，拒绝时列出冲突明细）/append；锁定规则：目标机台同日已有 running/completed 或 completed_batches>0 的计划时 block 必拒；重复发布同一排程被幂等拦截并返回原计划号；发布后回写需求 state→scheduled |
| `_10plan/maintain` | update_mes_plan | 调整计划状态/优先级；合法迁移 scheduled→running（下达）、scheduled/released→cancelled；已完成量>0 禁止取消 |
| `_06quality/dispositions` | dispose_mes_quality_exception | 质量异常处置（rework/concession/scrap）；仅 open→disposed；version 乐观锁 |

### 5.4 MENS 域边界

`/industry/mens` 只保留可发现的业务目录地图，不注册与 MES 同构的模拟工具，也不维护第二套模拟种子。目录先回答“未来能力放在哪里”，真实需求出现后再用独立数据源、权限和业务口径证明拆域价值。

### 5.5 既有工具修正

- `query_mes_mixing_equipment_events`：补固定 process=mixing 过滤（经 equipment_state 反查），否则跨工序事件种子灌入后串域。
- 仓储层 `productionPlans`：view 名参数化（现位于插件 `Mes.java` 内嵌仓储层），mens 复用。

## 6. 目录与标签同步

- `CapabilityDirectoryCatalog`：登记 MES 闭环涉及的业务段；MENS 保留目录骨架并明确当前无具体工具。
- `DomainCatalog.SEGMENT_LABELS`：补齐新段展示名（raw/movements/incoming_quality/batches/consumption/semifinished/production_inventory/forming/plan_execution/curing/finished_records/warehouse/inventory_movements/trace/genealogy/reports/plan_execution/…/mens/foundation/planning/feeding/shop_consumption/material_quality/checks/stops/compound_quality/measurements/standards/yield/storage/dispositions/wip/shipments/events/maintenance/technology/boms/mould/changes/master_plan/capacity_load/publish/maintain 等）。

## 7. 实施顺序与验证

1. schema.sql：4 张形状独立的新表 + MES 脱敏种子扩充（INSERT OR IGNORE）。
2. Repository：新查询方法（movements/batches/trace 组合查询/reports 聚合）+ 写方法（publish/update/dispose，参数化 SQL）。
3. MES 读工具与报表；修正 mixing events 过滤。
4. 写工具 3 个（含 AbstractMesWriteTool 骨架与发布事务边界）。
5. 目录/标签与 docs/03 同步。
6. 编译级验证；完整对话与审批体验由后续统一测试覆盖。

不做的：不接真实数据库、不做 ERP 对接、不做 OEE 精确口径（演示聚合即可）、不迁移任何公司专有名词与数据。
