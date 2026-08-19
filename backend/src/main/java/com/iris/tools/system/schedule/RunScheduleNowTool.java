package com.iris.tools.system.schedule;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.schedule.CronFireService;
import com.iris.schedule.CronScheduleService;
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

/** 立即手动触发一次定时任务，不影响既有排程。 */
@Component
public class RunScheduleNowTool implements Tool {

    private final ObjectMapper objectMapper;
    private final CronScheduleService schedules;
    private final CronFireService fires;
    private final ToolManifest manifest;

    public RunScheduleNowTool(
            ObjectMapper objectMapper,
            CronScheduleService schedules,
            CronFireService fires
    ) {
        this.objectMapper = objectMapper;
        this.schedules = schedules;
        this.fires = fires;
        this.manifest = new ToolManifest(
                "iris.system.schedule.run_schedule_now",
                "1",
                "run_schedule_now",
                "立即以任务保存的 prompt 开启一个新会话执行一次，用于验证或临时补跑；触发的是独立新会话，不是当前对话的延续，且不改变原有的下一次触发时刻",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.INTERNAL_STATE,
                20,
                4_000,
                ToolManifest.IdempotencySemantics.NON_IDEMPOTENT,
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
        String taskId = input.path("task_id").asText("").trim();
        if (taskId.isBlank()) {
            throw new IllegalArgumentException("task_id is required");
        }
        CronScheduleService.ScheduleView current = schedules.require(taskId);
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("task_id", taskId);
        return new PreparedOperation(
                normalized,
                "立即执行一次定时任务「" + current.name()
                        + "」，为其 prompt 开启新会话；不影响既有排程",
                List.of(),
                Instant.now().plusSeconds(60)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        String taskId = operation.normalizedInput().path("task_id").asText();
        return ToolOutcome.succeeded(objectMapper.valueToTree(
                fires.fireNow(taskId)
        ));
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        String executionId = outcome.output().path("executionId").asText("");
        String status = outcome.output().path("status").asText("");
        if (executionId.isBlank() || !"fired".equals(status)) {
            return new VerificationResult(
                    VerificationResult.Status.FAILED,
                    List.of(),
                    "执行记录未落库或触发失败："
                            + outcome.output().path("error").asText("未知原因")
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "cron_execution",
                        executionId,
                        "已为任务开启新会话并记录执行"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("task_id")
                .put("type", "string")
                .put("description", "定时任务的稳定标识");
        schema.putArray("required").add("task_id");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", true);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("executionId")
                .put("type", "string")
                .put("description", "本次执行记录的稳定标识");
        properties.putObject("conversationId")
                .put("type", "string")
                .put("description", "本次触发产生的会话");
        properties.putObject("runId")
                .put("type", "string")
                .put("description", "本次触发产生的 root Run");
        properties.putObject("status")
                .put("type", "string")
                .put("description", "fired 或 failed");
        return schema;
    }
}
