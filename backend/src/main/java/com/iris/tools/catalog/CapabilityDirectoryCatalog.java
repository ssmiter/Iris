package com.iris.tools.catalog;

import com.iris.extension.ExtensionDirectoryRegistry;
import com.iris.extension.ExtensionScanner;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/**
 * 可以先于具体工具存在的语义目录地图。
 *
 * <p>它只描述“有哪些业务区域值得导航”，不声明工具、不改变 Provider tool surface，
 * 也不拥有执行绑定。Tool 的路径仍只能从其 Java package 派生。</p>
 */
@Component
public class CapabilityDirectoryCatalog {
    private final ExtensionDirectoryRegistry extensionDirectories;
    private final List<DirectoryDefinition> definitions = List.of(
            directory(
                    "/system",
                    "系统闭环",
                    "Iris 自身的能力发现、运行协作与固定流程入口"
            ),
            directory(
                    "/system/agents",
                    "Agent 协作",
                    "使用同一 Agentic 内核执行有界委派、异步通信与取消"
            ),
            directory(
                    "/system/pipelines",
                    "固定流程",
                    "由按钮、系统事件或主对话触发的版本化信息转换流程"
            ),
            directory(
                    "/industry",
                    "工业",
                    "制造、质量、设备与供应链等工业能力的总目录"
            ),
            directory(
                    "/industry/mes",
                    "制造执行系统",
                    "贯通 需求→排产→发布→执行→质检→仓储→发运 全链路的制造执行能力，"
                            + "横向覆盖人员、设备、工艺、模具与报表追溯"
            ),
            directory(
                    "/industry/mes/_01raw",
                    "原材料",
                    "原料库存、收发存流转与来料检验"
            ),
            directory(
                    "/industry/mes/_01raw/inventory",
                    "原料库存",
                    "按物料和仓库观察可用、预留与安全库存"
            ),
            directory(
                    "/industry/mes/_01raw/movements",
                    "原料流转",
                    "原料入库、领出与退回记录，关联计划与批次"
            ),
            directory(
                    "/industry/mes/_01raw/incoming_quality",
                    "来料检验",
                    "来料检验记录、指标明细与判定结论"
            ),
            directory(
                    "/industry/mes/_02mixing",
                    "密炼",
                    "密炼计划、批次谱系、投料消耗、设备事件与胶料质量"
            ),
            directory(
                    "/industry/mes/_02mixing/_02plan",
                    "密炼计划与执行",
                    "密炼机台计划、优先级、班次与完成进度"
            ),
            directory(
                    "/industry/mes/_02mixing/_06equipment",
                    "密炼设备事件",
                    "密炼设备停机、降速、告警原因和闭环状态"
            ),
            directory(
                    "/industry/mes/_02mixing/_07quality",
                    "密炼质量",
                    "胶料批次测量、标准上下限与判定"
            ),
            directory(
                    "/industry/mes/_02mixing/batches",
                    "密炼批次",
                    "批次谱系主档：来源计划、机台、产出、质量状态与下游去向"
            ),
            directory(
                    "/industry/mes/_02mixing/consumption",
                    "投料消耗",
                    "投料与消耗明细：组分、用量、关联批次"
            ),
            directory(
                    "/industry/mes/_03semifinished",
                    "半制品",
                    "连接上游产出与下游成型需求的半制品生产与缓冲库存"
            ),
            directory(
                    "/industry/mes/_03semifinished/production_inventory",
                    "半制品生产与库存",
                    "连接上游产出与下游成型需求的产出和缓冲库存"
            ),
            directory(
                    "/industry/mes/_04forming",
                    "成型",
                    "成型计划、生产实绩与在制品缓冲"
            ),
            directory(
                    "/industry/mes/_04forming/plan_execution",
                    "成型计划与实绩",
                    "成型机台的计划数量、实际完成与合格损耗"
            ),
            directory(
                    "/industry/mes/_04forming/wip",
                    "成型在制品",
                    "在制品缓冲：半制品用料、龄期与分配的下游计划"
            ),
            directory(
                    "/industry/mes/_05curing",
                    "硫化",
                    "硫化计划、生产实绩、模具与周期"
            ),
            directory(
                    "/industry/mes/_05curing/plan_execution",
                    "硫化计划与实绩",
                    "硫化设备负荷、模具安排、周期与合格产出"
            ),
            directory(
                    "/industry/mes/_06quality",
                    "质量",
                    "成品检验、质量异常台账与处置闭环"
            ),
            directory(
                    "/industry/mes/_06quality/finished_records",
                    "成品质量记录",
                    "成品检验批次、通过数量、缺陷影响与待处置异常"
            ),
            directory(
                    "/industry/mes/_06quality/exceptions",
                    "质量异常",
                    "异常台账：缺陷类别、影响数量、处置状态与乐观锁版本"
            ),
            directory(
                    "/industry/mes/_06quality/dispositions",
                    "异常处置",
                    "质量异常处置闭环：返工、让步接收或报废"
            ),
            directory(
                    "/industry/mes/_07warehouse",
                    "仓储",
                    "成品库存、出入库流转与发运"
            ),
            directory(
                    "/industry/mes/_07warehouse/inventory_movements",
                    "成品库存与流转",
                    "成品可用、分配、冻结以及出入库和装运记录"
            ),
            directory(
                    "/industry/mes/_07warehouse/shipments",
                    "发运",
                    "成品发运记录：方向、车位、包数与关联需求"
            ),
            directory(
                    "/industry/mes/_08trace",
                    "追溯",
                    "跨表批次谱系追溯"
            ),
            directory(
                    "/industry/mes/_08trace/genealogy",
                    "批次谱系",
                    "批次全生命周期：计划→批次→投料→快检→半制品→成型→硫化→仓储"
            ),
            directory(
                    "/industry/mes/_09reports",
                    "报表",
                    "确定性聚合报表：计划达成与质量汇总"
            ),
            directory(
                    "/industry/mes/_09reports/plan_execution",
                    "计划执行报表",
                    "按工序与日期聚合计划量、完成量与达成率"
            ),
            directory(
                    "/industry/mes/_09reports/quality_summary",
                    "质量汇总报表",
                    "按物料聚合测量数、合格率与未闭环异常数"
            ),
            directory(
                    "/industry/mes/_10plan",
                    "计划",
                    "链头需求、计划维护、延误风险与排产底座日历"
            ),
            directory(
                    "/industry/mes/_10plan/demand",
                    "需求订单",
                    "链头需求：数量、交期、优先级与排产状态"
            ),
            directory(
                    "/industry/mes/_10plan/delays",
                    "延误计划",
                    "截至基准日仍未完成的计划：延误天数与剩余量"
            ),
            directory(
                    "/industry/mes/_10plan/calendars",
                    "日历与班次",
                    "工厂日历与班次模板：工作日、节假日、班次起止"
            ),
            directory(
                    "/industry/mes/_10plan/maintain",
                    "计划维护",
                    "计划下达、取消与优先级调整（锁定规则保护）"
            ),
            directory(
                    "/industry/mes/_11equipment",
                    "设备",
                    "设备主数据、运行状态、事件、点检和维护"
            ),
            directory(
                    "/industry/mes/_11equipment/status",
                    "设备运行状态",
                    "跨工序设备状态、利用率、当前计划和最新告警"
            ),
            directory(
                    "/industry/mes/_11equipment/events",
                    "设备事件",
                    "跨工序设备停机、降速与告警事件"
            ),
            directory(
                    "/industry/mes/_11equipment/maintenance",
                    "点检与维护",
                    "设备点检与维护记录、结果与下次到期"
            ),
            directory(
                    "/industry/mes/_12technology",
                    "工艺与配方",
                    "工艺配方、工艺标准与 BOM"
            ),
            directory(
                    "/industry/mes/_12technology/recipes",
                    "工艺配方",
                    "配方版本、审批状态、适用工序和摘要信息"
            ),
            directory(
                    "/industry/mes/_12technology/standards",
                    "工艺标准",
                    "工艺标准版本与关键参数摘要"
            ),
            directory(
                    "/industry/mes/_12technology/boms",
                    "BOM",
                    "产品与半制品 BOM 组成"
            ),
            directory(
                    "/industry/mes/_13mould",
                    "模具",
                    "模具主数据、使用状态、寿命与换模计划"
            ),
            directory(
                    "/industry/mes/_13mould/status",
                    "模具状态",
                    "模具位置、使用状态、累计次数和维护阈值"
            ),
            directory(
                    "/industry/mes/_13mould/changes",
                    "换模计划",
                    "换模安排：机台、从/到模具、计划开始与原因"
            ),
            directory(
                    "/industry/mes/_14personnel",
                    "人员",
                    "班组主数据与班次产出"
            ),
            directory(
                    "/industry/mes/_14personnel/teams",
                    "班组",
                    "班组人数、技能标签与适用工序"
            ),
            directory(
                    "/industry/mes/_14personnel/output",
                    "班次产出",
                    "班组班次出勤、产量与所在工序"
            ),
            directory(
                    "/industry/mes/aps",
                    "高级排产",
                    "需求与排程、AP 主计划、产能负荷、排产规则与排程发布"
            ),
            directory(
                    "/industry/mes/aps/demand_schedule",
                    "需求与排程",
                    "待满足需求、可行排程、瓶颈与预计完成时间"
            ),
            directory(
                    "/industry/mes/aps/master_plan",
                    "AP 主计划",
                    "天粒度主计划结果：revision、资源、起止与关联需求"
            ),
            directory(
                    "/industry/mes/aps/capacity_load",
                    "产能负荷",
                    "产线组产能与负荷、瓶颈标记"
            ),
            directory(
                    "/industry/mes/aps/rules",
                    "排产规则",
                    "排产规则词表：硬/软约束、适用范围与业务解释"
            ),
            directory(
                    "/industry/mes/aps/publish",
                    "排程发布",
                    "把已评估排程发布为生产计划：冲突检查、锁定规则与幂等拦截"
            ),
            directory(
                    "/industry/mens",
                    "密炼执行系统",
                    "预留的密炼执行业务地图；当前不注册具体工具，避免与 MES 样例重复铺量"
            ),
            directory(
                    "/industry/mens/_01foundation",
                    "基础数据",
                    "胶料主数据、库房与库位"
            ),
            directory(
                    "/industry/mens/_01foundation/materials",
                    "胶料主数据",
                    "胶料类别、组分数量、版本与状态"
            ),
            directory(
                    "/industry/mens/_01foundation/storage",
                    "库房库位",
                    "库房类型与库位数量"
            ),
            directory(
                    "/industry/mens/_02planning",
                    "计划与执行",
                    "密炼计划、班次与执行进度"
            ),
            directory(
                    "/industry/mens/_02planning/plan_execution",
                    "密炼计划执行",
                    "密炼计划、班次、优先级与完成进度"
            ),
            directory(
                    "/industry/mens/_03materials",
                    "原料管理",
                    "投料称量、车间消耗与现场库存"
            ),
            directory(
                    "/industry/mens/_03materials/feeding",
                    "投料称量",
                    "大料投料与小料称量：目标、实称与偏差"
            ),
            directory(
                    "/industry/mens/_03materials/shop_consumption",
                    "车间消耗与现场库存",
                    "班次消耗、关联计划、库位与龄期"
            ),
            directory(
                    "/industry/mens/_04material_quality",
                    "原料质量",
                    "原料检验记录、指标明细与审批状态"
            ),
            directory(
                    "/industry/mens/_04material_quality/checks",
                    "原料检验",
                    "取样检验、判定与放行审批"
            ),
            directory(
                    "/industry/mens/_06equipment",
                    "设备管理",
                    "密炼设备停机与异常事件"
            ),
            directory(
                    "/industry/mens/_06equipment/stops",
                    "设备停机",
                    "停机记录、原因分类、严重度与闭环状态"
            ),
            directory(
                    "/industry/mens/_07compound_quality",
                    "胶料质量",
                    "胶料快检测量与检验标准"
            ),
            directory(
                    "/industry/mens/_07compound_quality/measurements",
                    "胶料快检",
                    "快检测量、上下限、判定与合格率"
            ),
            directory(
                    "/industry/mens/_07compound_quality/standards",
                    "检验标准",
                    "检验项目、上下限与审核状态"
            ),
            directory(
                    "/industry/mens/_08reports",
                    "生产与库存报表",
                    "产量与完成率聚合"
            ),
            directory(
                    "/industry/mens/_08reports/yield",
                    "产量日报",
                    "按日期聚合计划车次、完成车次与完成率"
            )
    ).stream().sorted(
            Comparator.comparing(DirectoryDefinition::path)
    ).toList();

