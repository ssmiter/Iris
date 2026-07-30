package com.iris.tools.system.tasks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.task.TaskLedgerService;
import com.iris.task.TaskLedgerService.TaskSnapshot;
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

@Component
public class CreateTaskLedgerTool implements Tool {
    private final ObjectMapper objectMapper;
    private final TaskLedgerService tasks;
    private final ToolManifest manifest;

    public CreateTaskLedgerTool(
            ObjectMapper objectMapper,
            TaskLedgerService tasks
    ) {
        this.objectMapper = objectMapper;
        this.tasks = tasks;
        this.manifest = new ToolManifest(
                "iris.system.tasks.create_task_ledger",
                "1",
                "create_task_ledger",
                "为确实需要跨多步或跨轮次推进的用户目标创建版本化任务定义与工作状态；简单问答不要使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.INTERNAL_STATE,
                10,
                12_000,
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
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put(
                "objective",
                TaskToolSupport.text(
                        input,
                        "objective",
                        TaskToolSupport.MAX_OBJECTIVE,
                        true
                )
        );
        normalized.set(
                "constraints",
                TaskToolSupport.stringArray(
                        objectMapper, input, "constraints", 0
                )
        );
        normalized.set(
                "completion_criteria",
                TaskToolSupport.stringArray(
                        objectMapper, input, "completion_criteria", 1
                )
        );
        normalized.set(
                "steps",
                TaskToolSupport.steps(objectMapper, input)
        );
        normalized.put(
                "summary",
                TaskToolSupport.text(
                        input,
                        "summary",
                        TaskToolSupport.MAX_SUMMARY,
                        false
                )
        );
        return new PreparedOperation(
                normalized,
                "为当前对话记录一个可恢复的任务定义和初始工作状态；"
                        + "不修改工作区或外部系统",
                List.of(new PreparedOperation.ResourceClaim(
                        "conversation_task_ledger",
                        context.conversationId(),
                        null
                )),
                Instant.now().plusSeconds(30)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode input = operation.normalizedInput();
        TaskSnapshot created = tasks.create(
                context,
                input.path("objective").asText(),
                (ArrayNode) input.path("constraints"),
                (ArrayNode) input.path("completion_criteria"),
                (ArrayNode) input.path("steps"),
                input.path("summary").asText()
        );
        return ToolOutcome.succeeded(tasks.toJson(created));
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        TaskSnapshot current = tasks.require(
                outcome.output().path("taskId").asText(),
                context
        );
        if (current.stateVersion()
                != outcome.output().path("stateVersion").asInt()) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "任务已经创建，但当前 head 无法与创建结果对应"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "task_state_version",
                        current.taskId(),
                        "任务定义版本 1、工作状态版本 1 已持久化"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = TaskToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("objective")
                .put("type", "string")
                .put("description", "用户真正要达到的目标，不写执行过程")
                .put("maxLength", TaskToolSupport.MAX_OBJECTIVE);
        properties.set(
                "constraints",
                TaskToolSupport.stringArraySchema(
                        objectMapper,
                        "必须持续遵守的用户约束；没有时传空数组",
                        0
                )
        );
        properties.set(
                "completion_criteria",
                TaskToolSupport.stringArraySchema(
                        objectMapper,
                        "判断任务是否完成的可核验标准",
                        1
                )
        );
        properties.set("steps", TaskToolSupport.stepsSchema(objectMapper));
        properties.putObject("summary")
                .put("type", "string")
                .put("description", "当前工作态的一段短摘要，不复述完整目标")
                .put("maxLength", TaskToolSupport.MAX_SUMMARY);
        schema.putArray("required")
                .add("objective").add("constraints")
                .add("completion_criteria").add("steps").add("summary");
        return schema;
    }

    private JsonNode outputSchema() {
        return taskOutputSchema();
    }

    static JsonNode taskOutputSchema() {
        ObjectNode schema = new ObjectMapper().createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", true);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("taskId")
                .put("type", "string")
                .put("description", "任务稳定 ID");
        properties.putObject("stateVersion")
                .put("type", "integer")
                .put("description", "更新时必须携带的当前工作状态版本");
        schema.putArray("required").add("taskId").add("stateVersion");
        return schema;
    }
}
