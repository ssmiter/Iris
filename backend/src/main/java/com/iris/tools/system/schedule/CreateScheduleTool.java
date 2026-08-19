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

/** 创建一条定时任务：到点为 prompt 开一个新会话来执行。 */
@Component
public class CreateScheduleTool implements Tool {

    private final ObjectMapper objectMapper;
    private final CronScheduleService schedules;
    private final ToolManifest manifest;

    public CreateScheduleTool(
            ObjectMapper objectMapper,
            CronScheduleService schedules
    ) {
        this.objectMapper = objectMapper;
        this.schedules = schedules;
        this.manifest = new ToolManifest(
                "iris.system.schedule.create_schedule",
                "1",
                "create_schedule",
                "创建一条定时任务：按六位 cron 表达式（秒 分 时 日 月 周）周期性地以给定 prompt 开启新会话执行；适合用户明确要求的提醒、巡检与例行整理",
                inputSchema(),
                outputSchema(),
                RiskLevel.ELEVATED,
                ToolManifest.SideEffect.INTERNAL_STATE,
                15,
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
        String name = input.path("name").asText("").trim();
        String expression = input.path("expression").asText("").trim();
        String prompt = input.path("prompt").asText("").trim();
        boolean once = input.has("once") && input.path("once").asBoolean(false);
        if (name.isBlank()
                || name.length() > CronScheduleService.MAX_NAME_CHARS) {
            throw new IllegalArgumentException(
                    "name must contain 1 to "
                            + CronScheduleService.MAX_NAME_CHARS
                            + " characters"
            );
        }
        if (!org.springframework.scheduling.support.CronExpression
                .isValidExpression(expression)) {
            throw new IllegalArgumentException(
                    "expression must be a valid six-field cron expression"
            );
        }
        if (prompt.isBlank()
                || prompt.length() > CronScheduleService.MAX_PROMPT_CHARS) {
            throw new IllegalArgumentException(
                    "prompt must contain 1 to "
                            + CronScheduleService.MAX_PROMPT_CHARS
                            + " characters"
            );
        }
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("name", name);
        normalized.put("expression", expression);
        normalized.put("prompt", prompt);
        normalized.put("once", once);
        normalized.put("enabled",
                !input.has("enabled") || input.path("enabled").asBoolean(true));
        String onceHint = once ? "单次任务，触发一次后自动停用；" : "";
        return new PreparedOperation(
                normalized,
                "创建" + (once ? "单次" : "定时") + "任务「" + name + "」（" + expression
                        + "）；" + onceHint + "到点会以该 prompt 自动开启新会话执行，"
                        + "其中的写动作仍需逐次审批",
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
        var view = schedules.create(
                input.path("name").asText(),
                input.path("expression").asText(),
                input.path("prompt").asText(),
                input.path("enabled").asBoolean(true),
                input.path("once").asBoolean(false),
                "agent"
        );
        return ToolOutcome.succeeded(objectMapper.valueToTree(view));
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        String taskId = outcome.output().path("taskId").asText("");
        if (taskId.isBlank() || schedules.find(taskId).isEmpty()) {
            return new VerificationResult(
                    VerificationResult.Status.FAILED,
                    List.of(),
                    "定时任务没有持久化"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "cron_task",
                        taskId,
                        "定时任务已落库并纳入调度"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("name")
                .put("type", "string")
                .put("description", "任务的人可读名称")
                .put("minLength", 1)
                .put("maxLength", CronScheduleService.MAX_NAME_CHARS);
        properties.putObject("expression")
                .put("type", "string")
                .put("description",
                        "六位 cron 表达式（秒 分 时 日 月 周），系统本地时区；"
                                + "例如 0 0 9 * * * 表示每天 09:00")
                .put("minLength", 1)
                .put("maxLength", 100);
        properties.putObject("prompt")
                .put("type", "string")
                .put("description",
                        "到点执行的自包含任务正文；不依赖任何对话上下文")
                .put("minLength", 1)
                .put("maxLength", CronScheduleService.MAX_PROMPT_CHARS);
        properties.putObject("enabled")
                .put("type", "boolean")
                .put("description", "是否立即启用，默认 true")
                .put("default", true);
        properties.putObject("once")
                .put("type", "boolean")
                .put("description", "是否为单次任务：true 表示到点触发一次后自动停用，不再周期触发；默认 false")
                .put("default", false);
        schema.putArray("required")
                .add("name").add("expression").add("prompt");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", true);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("taskId")
                .put("type", "string")
                .put("description", "定时任务的稳定标识");
        properties.putObject("nextFireAt")
                .put("type", "string")
                .put("description", "下一次触发时刻（启用时非空）");
        return schema;
    }
}
