package com.iris.tools.system.capabilities;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.ResidentToolSurface;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolCallResolver;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.ToolRegistry;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.VerificationResult;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Stable provider surface for every non-resident capability.
 */
@Component
public final class InvokeCapabilityTool implements Tool, ToolCallResolver {
    private final ObjectMapper objectMapper;
    private final ObjectProvider<ToolRegistry> registry;
    private final JdbcClient jdbc;
    private final ToolManifest manifest;

    public InvokeCapabilityTool(
            ObjectMapper objectMapper,
            ObjectProvider<ToolRegistry> registry,
            JdbcClient jdbc
    ) {
        this.objectMapper = objectMapper;
        this.registry = registry;
        this.jdbc = jdbc;
        this.manifest = new ToolManifest(
                "iris.system.capabilities.invoke",
                "1",
                "invoke_capability",
                "调用本次任务中已用 read_capability 读取的精确非驻留能力；原样填写其 path、manifestHash 与 arguments，真实风险和审批由目标能力决定",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                5,
                4_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT_WITH_KEY,
                ToolManifest.EvidencePolicy.REQUIRED,
                ToolManifest.ContextRetention.PINNED,
                ToolManifest.ConcurrencySemantics.SERIAL,
                ToolManifest.CancellationSemantics.COOPERATIVE
        );
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public ResolvedToolCall resolve(JsonNode input, ToolContext context) {
        String path = input.path("path").asText().trim();
        String manifestHash = input.path("manifestHash").asText().trim();
        JsonNode arguments = input.path("arguments");
        if (path.isBlank() || !manifestHash.matches("[0-9a-f]{64}")
                || !arguments.isObject()) {
            throw new ToolRuntimeException(
                    "invalid_capability_invocation",
                    "调用需要 read_capability 返回的精确 path、manifestHash 和 object arguments"
            );
        }
        ToolRegistry.ToolBinding binding = registry.getObject()
                .findByCapabilityPath(path)
                .orElseThrow(() -> new ToolRuntimeException(
                        "capability_binding_not_found",
                        "当前 Registry 中找不到能力 " + path
                ));
        if (ResidentToolSurface.contains(binding.manifest().name())) {
            throw new ToolRuntimeException(
                    "resident_tool_requires_direct_call",
                    "该能力是常驻原语，请直接调用 "
                            + binding.manifest().name()
            );
        }
        if (!binding.manifestHash().equals(manifestHash)) {
            throw new ToolRuntimeException(
                    "capability_definition_changed",
                    "能力定义已变化；请重新 read_capability 后再调用"
            );
        }
        if (!wasInspectedEarlier(
                context.runId(),
                context.roundId(),
                path,
                manifestHash
        )) {
            throw new ToolRuntimeException(
                    "capability_not_inspected",
                    "当前任务尚未读取这份精确定义；请先 read_capability"
            );
        }
        return new ResolvedToolCall(
                binding.manifest().name(),
                binding.capabilityPath(),
                binding.manifestHash(),
                arguments
        );
    }

    private boolean wasInspectedEarlier(
            String runId,
            String roundId,
            String path,
            String manifestHash
    ) {
        return jdbc.sql("""
                SELECT COUNT(*)
                FROM tool_observation observation
                JOIN model_tool_call call
                  ON call.tool_call_id = observation.tool_call_id
                JOIN model_attempt attempt
                  ON attempt.attempt_id = call.attempt_id
                JOIN agent_round source
                  ON source.round_id = attempt.round_id
                JOIN agent_round current
                  ON current.round_id = :roundId
                WHERE source.run_id = :runId
                  AND current.run_id = :runId
                  AND source.round_index < current.round_index
                  AND call.tool_name = 'read_capability'
                  AND observation.outcome_kind = 'succeeded'
                  AND json_extract(
                        observation.content_json,
                        '$.output.path'
                      ) = :path
                  AND json_extract(
                        observation.content_json,
                        '$.output.manifestHash'
                      ) = :manifestHash
                """)
                .param("runId", runId)
                .param("roundId", roundId)
                .param("path", path)
                .param("manifestHash", manifestHash)
                .query(Integer.class)
                .single() > 0;
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        throw new ToolRuntimeException(
                "capability_proxy_not_resolved",
                "invoke_capability 必须先由 ToolRuntime 解析真实目标"
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        throw new ToolRuntimeException(
                "capability_proxy_not_resolved",
                "invoke_capability 不能作为普通工具执行"
        );
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        throw new ToolRuntimeException(
                "capability_proxy_not_resolved",
                "invoke_capability 没有独立验证阶段"
        );
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("path")
                .put("type", "string")
                .put("description", "read_capability 返回的精确能力绝对路径");
        properties.putObject("manifestHash")
                .put("type", "string")
                .put("description", "read_capability 返回的 64 位 Manifest SHA-256");
        properties.putObject("arguments")
                .put("type", "object")
                .put("description", "严格按该 Definition inputSchema 生成的目标参数");
        schema.putArray("required")
                .add("path")
                .add("manifestHash")
                .add("arguments");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", true);
        schema.putObject("properties")
                .putObject("result")
                .put("description", "真实目标能力声明的输出；具体字段见其 Definition")
                .put("type", "object");
        return schema;
    }
}
