package com.weave.tools.catalog;

import com.weave.tools.core.Tool;
import com.weave.tools.core.ToolRegistry;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 能力树服务（docs/03 §5）：目录树 + 每个目录的工具数统计。
 * 统计是模型的方向感——"/travel 有 128 个工具"比"有个 /travel 目录"更能引导探索。
 */
@Service
public class CapabilityService {

    private final ToolRegistry registry;

    public CapabilityService(ToolRegistry registry) {
        this.registry = registry;
    }

    public record CapabilityNode(
            String path,
            String name,
            int toolCount,
            List<CapabilityNode> children
    ) {}

    /** 按身份过滤后的能力树（统计递归汇总）。 */
    public CapabilityNode tree(String systemCode) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (Tool tool : registry.all()) {
            String path = DomainCatalog.inferPath(tool.getClass());
            if (!DomainCatalog.visible(systemCode, path)) continue;
            // 沿路径向上累计每一级目录
            String[] segs = path.substring(1).split("/");
            StringBuilder cur = new StringBuilder();
            for (String seg : segs) {
                cur.append('/').append(seg);
                counts.merge(cur.toString(), 1, Integer::sum);
            }
        }
        return buildNode("", counts);
    }

    private CapabilityNode buildNode(String path, Map<String, Integer> counts) {
        List<CapabilityNode> children = new ArrayList<>();
        String prefix = path.isEmpty() ? "/" : path + "/";
        counts.keySet().stream()
                .filter(p -> p.startsWith(prefix) && p.substring(prefix.length()).indexOf('/') < 0)
                .sorted()
                .forEach(p -> children.add(buildNode(p, counts)));
        String name = path.isEmpty() ? "根"
                : DomainCatalog.segmentLabel(path.substring(path.lastIndexOf('/') + 1));
        return new CapabilityNode(path.isEmpty() ? "/" : path, name,
                counts.getOrDefault(path, 0), children);
    }
}
