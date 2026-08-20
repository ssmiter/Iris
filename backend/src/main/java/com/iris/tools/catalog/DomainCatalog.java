package com.iris.tools.catalog;

import com.iris.tools.core.Tool;

import java.util.Map;
import java.util.Set;

/**
 * 域目录（docs/03 §4）——"如何组织工具"的唯一权威。
 *
 * 铁律：文件目录 = 能力树路径。tools.finance.express.XxxTool → /finance/express。
 * 不允许在任何其他位置维护第二套路径映射。
 *
 * 同时集中：通用工具集、受限域排除集、域过滤规则——
 * 注册表与能力服务必须都从这里取规则（历史上最大的 bug 源就是两处规则不一致）。
 */
public final class DomainCatalog {

    private DomainCatalog() {}

    /** 任何身份都可见的通用工具（文件/搜索/计算等基础原语） */
    private static final Set<String> COMMON_PATHS = Set.of("/local", "/code", "/system");

    /** 受限域排除表：某身份不可见的能力目录（示例：guest 不可见支付与写工具） */
    private static final Map<String, Set<String>> RESTRICTED = Map.of(
            "guest", Set.of("/finance/pay", "/local/write")
    );

    /** 包名 → 能力树路径。com.iris.tools.finance.express → /finance/express */
    public static String inferPath(Class<? extends Tool> toolClass) {
        String pkg = toolClass.getPackageName();
        String prefix = "com.iris.tools.";
        if (!pkg.startsWith(prefix)) {
            throw new IllegalStateException("工具必须放在 com.iris.tools.<域>.<目录> 包下: " + pkg);
        }
        String rest = pkg.substring(prefix.length()).replace('.', '/');
        return "/" + rest;
    }

    /** 路径段展示名（通用语义词典，与具体业务无关；未收录的段原样展示） */
    private static final Map<String, String> SEGMENT_LABELS = Map.ofEntries(
            Map.entry("finance", "财务"), Map.entry("travel", "出行"),
            Map.entry("job", "求职"), Map.entry("life", "生活"),
            Map.entry("health", "健康"), Map.entry("home", "家庭"),
            Map.entry("express", "快递"), Map.entry("train", "火车"),
            Map.entry("hotel", "酒店"), Map.entry("notes", "笔记"),
            Map.entry("resume", "简历"), Map.entry("local", "本地"),
            Map.entry("code", "代码"), Map.entry("system", "系统"),
            Map.entry("python", "Python 分析"),
            Map.entry("data", "数据"), Map.entry("sql", "SQL"),
            Map.entry("web", "网页"), Map.entry("browser", "浏览器"),
            Map.entry("files", "工作区文件"),
            Map.entry("capabilities", "能力"),
            Map.entry("agents", "Agent 协作"),
            Map.entry("pipelines", "固定流程"),
            Map.entry("interaction", "用户交互"),
            Map.entry("schedule", "定时任务"),
            Map.entry("artifacts", "工件"),
            Map.entry("tasks", "任务台账"),
            Map.entry("memory", "记忆"),
            Map.entry("personal", "个人"),
            Map.entry("context", "上下文"), Map.entry("math", "计算"),
            Map.entry("industry", "工业"), Map.entry("mes", "制造执行"),
            Map.entry("materials", "原材料"),
            Map.entry("inventory", "库存"),
            Map.entry("mixing", "密炼"), Map.entry("plan", "计划与执行"),
            Map.entry("equipment", "设备"), Map.entry("status", "状态"),
            Map.entry("quality", "质量"),
            // docs/27 全景段（工业域通用语义词典，与具体工厂无关）
            Map.entry("raw", "原料"), Map.entry("movements", "流转"),
            Map.entry("incoming_quality", "来料检验"),
            Map.entry("batches", "批次"), Map.entry("consumption", "消耗"),
            Map.entry("semifinished", "半制品"),
            Map.entry("production_inventory", "生产与库存"),
            Map.entry("forming", "成型"),
            Map.entry("plan_execution", "计划与实绩"),
            Map.entry("wip", "在制品"), Map.entry("curing", "硫化"),
            Map.entry("finished_records", "成品记录"),
            Map.entry("exceptions", "异常"),
            Map.entry("dispositions", "处置"),
            Map.entry("warehouse", "仓储"),
            Map.entry("inventory_movements", "库存与流转"),
            Map.entry("shipments", "发运"), Map.entry("trace", "追溯"),
            Map.entry("genealogy", "谱系"), Map.entry("reports", "报表"),
            Map.entry("quality_summary", "质量汇总"),
            Map.entry("demand", "需求"), Map.entry("delays", "延误"),
            Map.entry("calendars", "日历与班次"),
            Map.entry("maintain", "维护"), Map.entry("events", "事件"),
            Map.entry("maintenance", "点检维护"),
            Map.entry("technology", "工艺"), Map.entry("recipes", "配方"),
            Map.entry("standards", "标准"), Map.entry("boms", "BOM"),
            Map.entry("mould", "模具"), Map.entry("changes", "换模"),
            Map.entry("personnel", "人员"), Map.entry("teams", "班组"),
            Map.entry("output", "产出"), Map.entry("aps", "高级排产"),
            Map.entry("demand_schedule", "需求与排程"),
            Map.entry("master_plan", "主计划"),
            Map.entry("capacity_load", "产能负荷"),
            Map.entry("rules", "规则"), Map.entry("publish", "发布"),
            Map.entry("mens", "密炼执行"),
            Map.entry("foundation", "基础数据"),
            Map.entry("storage", "库房"), Map.entry("planning", "计划"),
            Map.entry("feeding", "投料称量"),
            Map.entry("shop_consumption", "车间消耗"),
            Map.entry("material_quality", "原料质量"),
            Map.entry("checks", "检验"), Map.entry("stops", "停机"),
            Map.entry("compound_quality", "胶料质量"),
            Map.entry("measurements", "测量"), Map.entry("yield", "产量")
    );

    public static String segmentLabel(String segment) {
        String semantic = stripOrdinalPrefix(segment);
        return SEGMENT_LABELS.getOrDefault(semantic, semantic);
    }

    private static String stripOrdinalPrefix(String segment) {
        String value = segment.startsWith("_")
                ? segment.substring(1)
                : segment;
        int index = 0;
        while (index < value.length()
                && Character.isDigit(value.charAt(index))) {
            index++;
        }
        if (index > 0 && index < value.length()) {
            return value.substring(index);
        }
        return segment;
    }

    /** 域过滤：某身份是否可见某路径。未知身份 fail-close（只见通用工具）。 */
    public static boolean visible(String systemCode, String path) {
        if (COMMON_PATHS.stream().anyMatch(path::startsWith)) return true;
        if (!"personal".equals(systemCode)) return false;
        return RESTRICTED.getOrDefault(systemCode, Set.of()).stream()
                .noneMatch(path::startsWith);
    }
}
