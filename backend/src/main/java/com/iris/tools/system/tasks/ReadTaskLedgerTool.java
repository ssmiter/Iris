package com.iris.tools.system.tasks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
public class ReadTaskLedgerTool implements Tool {
    private final ObjectMapper objectMapper;
    private final TaskLedgerService tasks;
    private final ToolManifest manifest;

    public ReadTaskLedgerTool(
            ObjectMapper objectMapper,
            TaskLedgerService tasks
    ) {
        this.objectMapper = objectMapper;
        this.tasks = tasks;
        this.manifest = new ToolManifest(
                "iris.system.tasks.read_task_ledger",
                "1",
                "read_task_ledger",
                "读取当前对话分支中一个任务的稳定定义和最新工作状态；省略 task_id 时读取最近更新的任务",
                inputSchema(),
                CreateTaskLedgerTool.taskOutputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                5,
                12_000,
                ToolManifest.IdempotencySemantics.NON_IDEMPOTENT,
                ToolManifest.EvidencePolicy.SUMMARY,
                ToolManifest.ContextRetention.PINNED,
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
        String taskId = input.path("task_id").asText("").trim();
        ObjectNode normalized = objectMapper.createObjectNode();
        if (!taskId.isBlank()) {
            normalized.put("task_id", taskId);
        }
        return new PreparedOperation(
                normalized,
                taskId.isBlank()
                        ? "读取当前分支最近更新的任务状态，不改变任何状态"
                        : "读取任务 " + taskId + "，不改变任何状态",
                List.of(),
                Instant.now().plusSeconds(30)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        String taskId = operation.normalizedInput()
                .path("task_id").asText("");
        TaskSnapshot snapshot = taskId.isBlank()
                ? tasks.latest(context)
                : tasks.require(taskId, context);
        return ToolOutcome.succeeded(tasks.toJson(snapshot));
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "task_state_version",
                        outcome.output().path("taskId").asText(),
                        "读取到工作状态版本 "
                                + outcome.output().path("stateVersion").asInt()
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = TaskToolSupport.objectSchema(objectMapper);
        ((ObjectNode) schema.path("properties"))
                .putObject("task_id")
                .put("type", "string")
                .put("description", "可选任务 ID；省略时读取当前分支最近更新的任务");
        return schema;
    }
}
