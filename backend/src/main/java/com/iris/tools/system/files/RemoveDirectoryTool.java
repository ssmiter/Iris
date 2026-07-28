package com.iris.tools.system.files;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.PreparedOperation.ResourceClaim;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.VerificationResult;
import com.iris.workspace.WorkspaceCheckpointService;
import com.iris.workspace.WorkspaceCheckpointService.Checkpoint;
import com.iris.workspace.WorkspaceFileMutationService;
import com.iris.workspace.WorkspaceFileMutationService.TargetState;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.time.Instant;
import java.util.List;

/**
 * 删除一个空工作区目录，不提供隐式递归语义。
 */
@Component
public class RemoveDirectoryTool implements Tool {

    private final ObjectMapper objectMapper;
    private final WorkspaceFileMutationService files;
    private final WorkspaceCheckpointService checkpoints;
    private final ToolManifest manifest;

    public RemoveDirectoryTool(
            ObjectMapper objectMapper,
            WorkspaceFileMutationService files,
            WorkspaceCheckpointService checkpoints
    ) {
        this.objectMapper = objectMapper;
        this.files = files;
        this.checkpoints = checkpoints;
        this.manifest = new ToolManifest(
                "iris.system.files.remove_directory",
                "1",
                "remove_directory",
                "删除工作区内一个空目录；确认目录已无内容且不应递归删除时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.DESTRUCTIVE,
                ToolManifest.SideEffect.DESTRUCTIVE,
                20,
                6_000,
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
    public PreparedOperation prepare(JsonNode input, ToolContext context)
            throws IOException {
        TargetState target = files.inspectDirectory(
                context.workspaceRoot(),
                input.path("path").asText()
        );
        files.requireEmptyDirectory(target);
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("path", target.logicalPath());
        return new PreparedOperation(
                normalized,
                "将删除工作区空目录 " + target.logicalPath()
                        + "；不会递归删除，目录状态会保留在 Checkpoint",
                List.of(new ResourceClaim(
                        "workspace_directory",
                        target.logicalPath(),
                        target.version()
                )),
                Instant.now().plusSeconds(300)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) throws IOException {
        ResourceClaim resource = operation.resources().getFirst();
        TargetState target = files.inspectDirectory(
                context.workspaceRoot(),
                resource.logicalPath()
        );
        files.requireVersion(target, resource.expectedVersion());
        files.requireEmptyDirectory(target);
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_commit",
                    "任务已停止，目录尚未删除"
            );
        }
        Checkpoint checkpoint = checkpoints.capture(
                operation.executionId(),
                "delete_directory",
                target
        );
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_commit",
                    "任务已停止，目录尚未删除"
            );
        }
        files.deleteDirectory(target);
        checkpoints.markApplied(checkpoint.checkpointId(), "absent");

        ObjectNode output = objectMapper.createObjectNode();
        output.put("path", target.logicalPath());
        output.put("checkpointId", checkpoint.checkpointId());
        output.put("beforeState", "directory");
        output.put("afterState", "absent");
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) throws IOException {
        TargetState current = files.inspectDirectory(
                context.workspaceRoot(),
                operation.resources().getFirst().logicalPath()
        );
        if (current.exists()) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "删除已返回，但目标目录仍可见"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "workspace_directory_state",
                        current.logicalPath(),
                        "空目录已删除"
                ),
                new VerificationResult.Evidence(
                        "workspace_checkpoint",
                        outcome.output().path("checkpointId").asText(),
                        "删除前目录状态已保留"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("path")
                .put("type", "string")
                .put("description", "工作区内要删除的空目录相对路径；不能是工作区根");
        schema.putArray("required").add("path");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("path").put("type", "string")
                .put("description", "已删除的工作区逻辑目录");
        properties.putObject("checkpointId").put("type", "string")
                .put("description", "删除前目录状态对应的恢复检查点");
        properties.putObject("beforeState").put("type", "string")
                .put("description", "删除前目录状态摘要");
        properties.putObject("afterState").put("type", "string")
                .put("description", "删除后目录状态摘要");
        schema.putArray("required")
                .add("path").add("checkpointId")
                .add("beforeState").add("afterState");
        return schema;
    }
}
