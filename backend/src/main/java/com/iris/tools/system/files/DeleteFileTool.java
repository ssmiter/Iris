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
 * 删除一个普通工作区文件；目录删除是另一种能力。
 */
@Component
public class DeleteFileTool implements Tool {

    private final ObjectMapper objectMapper;
    private final WorkspaceFileMutationService files;
    private final WorkspaceCheckpointService checkpoints;
    private final ToolManifest manifest;

    public DeleteFileTool(
            ObjectMapper objectMapper,
            WorkspaceFileMutationService files,
            WorkspaceCheckpointService checkpoints
    ) {
        this.objectMapper = objectMapper;
        this.files = files;
        this.checkpoints = checkpoints;
        this.manifest = new ToolManifest(
                "iris.system.files.delete_file",
                "2",
                "delete_file",
                "删除一个工作区普通文件并保留可恢复 Checkpoint；用户明确要求移除文件时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.DESTRUCTIVE,
                ToolManifest.SideEffect.DESTRUCTIVE,
                30,
                8_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT_WITH_KEY,
                ToolManifest.EvidencePolicy.REQUIRED
        );
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context)
            throws IOException {
        TargetState target = files.inspect(
                context.workspaceRoot(),
                input.path("path").asText()
        );
        if (!target.exists()) {
            throw new ToolRuntimeException(
                    "workspace_path_not_found",
                    files.describeMissingPath(
                            context.workspaceRoot(),
                            target.logicalPath()
                    )
            );
        }
        checkpoints.requireCapturable(target);
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("path", target.logicalPath());
        return new PreparedOperation(
                normalized,
                "将删除工作区文件 " + target.logicalPath()
                        + "（" + target.sizeBytes()
                        + " 字节）；删除前保存完整 Checkpoint",
                List.of(new ResourceClaim(
                        "workspace_file",
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
        TargetState target = files.inspect(
                context.workspaceRoot(),
                resource.logicalPath()
        );
        files.requireVersion(target, resource.expectedVersion());
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_commit",
                    "任务已停止，文件尚未删除"
            );
        }
        Checkpoint checkpoint = checkpoints.capture(
                operation.executionId(),
                "delete",
                target
        );
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_commit",
                    "任务已停止，文件尚未删除"
            );
        }
        files.deleteFile(target);
        checkpoints.markApplied(checkpoint.checkpointId(), "absent");

        ObjectNode output = objectMapper.createObjectNode();
        output.put("path", target.logicalPath());
        output.put("deletedBytes", target.sizeBytes());
        output.put("checkpointId", checkpoint.checkpointId());
        output.put("beforeHash", checkpoint.beforeHash());
        output.put("afterHash", "absent");
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) throws IOException {
        TargetState current = files.inspect(
                context.workspaceRoot(),
                operation.resources().getFirst().logicalPath()
        );
        if (current.exists()) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "删除操作已返回，但目标文件仍然存在"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "workspace_file_absent",
                        current.logicalPath(),
                        "目标普通文件已不存在"
                ),
                new VerificationResult.Evidence(
                        "workspace_checkpoint",
                        outcome.output().path("checkpointId").asText(),
                        "删除前完整内容已保留，可由 restore_checkpoint 恢复"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("path").put("type", "string")
                .put("description", "要删除的工作区内相对文件路径");
        schema.putArray("required").add("path");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("path").put("type", "string")
                .put("description", "已删除的工作区逻辑路径");
        properties.putObject("deletedBytes").put("type", "integer")
                .put("description", "删除前文件字节数");
        properties.putObject("checkpointId").put("type", "string")
                .put("description", "删除前完整 Checkpoint ID");
        properties.putObject("beforeHash").put("type", "string")
                .put("description", "删除前 SHA-256");
        properties.putObject("afterHash").put("type", "string")
                .put("description", "删除后固定为 absent");
        schema.putArray("required")
                .add("path").add("deletedBytes").add("checkpointId")
                .add("beforeHash").add("afterHash");
        return schema;
    }
}
