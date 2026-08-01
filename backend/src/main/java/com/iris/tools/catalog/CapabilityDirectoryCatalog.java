package com.iris.tools.catalog;

import org.springframework.stereotype.Component;

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
    private final List<DirectoryDefinition> definitions = List.of(
            directory(
                    "/industry",
                    "工业",
                    "制造、质量、设备与供应链等工业能力的总目录"
            ),
            directory(
                    "/industry/mes",
                    "制造执行系统",
                    "贯穿原料、生产、质量、仓储和设备的制造执行能力；当前含少量脱敏样例"
            ),
            directory(
                    "/industry/mes/_01raw",
                    "原材料",
                    "原料基础信息、收发存、检验与库存风险"
            ),
            directory(
                    "/industry/mes/_01raw/inventory",
                    "原料库存",
                    "按物料和仓库观察可用、预留与安全库存"
            ),
            directory(
                    "/industry/mes/_02mixing",
                    "密炼",
                    "密炼计划、执行、物料、设备事件与胶料质量"
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
                    "/industry/mes/_03semifinished",
                    "半制品",
                    "半制品基础数据、计划、生产、库存与报表目录骨架"
            ),
            directory(
                    "/industry/mes/_03semifinished/production_inventory",
                    "半制品生产与库存",
                    "连接上游产出与下游成型需求的产出和缓冲库存"
            ),
            directory(
                    "/industry/mes/_04forming",
                    "成型",
                    "成型计划、生产实绩、物料、在制品与设备协同目录骨架"
            ),
            directory(
                    "/industry/mes/_04forming/plan_execution",
                    "成型计划与实绩",
                    "成型机台的计划数量、实际完成与合格损耗"
            ),
            directory(
                    "/industry/mes/_05curing",
                    "硫化",
                    "硫化计划、生产实绩、工装和在制品目录骨架"
            ),
            directory(
                    "/industry/mes/_05curing/plan_execution",
                    "硫化计划与实绩",
                    "硫化设备负荷、模具安排、周期与合格产出"
            ),
            directory(
                    "/industry/mes/_06quality",
                    "质量",
                    "外观、检测、判级、异常与质量分析目录骨架"
            ),
            directory(
                    "/industry/mes/_06quality/finished_records",
                    "成品质量记录",
                    "成品检验批次、通过数量、缺陷影响与待处置异常"
            ),
            directory(
                    "/industry/mes/_07warehouse",
                    "仓储",
                    "入库、退库、出库、库存、装运与统计目录骨架"
            ),
            directory(
                    "/industry/mes/_07warehouse/inventory_movements",
                    "成品库存与流转",
                    "成品可用、分配、冻结以及出入库和装运记录"
            ),
            directory(
                    "/industry/mes/_11equipment",
                    "设备",
                    "设备主数据、运行状态、故障、点检和维护"
            ),
            directory(
                    "/industry/mes/_11equipment/status",
                    "设备运行状态",
                    "跨工序设备状态、利用率、当前计划和最新告警"
            ),
            directory(
                    "/industry/mes/_12technology",
                    "工艺与配方",
                    "工艺标准、配方版本和参数治理目录骨架"
            ),
            directory(
                    "/industry/mes/_12technology/recipes",
                    "工艺配方",
                    "配方版本、审批状态、适用工序和摘要信息"
            ),
            directory(
                    "/industry/mes/_13mould",
                    "模具",
                    "模具主数据、使用状态、寿命和维护目录骨架"
            ),
            directory(
                    "/industry/mes/_13mould/status",
                    "模具状态",
                    "模具位置、使用状态、累计次数和维护阈值"
            ),
            directory(
                    "/industry/mes/aps",
                    "高级排产",
                    "跨工序约束、需求分解与计划协同目录骨架"
            ),
            directory(
                    "/industry/mes/aps/demand_schedule",
                    "需求与排程",
                    "待满足需求、可行排程、瓶颈与预计完成时间"
            ),
            directory(
                    "/industry/mens",
                    "密炼执行系统",
                    "围绕密炼现场的基础数据、计划、原料、设备、质量与报表目录骨架；暂未注册工具"
            ),
            directory(
                    "/industry/mens/_01foundation",
                    "基础数据",
                    "组织、人员、物料、设备、库位与班次等基础对象"
            ),
            directory(
                    "/industry/mens/_02planning",
                    "计划与执行",
                    "排产、班次、计划下达、执行监控与完成分析"
            ),
            directory(
                    "/industry/mens/_03materials",
                    "原料管理",
                    "领用、投料、消耗、退料、库位与库存"
            ),
            directory(
                    "/industry/mens/_04material_quality",
                    "原料质量",
                    "取样、检验项目、标准、判定与来料质量分析"
            ),
            directory(
                    "/industry/mens/_06equipment",
                    "设备管理",
                    "停机、故障、原因、维护与备件"
            ),
            directory(
                    "/industry/mens/_07compound_quality",
                    "胶料质量",
                    "检验标准、测量、审核、判定与合格率"
            ),
            directory(
                    "/industry/mens/_08reports",
                    "生产与库存报表",
                    "产量、收发存、消耗与综合分析"
            )
    ).stream().sorted(
            Comparator.comparing(DirectoryDefinition::path)
    ).toList();

    public List<DirectoryDefinition> all() {
        return definitions;
    }

    public Optional<DirectoryDefinition> find(String path) {
        return definitions.stream()
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
