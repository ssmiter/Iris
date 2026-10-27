package com.iris.objective.capabilities;

import com.iris.tools.catalog.CapabilityService;
import com.iris.tools.catalog.CapabilityService.CapabilityCard;
import com.iris.tools.catalog.CapabilityService.CapabilityListing;
import com.iris.tools.catalog.CapabilityService.CapabilityNode;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 能力目录发现读 API（WonWork 契约形状 /api/capabilities*，docs/46）。
 *
 * <p>只读：tree/all/schema。Iris 无 SystemCode 分区（单用户本地），
 * systemCode 参数一律忽略。不做任何执行/裁决。</p>
 */
@RestController
@RequestMapping("/api/capabilities")
public class CapabilitiesApiController {

    private static final String LOCAL = "local";

    private final CapabilityService capabilities;

    public CapabilitiesApiController(CapabilityService capabilities) {
        this.capabilities = capabilities;
    }

    /** GET /api/capabilities —— 扁平工具清单（WonWork 主入口，返回 {tools, features}）。 */
    @GetMapping
    public Map<String, Object> root() {
        List<Map<String, Object>> tools = flatten();
        return Map.of(
                "tools", tools,
                "features", List.of("frontend_loop_online"),
                "version", "1"
        );
    }

    /** GET /api/capabilities/all —— 全量扁平清单。 */
    @GetMapping("/all")
    public List<Map<String, Object>> all() {
        return flatten();
    }

    /** GET /api/capabilities/tree?path= —— 目录浏览。 */
    @GetMapping("/tree")
    public Map<String, Object> tree(
            @RequestParam(value = "path", defaultValue = "/") String path
    ) {
        CapabilityListing listing = capabilities.list(normalize(path), LOCAL);
        List<Map<String, Object>> nodes = new ArrayList<>();
        for (var dir : listing.directories()) {
            nodes.add(Map.of(
                    "path", dir.path(),
                    "name", dir.title(),
                    "type", "folder",
                    "kind", "folder",
                    "toolCount", dir.capabilityCount()
            ));
        }
        for (CapabilityCard item : listing.items()) {
            nodes.add(Map.of(
                    "path", item.path(),
                    "name", item.name(),
                    "type", "tool",
                    "kind", "tool",
                    "description", item.description() == null ? "" : item.description(),
                    "riskLevel", item.riskLevel() == null ? "standard" : item.riskLevel()
            ));
        }
        CapabilityNode tree = capabilities.tree(LOCAL);
        return Map.of(
                "path", listing.parentPath(),
                "nodes", nodes,
                "totalTools", tree.toolCount()
        );
    }

    /** GET /api/capabilities/schema?path= —— 单工具完整 schema。 */
    @GetMapping("/schema")
    public Map<String, Object> schema(@RequestParam("path") String path) {
        return capabilities.read(normalize(path), LOCAL)
                .map(binding -> {
                    Map<String, Object> out = new java.util.LinkedHashMap<>();
                    out.put("path", binding.capabilityPath());
                    out.put("name", binding.manifest().name());
                    out.put("description", binding.manifest().description());
                    // Only the model-facing contract, never the binding or executor configuration.
                    if (binding.manifest().prompt() != null) {
                        out.put("prompt", binding.manifest().prompt());
                    }
                    out.put("parameters", binding.manifest().inputSchema());
                    out.put("riskLevel", binding.manifest().riskLevel().name().toLowerCase());
                    out.put("tier", path.startsWith("/system/") ? "primitive" : "domain_operation");
                    out.put("loadStrategy", "deferred");
                    return out;
                })
                .orElseThrow(() -> new org.springframework.web.server.ResponseStatusException(
                        org.springframework.http.HttpStatus.NOT_FOUND, "capability not found: " + path));
    }

    private List<Map<String, Object>> flatten() {
        CapabilityNode tree = capabilities.tree(LOCAL);
        List<Map<String, Object>> out = new ArrayList<>();
        collect(tree, out);
        return out;
    }

    private void collect(CapabilityNode node, List<Map<String, Object>> out) {
        if (node.path() != null && !node.path().isEmpty() && node.children().isEmpty()) {
            capabilities.read(node.path(), LOCAL).ifPresent(binding -> {
                Map<String, Object> item = new java.util.LinkedHashMap<>(Map.of(
                        "name", binding.manifest().name(),
                        "path", node.path(),
                        "description", binding.manifest().description() == null
                                ? "" : binding.manifest().description(),
                        "parameters", binding.manifest().inputSchema(),
                        "riskLevel", binding.manifest().riskLevel().name().toLowerCase(),
                        "tier", node.path().startsWith("/system/") ? "primitive" : "domain_operation",
                        "loadStrategy", "deferred"
                ));
                if (binding.manifest().prompt() != null) {
                    item.put("prompt", binding.manifest().prompt());
                }
                out.add(item);
            });
        }
        for (CapabilityNode child : node.children()) {
            collect(child, out);
        }
    }

    private String normalize(String path) {
        return capabilities.normalizePath(path == null || path.isEmpty() ? "/" : path);
    }
}
