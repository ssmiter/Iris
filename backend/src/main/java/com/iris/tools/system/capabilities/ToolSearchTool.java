package com.iris.tools.system.capabilities;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.catalog.CapabilityService;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.VerificationResult;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

@Component
public class ToolSearchTool implements Tool {
    private final ObjectMapper objectMapper;
    private final ObjectProvider<CapabilityService> capabilities;
    private final ToolManifest manifest;

    public ToolSearchTool(
            ObjectMapper objectMapper,
            ObjectProvider<CapabilityService> capabilities
    ) {
        this.objectMapper = objectMapper;
        this.capabilities = capabilities;
        this.manifest = new ToolManifest(
                "iris.system.capabilities.search",
                "1",
                "tool_search",
                "按名称、描述、目录和参数词搜索能力卡片；不知道精确能力路径时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                5,
                20_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
                ToolManifest.EvidencePolicy.SUMMARY
        );
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String query = input.path("query").asText().trim();
        if (query.isBlank()) {
            throw new IllegalArgumentException("query 不能为空");
        }
        int limit = input.path("limit").asInt(10);
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("query", query);
        normalized.put("limit", limit);
        return new PreparedOperation(
                normalized,
                "搜索与“" + query + "”相关的能力卡片，不改变任何状态",
                List.of(),
                Instant.now().plusSeconds(30)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode input = operation.normalizedInput();
        return ToolOutcome.succeeded(objectMapper.valueToTree(
                capabilities.getObject().search(
                        input.path("query").asText(),
                        input.path("limit").asInt(),
                        "personal"
                )
        ));
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "capability_registry",
                        null,
                        "搜索结果来自当前已校验的 Tool Registry"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("query")
                .put("type", "string")
                .put("description", "描述所需能力的关键词");
        properties.putObject("limit")
                .put("type", "integer")
                .put("minimum", 1)
                .put("maximum", 50)
                .put("description", "返回卡片上限；默认 10");
        schema.putArray("required").add("query");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", true);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("query")
                .put("type", "string")
                .put("description", "规范化后的查询");
        properties.putObject("total")
                .put("type", "integer")
                .put("description", "截断前的匹配总数");
        properties.putObject("items")
                .put("type", "array")
                .put("description", "按相关度排序的能力卡片");
        return schema;
    }
}
