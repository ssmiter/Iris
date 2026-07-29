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
public class ListCapabilitiesTool implements Tool {
    private final ObjectMapper objectMapper;
    private final ObjectProvider<CapabilityService> capabilities;
    private final ToolManifest manifest;

    public ListCapabilitiesTool(
            ObjectMapper objectMapper,
            ObjectProvider<CapabilityService> capabilities
    ) {
        this.objectMapper = objectMapper;
        this.capabilities = capabilities;
        this.manifest = new ToolManifest(
                "iris.system.capabilities.list",
                "4",
                "list_capabilities",
                "列出能力目录的直接子目录、语义说明、已实现数量和当前层工具卡片；结构未知时浏览，词面明确时搜索",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                5,
                20_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
                ToolManifest.EvidencePolicy.SUMMARY,
                ToolManifest.ContextRetention.PINNED,
                ToolManifest.ConcurrencySemantics.PARALLEL_SAFE,
                ToolManifest.CancellationSemantics.COOPERATIVE
        );
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String path = input.path("path").asText("/");
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("path", path);
        return new PreparedOperation(
                normalized,
                "读取能力目录 " + path + "，不改变任何状态",
                List.of(),
                Instant.now().plusSeconds(30)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        return ToolOutcome.succeeded(objectMapper.valueToTree(
                capabilities.getObject().list(
                        operation.normalizedInput().path("path").asText(),
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
                        "目录来自语义目录地图与当前已校验的 Tool Registry"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        schema.putObject("properties").putObject("path")
                .put("type", "string")
                .put("description", "要浏览的能力目录绝对路径；默认 /");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", true);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("parentPath")
                .put("type", "string")
                .put("description", "当前目录");
        properties.putObject("directories")
                .put("type", "array")
                .put(
                        "description",
                        "直接子目录、语义说明及已注册能力数量；数量为 0 表示只有目录地图"
                );
        ObjectNode items = properties.putObject("items");
        items.put("type", "array");
        items.put(
                "description",
                "当前目录下不含 schema、带实时 availability 的能力卡片"
        );
        ObjectNode item = items.putObject("items");
        item.put("type", "object");
        ObjectNode itemProperties = item.putObject("properties");
        itemProperties.putObject("id").put("type", "string");
        itemProperties.putObject("version").put("type", "string");
        itemProperties.putObject("name").put("type", "string");
        itemProperties.putObject("path").put("type", "string");
        itemProperties.putObject("description").put("type", "string");
        itemProperties.putObject("riskLevel").put("type", "string");
        itemProperties.putObject("availability").put("type", "string");
        itemProperties.putObject("availabilityReason")
                .put("type", "string");
        return schema;
    }
}
