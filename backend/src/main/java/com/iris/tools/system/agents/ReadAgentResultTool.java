package com.iris.tools.system.agents;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.run.AgentRunResultRepository;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.VerificationResult;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

/** Reads a bounded window from a completed Run in the current branch. */
@Component
public class ReadAgentResultTool implements Tool {
    private static final int DEFAULT_WINDOW = 8_000;
    private static final int MAX_WINDOW = 12_000;

    private final ObjectMapper objectMapper;
    private final AgentRunResultRepository results;
    private final JdbcClient jdbc;
    private final ToolManifest manifest;

    public ReadAgentResultTool(
            ObjectMapper objectMapper,
            AgentRunResultRepository results,
            JdbcClient jdbc
    ) {
        this.objectMapper = objectMapper;
        this.results = results;
        this.jdbc = jdbc;
        this.manifest = new ToolManifest(
                "iris.system.agents.read_result",
                "1",
                "read_agent_result",
                "按字符窗口读取当前分支中已结束的子 Agent 或 Pipeline 结果；完成通知已足够时不要调用",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                5,
                2_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
                ToolManifest.EvidencePolicy.SUMMARY,
                ToolManifest.ContextRetention.REFETCHABLE,
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
        String runId = input.path("run_id").asText("").trim();
        int offset = input.path("offset").asInt(0);
        int maxChars = input.path("max_chars").asInt(DEFAULT_WINDOW);
        if (runId.isBlank() || offset < 0 || maxChars < 1
                || maxChars > MAX_WINDOW) {
            throw new IllegalArgumentException(
                    "run_id、非负 offset 和 1 到 12000 的 max_chars 是必需的"
            );
        }
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("run_id", runId);
        normalized.put("offset", offset);
        normalized.put("max_chars", maxChars);
        return new PreparedOperation(
                normalized,
                "读取子运行 " + runId + " 的一段持久结果，不改变任何状态",
                List.of(new PreparedOperation.ResourceClaim(
                        "agent_run_result", runId, null
                )),
                Instant.now().plusSeconds(30)
        );
    }

    @Override
    public ToolOutcome execute(CommittedOperation operation, ToolContext context) {
        String targetRunId = operation.normalizedInput()
                .path("run_id").asText();
        if (!isVisibleFrom(context.runId(), targetRunId)) {
            return ToolOutcome.failed(
                    "agent_result_outside_branch",
                    "只能读取当前会话分支中的已结束 Run 结果"
            );
        }
        var result = results.find(targetRunId).orElse(null);
        if (result == null) {
            return ToolOutcome.failed(
                    "agent_result_not_ready",
                    "目标 Run 尚未形成终态结果"
            );
        }
        String fullText = results.latestAssistantText(targetRunId);
        if (fullText.isBlank()) {
            fullText = result.summary();
        }
        int offset = operation.normalizedInput().path("offset").asInt();
        int maxChars = operation.normalizedInput().path("max_chars").asInt();
        int start = Math.min(offset, fullText.length());
        int end = Math.min(fullText.length(), start + maxChars);
        ObjectNode output = objectMapper.createObjectNode();
        output.put("runId", targetRunId);
        output.put("status", result.status());
        output.put("offset", start);
        output.put("nextOffset", end);
        output.put("totalChars", fullText.length());
        output.put("hasMore", end < fullText.length());
        output.put("text", fullText.substring(start, end));
        if (result.outputRef() != null) {
            output.put("outputRef", result.outputRef());
        }
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
                        "agent_run_result",
                        operation.normalizedInput().path("run_id").asText(),
                        "窗口来自已持久化的子 Run 结果"
                )
        ));
    }

    private boolean isVisibleFrom(String sourceRunId, String targetRunId) {
        return jdbc.sql("""
                SELECT COUNT(*)
                FROM agent_run source
                JOIN agent_run target
                  ON target.conversation_id = source.conversation_id
                 AND target.branch_id = source.branch_id
                WHERE source.run_id = :sourceRunId
                  AND target.run_id = :targetRunId
                  AND target.phase IN (
                    'succeeded', 'failed', 'cancelled', 'timed_out'
                  )
                """)
                .param("sourceRunId", sourceRunId)
                .param("targetRunId", targetRunId)
                .query(Integer.class)
                .single() > 0;
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("run_id").put("type", "string")
                .put("description", "delegate_task 或完成通知返回的 Run id");
        properties.putObject("offset").put("type", "integer")
                .put("minimum", 0).put("default", 0);
        properties.putObject("max_chars").put("type", "integer")
                .put("minimum", 1).put("maximum", MAX_WINDOW)
                .put("default", DEFAULT_WINDOW);
        schema.putArray("required").add("run_id");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", true);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("runId").put("type", "string");
        properties.putObject("status").put("type", "string");
        properties.putObject("offset").put("type", "integer");
        properties.putObject("nextOffset").put("type", "integer");
        properties.putObject("totalChars").put("type", "integer");
        properties.putObject("hasMore").put("type", "boolean");
        properties.putObject("text").put("type", "string");
        properties.putObject("outputRef").put("type", "string");
        return schema;
    }
}