    public CapabilityDirectoryCatalog(
            ExtensionDirectoryRegistry extensionDirectories
    ) {
        this.extensionDirectories = extensionDirectories;
    }

    /**
     * 代码内定义 + 拓展根 `_directory.yml` 的合并视图（docs/31 §2.2）：
     * 代码优先——拓展只能新增代码没有的目录、补充元数据，hidden 即消失。
     */
    public List<DirectoryDefinition> all() {
        List<DirectoryDefinition> merged = new ArrayList<>(definitions);
        List<String> knownPaths = definitions.stream()
                .map(DirectoryDefinition::path)
                .toList();
        for (ExtensionScanner.ScannedDirectory directory
                : extensionDirectories.all()) {
            if (directory.metadata().hidden()
                    || knownPaths.contains(directory.directoryPath())) {
                continue;
            }
            String label = directory.metadata().label();
            merged.add(new DirectoryDefinition(
                    directory.directoryPath(),
                    label == null || label.isBlank()
                            ? directory.directoryPath()
                            : label,
                    directory.metadata().summary() == null
                            ? ""
                            : directory.metadata().summary()
            ));
        }
        return merged;
    }

    public Optional<DirectoryDefinition> find(String path) {
        return all().stream()
                .filter(definition -> definition.path().equals(path))
                .findFirst();
    }

    private static DirectoryDefinition directory(
            String path,
            String title,
            String description
    ) {
        return new DirectoryDefinition(path, title, description);
    }

    public record DirectoryDefinition(
            String path,
            String title,
            String description
    ) {
    }
}
