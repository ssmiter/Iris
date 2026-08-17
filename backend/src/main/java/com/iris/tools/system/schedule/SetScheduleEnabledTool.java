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

/** 启用或停用一条定时任务；停用后保留定义与执行历史。 */
@Component
public class SetScheduleEnabledTool implements Tool {

    private final ObjectMapper objectMapper;
    private final CronScheduleService schedules;
    private final ToolManifest manifest;

    public SetScheduleEnabledTool(
            ObjectMapper objectMapper,
            CronScheduleService schedules
    ) {
        this.objectMapper = objectMapper;
        this.schedules = schedules;
        this.manifest = new ToolManifest(
                "iris.system.schedule.set_schedule_enabled",
                "1",
                "set_schedule_enabled",
                "启用或停用一条已存在的定时任务；停用只是暂停未来的触发，定义与执行历史都保留",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.INTERNAL_STATE,
                10,
                4_000,
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
        if (!input.has("enabled") || !input.path("enabled").isBoolean()) {
            throw new IllegalArgumentException("enabled must be a boolean");
        }
        boolean enabled = input.path("enabled").asBoolean();
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
        normalized.put("enabled", enabled);
        return new PreparedOperation(
                normalized,
                (enabled ? "启用" : "停用") + "定时任务「" + current.name()
                        + "」",
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
        return ToolOutcome.succeeded(objectMapper.valueToTree(
                schedules.setEnabled(
                        input.path("task_id").asText(),
                        input.path("expected_version").asLong(),
                        input.path("enabled").asBoolean()
                )
        ));
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode input = operation.normalizedInput();
        String taskId = input.path("task_id").asText();
        boolean enabled = input.path("enabled").asBoolean();
        return schedules.find(taskId)
                .filter(view -> view.enabled() == enabled)
                .map(view -> VerificationResult.confirmed(List.of(
                        new VerificationResult.Evidence(
                                "cron_task",
                                taskId,
                                "定时任务已" + (enabled ? "启用" : "停用")
                        )
                )))
                .orElseGet(() -> new VerificationResult(
                        VerificationResult.Status.FAILED,
                        List.of(),
                        "定时任务的启用状态未按预期落库"
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
                        "读取到的当前 version，防止基于过期视图做修改");
        properties.putObject("enabled")
                .put("type", "boolean")
                .put("description", "true 启用，false 停用");
        schema.putArray("required")
                .add("task_id").add("expected_version").add("enabled");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", true);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("taskId")
                .put("type", "string")
                .put("description", "任务的稳定标识");
        properties.putObject("enabled")
                .put("type", "boolean")
                .put("description", "变更后的启用状态");
        properties.putObject("nextFireAt")
                .put("type", "string")
                .put("description", "下一次触发时刻（启用时非空）");
        return schema;
    }
}
