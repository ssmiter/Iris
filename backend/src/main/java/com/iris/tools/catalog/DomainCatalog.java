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
            Map.entry("web", "网页")
    );

    public static String segmentLabel(String segment) {
        return SEGMENT_LABELS.getOrDefault(segment, segment);
    }

    /** 域过滤：某身份是否可见某路径。未知身份 fail-close（只见通用工具）。 */
    public static boolean visible(String systemCode, String path) {
        if (COMMON_PATHS.stream().anyMatch(path::startsWith)) return true;
        if (!"personal".equals(systemCode)) return false;
        return RESTRICTED.getOrDefault(systemCode, Set.of()).stream()
                .noneMatch(path::startsWith);
    }
}
