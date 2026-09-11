package com.iris.objective.tools;

import com.iris.tools.catalog.CapabilityService;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 兼容前端 Agentic 的轻量能力搜索；精确定义仍由 /api/capabilities/schema 读取。 */
@RestController
@RequestMapping("/api/tools")
public final class ToolDiscoveryApiController {
    private final CapabilityService capabilities;

    public ToolDiscoveryApiController(CapabilityService capabilities) {
        this.capabilities = capabilities;
    }

    @PostMapping("/search")
    public Map<String, Object> search(@RequestBody SearchRequest request) {
        int limit = request.limit() == null ? 20 : Math.max(1, Math.min(100, request.limit()));
        var result = capabilities.searchFiles(
                request.query(), "/", false, false, null, 0, limit,
                request.systemCode() == null || request.systemCode().isBlank() ? "local" : request.systemCode());
        List<Map<String, Object>> tools = result.matches().stream().map(match -> {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("name", match.name());
            item.put("description", match.preview() == null ? "" : match.preview());
            item.put("path", match.path());
            item.put("tier", match.path().startsWith("/system/") ? "primitive" : "domain_operation");
            item.put("loadStrategy", "deferred");
            return item;
        }).toList();
        return Map.of("tools", tools, "query", request.query(), "total", result.total());
    }

    public record SearchRequest(String query, String systemCode, List<String> includeTiers, String category, Integer limit) { }
}
