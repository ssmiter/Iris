package com.iris.tools.system.agents;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.pipeline.PipelineCommandService;
import com.iris.agent.pipeline.PipelineRunCoordinator;
import com.iris.agent.pipeline.PipelineRunRepository;
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

/** Launches the same Agentic kernel behind a durable child Pipeline. */
@Component
public class DelegateTaskTool implements Tool {
    private static final String PIPELINE_ID = "iris.pipeline.delegated_task";
    private final ObjectMapper objectMapper;
    private final PipelineCommandService commands;
    private final PipelineRunCoordinator coordinator;
    private final PipelineRunRepository runs;
    private final ToolManifest manifest;

    public DelegateTaskTool(
            ObjectMapper objectMapper,
            PipelineCommandService commands,
            PipelineRunCoordinator coordinator,
            PipelineRunRepository runs
    ) {
        this.objectMapper = objectMapper;
        this.commands = commands;
        this.coordinator = coordinator;
        this.runs = runs;
        this.manifest = new ToolManifest(
                "iris.system.agents.delegate_task",
                "2",
                "delegate_task",
                "把一个不依赖当前隐式思考、可以独立完成的明确子目标交给后台子 Agent；立即返回稳定 Run 标识，完成或失败后自动向父 Run 发送有界结果通知",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.INTERNAL_STATE,
                15,
                4_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT_WITH_KEY,
                ToolManifest.EvidencePolicy.REQUIRED,
                ToolManifest.ContextRetention.PINNED,
                ToolManifest.ConcurrencySemantics.SERIAL,
                ToolManifest.CancellationSemantics.COMMIT_BOUNDARY
        );
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String task = input.path("task").asText("").trim();
        if (task.isBlank() || task.length() > 12_000) {
            throw new IllegalArgumentException(
                    "task must contain 1 to 12000 characters"
            );
        }
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("task", task);
        copyOptionalText(input, normalized, "context", 8_000);
        copyOptionalText(input, normalized, "deliverable", 4_000);
        String workMode = input.path("work_mode").asText("observe").trim();
        if (!"observe".equals(workMode) && !"workspace".equals(workMode)) {
            throw new IllegalArgumentException(
                    "work_mode must be observe or workspace"
            );
        }
        normalized.put("work_mode", workMode);
        if (input.has("constraints")) {
            if (!input.path("constraints").isArray()
                    || input.path("constraints").size() > 12) {
                throw new IllegalArgumentException(
                        "constraints must be an array with at most 12 items"
                );
            }
            var constraints = normalized.putArray("constraints");
            for (JsonNode item : input.path("constraints")) {
                String value = item.asText("").trim();
                if (value.isBlank() || value.length() > 1_000) {
                    throw new IllegalArgumentException(
                            "each constraint must contain 1 to 1000 characters"
                    );
                }
                constraints.add(value);
            }
        }
        return new PreparedOperation(
                normalized,
                "创建一个隔离后台子任务；它只改变 Iris 内部运行状态，真实写动作仍由子 Agent 的 Tool Runtime 单独审批",
                List.of(new PreparedOperation.ResourceClaim(
                        "agent_run_slot",
                        context.runId(),
                        context.roundId()
                )),
                Instant.now().plusSeconds(30)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        var accepted = commands.createChild(
                PIPELINE_ID,
                operation.normalizedInput(),
                context.runId(),
                "agent_tool",
                operation.executionId(),
                "agent"
        );
        var progress = coordinator.advance(accepted.runId()).block();
        if (progress == null) {
            return ToolOutcome.failed(
                    "pipeline_launch_failed",
                    "子任务 Pipeline 没有返回可持久化的启动状态"
            );
        }
        String childRunId = runs.nextOpenStep(accepted.runId())
                .map(PipelineRunRepository.StepRun::childRunId)
                .orElse(null);
        ObjectNode output = objectMapper.createObjectNode();
        output.put("pipelineRunId", accepted.runId());
        if (childRunId != null) {
            output.put("agentRunId", childRunId);
        }
        output.put("phase", progress.phase().name().toLowerCase());
        output.put(
                "delivery",
                "后台运行完成、失败或取消后会自动向当前 Run 发送通知；无需轮询"
        );
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        String pipelineRunId = outcome.output()
                .path("pipelineRunId").asText("");
        if (pipelineRunId.isBlank() || runs.find(pipelineRunId).isEmpty()) {
            return new VerificationResult(
                    VerificationResult.Status.FAILED,
                    List.of(),
                    "后台 Pipeline Run 没有持久化"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "pipeline_run",
                        pipelineRunId,
                        "隔离子任务已进入 durable Pipeline/Agentic Run 链路"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("task")
                .put("type", "string")
                .put("description", "无需父 Agent 隐式思考即可理解的自包含任务；应写清目标、范围和期望结果")
                .put("minLength", 1)
                .put("maxLength", 12_000);
        properties.putObject("context")
                .put("type", "string")
                .put("description", "完成判断必需的背景、已排除方向和稳定引用；不要复制整段父对话")
                .put("maxLength", 8_000);
        properties.putObject("deliverable")
                .put("type", "string")
                .put("description", "期望交付物和验收标准")
                .put("maxLength", 4_000);
        properties.putObject("constraints")
                .put("type", "array")
                .put("description", "子任务必须遵守的职责边界和限制")
                .put("maxItems", 12)
                .putObject("items")
                .put("type", "string")
                .put("minLength", 1)
                .put("maxLength", 1_000);
        properties.putObject("work_mode")
                .put("type", "string")
                .put("description", "observe 只能观察；workspace 才允许在工作区内产生变更，默认 observe")
                .put("default", "observe")
                .putArray("enum")
                .add("observe")
                .add("workspace");
        schema.putArray("required").add("task");
        return schema;
    }

    private void copyOptionalText(
            JsonNode source,
            ObjectNode target,
            String field,
            int maxLength
    ) {
        if (!source.has(field)) {
            return;
        }
        String value = source.path(field).asText("").trim();
        if (value.length() > maxLength) {
            throw new IllegalArgumentException(
                    field + " exceeds " + maxLength + " characters"
            );
        }
        if (!value.isBlank()) {
            target.put(field, value);
        }
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", true);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("pipelineRunId")
                .put("type", "string")
                .put("description", "编排该任务的 Pipeline Run id");
        properties.putObject("agentRunId")
                .put("type", "string")
                .put("description", "执行任务的 child Agentic Run id，可用于补充消息或取消");
        properties.putObject("phase")
                .put("type", "string")
                .put("description", "当前 Pipeline 运行阶段");
        properties.putObject("delivery")
                .put("type", "string")
                .put("description", "结果回流方式说明");
        return schema;
    }
}
