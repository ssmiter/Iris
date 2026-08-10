package com.iris.tools.system.capabilities;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.pipeline.PipelineCommandService;
import com.iris.agent.pipeline.PipelineDefinitionRegistry;
import com.iris.agent.pipeline.PipelineRunCoordinator;
import com.iris.agent.pipeline.PipelineRunRepository;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.VerificationResult;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

/** Stable provider proxy for discovered Pipeline capabilities. */
@Component
public class InvokePipelineTool implements Tool {
    private final ObjectMapper objectMapper;
    private final PipelineDefinitionRegistry definitions;
    private final PipelineCommandService commands;
    private final ObjectProvider<PipelineRunCoordinator> coordinator;
    private final PipelineRunRepository runs;
    private final JdbcClient jdbc;
    private final ToolManifest manifest;

    public InvokePipelineTool(
            ObjectMapper objectMapper,
            PipelineDefinitionRegistry definitions,
            PipelineCommandService commands,
            ObjectProvider<PipelineRunCoordinator> coordinator,
            PipelineRunRepository runs,
            JdbcClient jdbc
    ) {
        this.objectMapper = objectMapper;
        this.definitions = definitions;
        this.commands = commands;
        this.coordinator = coordinator;
        this.runs = runs;
        this.jdbc = jdbc;
        this.manifest = new ToolManifest(
                "iris.system.capabilities.invoke_pipeline",
                "1",
                "invoke_pipeline",
                "启动本次任务中已由 read_capability 读取的精确版本化 Pipeline；原样传入 path、manifestHash 和 input，立即返回 durable Run 标识，内部真实动作仍逐个经过 Tool Runtime",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.INTERNAL_STATE,
                15,
                4_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT_WITH_KEY,
                ToolManifest.EvidencePolicy.REQUIRED
        );
    }

    @Override
    public ToolManifest manifest() { return manifest; }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String path = input.path("path").asText("").trim();
        String manifestHash = input.path("manifestHash").asText("").trim();
        JsonNode pipelineInput = input.path("input");
        if (path.isBlank() || !manifestHash.matches("[0-9a-f]{64}")
                || !pipelineInput.isObject()) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_pipeline_invocation",
                    "需要 read_capability 返回的精确 path、manifestHash 和 object input"
            );
        }
        var binding = definitions.findByPath(path).orElseThrow(() ->
                ToolRuntimeException.beforeCommit(
                        "pipeline_binding_not_found",
                        "当前 Registry 中找不到 Pipeline " + path
                )
        );
        if (!binding.snapshotHash().equals(manifestHash)) {
            throw ToolRuntimeException.beforeCommit(
                    "pipeline_definition_changed",
                    "Pipeline Definition 已变化；请重新 read_capability"
            );
        }
        if (!wasInspectedEarlier(
                context.runId(),
                context.roundId(),
                path,
                manifestHash
        )) {
            throw ToolRuntimeException.beforeCommit(
                    "pipeline_not_inspected",
                    "当前 Run 尚未在更早 Round 读取这份精确 Pipeline Definition"
            );
        }
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("path", path);
        normalized.put("manifestHash", manifestHash);
        normalized.set("input", pipelineInput.deepCopy());
        return new PreparedOperation(
                normalized,
                "启动固定 Pipeline " + path + "；其内部动作仍独立核验和审批",
                List.of(new PreparedOperation.ResourceClaim(
                        "pipeline_definition", path, manifestHash
                )),
                Instant.now().plusSeconds(30)
        );
    }

    @Override
    public ToolOutcome execute(CommittedOperation operation, ToolContext context) {
        String path = operation.normalizedInput().path("path").asText();
        var binding = definitions.findByPath(path).orElseThrow();
        var accepted = commands.createChild(
                binding.definition().id(),
                operation.normalizedInput().path("input"),
                context.runId(),
                "agent_pipeline_tool",
                operation.executionId(),
                "agent"
        );
        var progress = coordinator.getObject()
                .advance(accepted.runId()).block();
        if (progress == null) {
            return ToolOutcome.failed(
                    "pipeline_launch_failed",
                    "Pipeline 没有返回可持久化的启动状态"
            );
        }
        ObjectNode output = objectMapper.createObjectNode();
        output.put("pipelineRunId", accepted.runId());
        runs.nextOpenStep(accepted.runId())
                .map(PipelineRunRepository.StepRun::childRunId)
                .filter(java.util.Objects::nonNull)
                .ifPresent(value -> output.put("agentRunId", value));
        output.put("phase", progress.phase().name().toLowerCase());
        output.put("definitionId", binding.definition().id());
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        String runId = outcome.output().path("pipelineRunId").asText("");
        if (runId.isBlank() || runs.find(runId).isEmpty()) {
            return new VerificationResult(
                    VerificationResult.Status.FAILED,
                    List.of(),
                    "Pipeline Run 没有持久化"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "pipeline_run", runId,
                        "版本化 Pipeline 已进入统一 Run 调度"
                )
        ));
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

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("path").put("type", "string")
                .put("description", "read_capability 返回的精确 Pipeline 路径");
        properties.putObject("manifestHash").put("type", "string")
                .put("description", "read_capability 返回的 64 位 Definition SHA-256");
        properties.putObject("input").put("type", "object")
                .put("description", "严格按 Pipeline Definition inputSchema 生成的输入");
        schema.putArray("required")
                .add("path").add("manifestHash").add("input");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", true);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("pipelineRunId").put("type", "string")
                .put("description", "固定流程的 durable Run id");
        properties.putObject("agentRunId").put("type", "string")
                .put("description", "若当前步骤创建子 Agent，其 durable Run id");
        properties.putObject("phase").put("type", "string")
                .put("description", "当前 Pipeline phase");
        properties.putObject("definitionId").put("type", "string")
                .put("description", "已冻结的 Pipeline Definition id");
        return schema;
    }
}
