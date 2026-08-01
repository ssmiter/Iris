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
import com.iris.tools.core.ToolRegistry.ToolBinding;
import com.iris.tools.core.CapabilityAvailability;
import com.iris.tools.core.VerificationResult;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

@Component
public class ReadCapabilityTool implements Tool {
    private final ObjectMapper objectMapper;
    private final ObjectProvider<CapabilityService> capabilities;
    private final ToolManifest manifest;

    public ReadCapabilityTool(
            ObjectMapper objectMapper,
            ObjectProvider<CapabilityService> capabilities
    ) {
        this.objectMapper = objectMapper;
        this.capabilities = capabilities;
        this.manifest = new ToolManifest(
                "iris.system.capabilities.read",
                "4",
                "read_capability",
                "读取一个精确能力路径的版本化定义、参数 schema、当前可用性与稳定代理调用身份；调用非驻留能力前使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                5,
                30_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
                ToolManifest.EvidencePolicy.REQUIRED,
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
        String path = input.path("path").asText().trim();
        if (path.isBlank()) {
            throw new IllegalArgumentException("path 不能为空");
        }
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("path", path);
        return new PreparedOperation(
                normalized,
                "读取能力定义 " + path + "，不执行该能力",
                List.of(),
                Instant.now().plusSeconds(30)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        String path = operation.normalizedInput().path("path").asText();
        ToolBinding binding = capabilities.getObject()
                .read(path, "personal")
                .orElseThrow(() -> new IllegalArgumentException(
                        "找不到能力 " + path
                ));
        ObjectNode output = objectMapper.createObjectNode();
        output.put("kind", "tool");
        output.put("path", binding.capabilityPath());
        output.put("manifestHash", binding.manifestHash());
        CapabilityAvailability availability =
                capabilities.getObject().availability(binding);
        ObjectNode availabilityNode =
                output.putObject("availability");
        availabilityNode.put("status", availability.value());
        availabilityNode.put("reason", availability.reason());
        availabilityNode.put(
                "checkedAt",
                availability.checkedAt().toString()
        );
        output.set("manifest", objectMapper.valueToTree(binding.manifest()));
        ObjectNode invocation = output.putObject("invocation");
        invocation.put("toolName", "invoke_capability");
        invocation.put("path", binding.capabilityPath());
        invocation.put("manifestHash", binding.manifestHash());
        invocation.put(
                "instruction",
                "把 path 和 manifestHash 原样复制，并按 manifest.inputSchema 填写 arguments"
        );
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "capability_definition",
                        operation.normalizedInput().path("path").asText(),
                        "定义来自当前精确 Tool Registry binding"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("path")
                .put("type", "string")
                .put("description", "从目录或搜索卡片得到的精确能力绝对路径");
        schema.putArray("required").add("path");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", true);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("kind")
                .put("type", "string")
                .put("description", "能力定义类型；当前为 tool");
        properties.putObject("path")
                .put("type", "string")
                .put("description", "精确能力路径");
        properties.putObject("manifestHash")
                .put("type", "string")
                .put("description", "本次读取的不可变 Manifest hash");
        properties.putObject("availability")
                .put("type", "object")
                .put("description", "当前 binding 可用状态、原因与检查时间");
        properties.putObject("manifest")
                .put("type", "object")
                .put("description", "完整版本化 Tool Manifest 与参数 schema");
        properties.putObject("invocation")
                .put("type", "object")
                .put("description", "稳定 invoke_capability 的可复制调用身份；arguments 仍按 Manifest 填写");
        return schema;
    }
}
