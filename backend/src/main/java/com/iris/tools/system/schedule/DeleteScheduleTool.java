package com.iris.tools.system.schedule;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
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

/** 删除一条定时任务及其执行历史；已产生的会话不受影响。 */
@Component
public class DeleteScheduleTool implements Tool {

    private final ObjectMapper objectMapper;
    private final CronScheduleService schedules;
    private final ToolManifest manifest;

    public DeleteScheduleTool(
            ObjectMapper objectMapper,
            CronScheduleService schedules
    ) {
        this.objectMapper = objectMapper;
        this.schedules = schedules;
        this.manifest = new ToolManifest(
                "iris.system.schedule.delete_schedule",
                "1",
                "delete_schedule",
                "删除一条定时任务及其执行历史记录；已经触发产生的会话与结果保留，不再未来触发",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.INTERNAL_STATE,
                10,
                2_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
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
        long expectedVersion = input.path("expected_version").asLong(0);
        if (taskId.isBlank() || expectedVersion < 1) {
            throw new IllegalArgumentException(
                    "task_id and expected_version are required"
            );
        }
        CronScheduleService.ScheduleView current = schedules.require(taskId);
        if (current.version() != expectedVersion) {
            throw new IllegalArgumentException(
                    "Schedule " + taskId + " is at version "
                            + current.version() + "; re-read it first"
            );
        }
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("task_id", taskId);
        normalized.put("expected_version", expectedVersion);
        return new PreparedOperation(
                normalized,
                "删除定时任务「" + current.name()
                        + "」及其执行历史；已触发的会话保留",
                List.of(),
                Instant.now().plusSeconds(60)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode input = operation.normalizedInput();
        String taskId = input.path("task_id").asText();
        schedules.delete(taskId, input.path("expected_version").asLong());
        ObjectNode output = objectMapper.createObjectNode();
        output.put("taskId", taskId);
        output.put("deleted", true);
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        String taskId = operation.normalizedInput().path("task_id").asText();
        if (schedules.find(taskId).isPresent()) {
            return new VerificationResult(
                    VerificationResult.Status.FAILED,
                    List.of(),
                    "定时任务仍然存在"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "cron_task",
                        taskId,
                        "定时任务与执行历史已删除"
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
        properties.putObject("expected_version")
                .put("type", "integer")
                .put("description",
                        "读取到的当前 version，防止基于过期视图做删除");
        schema.putArray("required").add("task_id").add("expected_version");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", true);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("taskId")
                .put("type", "string")
                .put("description", "被删除任务的稳定标识");
        properties.putObject("deleted")
                .put("type", "boolean")
                .put("description", "恒为 true，表示删除已生效");
        return schema;
    }
}
