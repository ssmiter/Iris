package com.iris.tools.system.agents;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.run.AgentRunContextRepository;
import com.iris.agent.run.AgentRunLauncher;
import com.iris.agent.run.RunRoundRepository;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.VerificationResult;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

/** Signals cancellation to one isolated child Run without stopping its Turn. */
@Component
public class CancelAgentRunTool implements Tool {
    private final ObjectMapper objectMapper;
    private final AgentRunContextRepository contexts;
    private final RunRoundRepository runs;
    private final AgentRunLauncher launcher;
    private final ToolManifest manifest;

    public CancelAgentRunTool(
            ObjectMapper objectMapper,
            AgentRunContextRepository contexts,
            RunRoundRepository runs,
            AgentRunLauncher launcher
    ) {
        this.objectMapper = objectMapper;
        this.contexts = contexts;
        this.runs = runs;
        this.launcher = launcher;
        this.manifest = new ToolManifest(
                "iris.system.agents.cancel",
                "1",
                "cancel_agent_run",
                "请求停止一个仍在运行或排队的隔离子 Agent；已提交的真实写动作不会被伪装成回滚，终态仍会携带已有部分结果通知父 Run",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.INTERNAL_STATE,
                5,
                2_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
                ToolManifest.EvidencePolicy.REQUIRED
        );
    }

    @Override
    public ToolManifest manifest() { return manifest; }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String runId = input.path("run_id").asText("").trim();
        if (runId.isBlank()) {
            throw new IllegalArgumentException("run_id is required");
        }
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("run_id", runId);
        return new PreparedOperation(
                normalized,
                "请求停止隔离子 Agent " + runId,
                List.of(new PreparedOperation.ResourceClaim(
                        "agent_run", runId, null
                )),
                Instant.now().plusSeconds(30)
        );
    }

    @Override
    public ToolOutcome execute(CommittedOperation operation, ToolContext context) {
        String runId = operation.normalizedInput().path("run_id").asText();
        var run = runs.findRun(runId).orElse(null);
        if (run == null || contexts.find(runId).isEmpty()) {
            return ToolOutcome.failed(
                    "child_agent_not_found",
                    "找不到这个隔离子 Agent Run"
            );
        }
        ObjectNode output = objectMapper.createObjectNode();
        output.put("runId", runId);
        if (run.phase().terminal()) {
            output.put("accepted", false);
            output.put("phase", run.phase().name().toLowerCase());
            output.put("message", "目标 Run 已经结束，没有重复发送停止信号");
            return ToolOutcome.succeeded(output);
        }
        output.put("accepted", launcher.requestStop(runId));
        output.put("phase", "cancellation_requested");
        output.put("message", "停止信号已写入运行时；最终状态和部分结果会随后通知");
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
                        "agent_run_cancellation",
                        operation.normalizedInput().path("run_id").asText(),
                        outcome.output().path("message").asText()
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        schema.putObject("properties").putObject("run_id")
                .put("type", "string")
                .put("description", "delegate_task 返回的 child Agentic Run id");
        schema.putArray("required").add("run_id");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", true);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("runId").put("type", "string")
                .put("description", "目标 Run id");
        properties.putObject("accepted").put("type", "boolean")
                .put("description", "本次是否发出了新的停止信号");
        properties.putObject("phase").put("type", "string")
                .put("description", "停止请求后的阶段");
        properties.putObject("message").put("type", "string")
                .put("description", "可读的停止结果说明");
        return schema;
    }
}
