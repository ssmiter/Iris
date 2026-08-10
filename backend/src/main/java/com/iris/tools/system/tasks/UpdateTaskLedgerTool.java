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
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.VerificationResult;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

@Component
public class UpdateTaskLedgerTool implements Tool {
    private final ObjectMapper objectMapper;
    private final TaskLedgerService tasks;
    private final ToolManifest manifest;

    public UpdateTaskLedgerTool(
            ObjectMapper objectMapper,
            TaskLedgerService tasks
    ) {
        this.objectMapper = objectMapper;
        this.tasks = tasks;
        this.manifest = new ToolManifest(
                "iris.system.tasks.update_task_ledger",
                "2",
                "update_task_ledger",
                "以版本前置条件提交任务工作状态的新版本；只记录步骤、阻塞和稳定引用，不改写任务目标",
                inputSchema(),
                CreateTaskLedgerTool.taskOutputSchema(),
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
        String taskId = TaskToolSupport.text(
                input, "task_id", 100, true
        );
        int expectedVersion = input.path("expected_state_version").asInt(-1);
        if (expectedVersion < 1) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_task_state_version",
                    "expected_state_version 必须是正整数"
            );
        }
        TaskSnapshot current = tasks.require(taskId, context);
        if (current.stateVersion() != expectedVersion) {
            throw ToolRuntimeException.beforeCommit(
                    "task_state_version_conflict",
                    "任务状态已更新到版本 " + current.stateVersion()
                            + "；请重新读取后再提交"
            );
        }
        String phase = TaskToolSupport.phase(input);
        ArrayNode steps = TaskToolSupport.steps(objectMapper, input);
        ArrayNode blockers = TaskToolSupport.stringArray(
                objectMapper, input, "blockers", 0
        );
        ArrayNode evidenceRefs = TaskToolSupport.stringArray(
                objectMapper, input, "evidence_refs", 0
        );
        ArrayNode artifactRefs = TaskToolSupport.stringArray(
                objectMapper, input, "artifact_refs", 0
        );
        String currentFocus = input.has("current_focus")
                ? TaskToolSupport.text(
                        input,
                        "current_focus",
                        TaskToolSupport.MAX_ITEM_TEXT,
                        false
                )
                : current.currentFocus();
        ArrayNode pendingDecisions = input.has("pending_decisions")
                ? TaskToolSupport.stringArray(
                        objectMapper, input, "pending_decisions", 0
                )
                : current.pendingDecisions().deepCopy();
        ArrayNode nextActions = input.has("next_actions")
                ? TaskToolSupport.stringArray(
                        objectMapper, input, "next_actions", 0
                )
                : current.nextActions().deepCopy();
        String handoffNote = input.has("handoff_note")
                ? TaskToolSupport.text(
                        input,
                        "handoff_note",
                        TaskToolSupport.MAX_SUMMARY,
                        false
                )
                : current.handoffNote();
        String checkpointKind = TaskToolSupport.checkpointKind(input);
        String resumeSummary = TaskToolSupport.text(
                input,
                "resume_summary",
                TaskToolSupport.MAX_SUMMARY,
                false
        );
        TaskToolSupport.requireClosable(
                phase, steps, blockers, evidenceRefs, artifactRefs
        );
        TaskToolSupport.requireVisibleProgress(
                phase,
                currentFocus,
                blockers,
                pendingDecisions,
                nextActions
        );
        if ("completed".equals(phase)) {
            tasks.requireCompletionReferences(
                    context,
                    evidenceRefs,
                    artifactRefs
            );
        }
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("task_id", taskId);
        normalized.put("expected_state_version", expectedVersion);
        normalized.put("phase", phase);
        normalized.set("steps", steps);
        normalized.set("blockers", blockers);
        normalized.set("evidence_refs", evidenceRefs);
        normalized.set("artifact_refs", artifactRefs);
        normalized.put("current_focus", currentFocus);
        normalized.set("pending_decisions", pendingDecisions);
        normalized.set("next_actions", nextActions);
        normalized.put("handoff_note", handoffNote);
        normalized.put("checkpoint_kind", checkpointKind);
        normalized.put("resume_summary", resumeSummary);
        normalized.put(
                "summary",
                TaskToolSupport.text(
                        input,
                        "summary",
                        TaskToolSupport.MAX_SUMMARY,
                        true
                )
        );
        return new PreparedOperation(
                normalized,
                "把任务 " + taskId + " 的工作状态从版本 "
                        + expectedVersion + " 推进到 "
                        + (expectedVersion + 1)
                        + "；不修改任务目标、工作区或外部系统",
                List.of(new PreparedOperation.ResourceClaim(
                        "task_work_state",
                        taskId,
                        Integer.toString(expectedVersion)
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
        TaskSnapshot updated = tasks.update(
                context,
                input.path("task_id").asText(),
                input.path("expected_state_version").asInt(),
                input.path("phase").asText(),
                (ArrayNode) input.path("steps"),
                (ArrayNode) input.path("blockers"),
                (ArrayNode) input.path("evidence_refs"),
                (ArrayNode) input.path("artifact_refs"),
                input.path("summary").asText(),
                input.path("current_focus").asText(),
                (ArrayNode) input.path("pending_decisions"),
                (ArrayNode) input.path("next_actions"),
                input.path("handoff_note").asText(),
                input.path("checkpoint_kind").asText(),
                input.path("resume_summary").asText()
        );
        return ToolOutcome.succeeded(tasks.toJson(updated));
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
        int expected = operation.normalizedInput()
                .path("expected_state_version").asInt() + 1;
        if (current.stateVersion() != expected) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "任务状态提交后，head 没有指向预期版本"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "task_state_version",
                        current.taskId(),
                        "任务工作状态已推进到版本 " + expected
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = TaskToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("task_id")
                .put("type", "string")
                .put("description", "create/read_task_ledger 返回的任务 ID");
        properties.putObject("expected_state_version")
                .put("type", "integer")
                .put("minimum", 1)
                .put("description", "当前已读取的 stateVersion；过期版本会被拒绝");
        properties.putObject("phase")
                .put("type", "string")
                .put("description", "任务当前阶段")
                .putArray("enum")
                .add("active").add("blocked").add("paused")
                .add("completed").add("cancelled");
        properties.set("steps", TaskToolSupport.stepsSchema(objectMapper));
        properties.set(
                "blockers",
                TaskToolSupport.stringArraySchema(
                        objectMapper,
                        "当前阻塞项；不要放网页原文",
                        0
                )
        );
        properties.set(
                "evidence_refs",
                TaskToolSupport.stringArraySchema(
                        objectMapper,
                        "已确认 Evidence 的稳定引用",
                        0
                )
        );
        properties.set(
                "artifact_refs",
                TaskToolSupport.stringArraySchema(
                        objectMapper,
                        "已生成 Artifact 或工作区文件的稳定引用",
                        0
                )
        );
        properties.putObject("summary")
                .put("type", "string")
                .put("description", "给下一次决策看的有界状态摘要")
                .put("maxLength", TaskToolSupport.MAX_SUMMARY);
        properties.putObject("current_focus")
                .put("type", "string")
                .put("description", "可选；当前正在推进的唯一焦点，省略时保持原值")
                .put("maxLength", TaskToolSupport.MAX_ITEM_TEXT);
        properties.set(
                "pending_decisions",
                TaskToolSupport.stringArraySchema(
                        objectMapper,
                        "可选；需要用户、外部系统或后续验证解决的最小决定清单",
                        0
                )
        );
        properties.set(
                "next_actions",
                TaskToolSupport.stringArraySchema(
                        objectMapper,
                        "可选；恢复后可直接继续的动作；active 状态至少一项",
                        0
                )
        );
        properties.putObject("handoff_note")
                .put("type", "string")
                .put("description", "可选；交接时不能从步骤推出的短说明")
                .put("maxLength", TaskToolSupport.MAX_SUMMARY);
        properties.putObject("checkpoint_kind")
                .put("type", "string")
                .put("description", "可选稳定边界；终态、暂停和阻塞会自动建立检查点")
                .putArray("enum")
                .add("none").add("milestone").add("handoff");
        properties.putObject("resume_summary")
                .put("type", "string")
                .put("description", "建立检查点时给恢复者的一句摘要；省略时使用 summary")
                .put("maxLength", TaskToolSupport.MAX_SUMMARY);
        schema.putArray("required")
                .add("task_id").add("expected_state_version")
                .add("phase").add("steps").add("blockers")
                .add("evidence_refs").add("artifact_refs").add("summary");
        return schema;
    }
}
