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
import com.iris.workspace.WorkspaceCheckpointService.AppliedResource;
import com.iris.workspace.WorkspaceCheckpointService.CheckpointSet;
import com.iris.workspace.WorkspaceCheckpointService.CheckpointTarget;
import com.iris.workspace.WorkspaceFileMutationService;
import com.iris.workspace.WorkspaceFileMutationService.TargetState;
import com.iris.workspace.WorkspaceFileVisionService;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;

/**
 * 在工作区内原子移动或重命名一个普通文件，不隐式覆盖目标。
 */
@Component
public class MoveFileTool implements Tool {

    private final ObjectMapper objectMapper;
    private final WorkspaceFileMutationService files;
    private final WorkspaceCheckpointService checkpoints;
    private final WorkspaceFileVisionService vision;
    private final ToolManifest manifest;

    public MoveFileTool(
            ObjectMapper objectMapper,
            WorkspaceFileMutationService files,
            WorkspaceCheckpointService checkpoints,
            WorkspaceFileVisionService vision
    ) {
        this.objectMapper = objectMapper;
        this.files = files;
        this.checkpoints = checkpoints;
        this.vision = vision;
        this.manifest = new ToolManifest(
                "iris.system.files.move_file",
                "1",
                "move_file",
                "在工作区内移动或重命名一个普通文件；目标必须不存在，避免隐式覆盖",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.WORKSPACE_WRITE,
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
        TargetState source = files.inspect(
                context.workspaceRoot(),
                input.path("source_path").asText()
        );
        TargetState destination = files.inspect(
                context.workspaceRoot(),
                input.path("destination_path").asText()
        );
        requireMoveShape(context.workspaceRoot(), source, destination);
        checkpoints.requireCapturable(source);
        checkpoints.requireCapturable(destination);

        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("source_path", source.logicalPath());
        normalized.put("destination_path", destination.logicalPath());
        return new PreparedOperation(
                normalized,
                "将工作区文件 " + source.logicalPath()
                        + " 移动到 " + destination.logicalPath()
                        + "（" + source.sizeBytes()
                        + " 字节）；目标不存在，移动前保存双资源 Checkpoint",
                List.of(
                        new ResourceClaim(
                                "workspace_file",
                                source.logicalPath(),
                                source.version()
                        ),
                        new ResourceClaim(
                                "workspace_file",
                                destination.logicalPath(),
                                destination.version()
                        )
                ),
                Instant.now().plusSeconds(300)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) throws IOException {
        ResourceClaim sourceClaim = operation.resources().get(0);
        ResourceClaim destinationClaim = operation.resources().get(1);
        TargetState source = files.inspect(
                context.workspaceRoot(),
                sourceClaim.logicalPath()
        );
        TargetState destination = files.inspect(
                context.workspaceRoot(),
                destinationClaim.logicalPath()
        );
        files.requireVersion(source, sourceClaim.expectedVersion());
        files.requireVersion(destination, destinationClaim.expectedVersion());
        requireMoveShape(context.workspaceRoot(), source, destination);
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_commit",
                    "任务已停止，文件尚未移动"
            );
        }

        CheckpointSet checkpoint = checkpoints.capture(
                operation.executionId(),
                List.of(
                        new CheckpointTarget("move_source", source),
                        new CheckpointTarget("move_destination", destination)
                )
        );
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_commit",
                    "任务已停止，文件尚未移动"
            );
        }
        files.moveFile(source, destination);
        String destinationHash = files.versionOf(
                destination.physicalPath()
        );
        checkpoints.markApplied(
                checkpoint.checkpointId(),
                List.of(
                        new AppliedResource(source.logicalPath(), "absent"),
                        new AppliedResource(
                                destination.logicalPath(),
                                destinationHash
                        )
                )
        );
        vision.recordMoved(
                context.conversationId(),
                source.logicalPath(),
                destination.logicalPath(),
                destinationHash
        );

        ObjectNode output = objectMapper.createObjectNode();
        output.put("sourcePath", source.logicalPath());
        output.put("destinationPath", destination.logicalPath());
        output.put("movedBytes", source.sizeBytes());
        output.put("contentHash", destinationHash);
        output.put("checkpointId", checkpoint.checkpointId());
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) throws IOException {
        TargetState source = files.inspect(
                context.workspaceRoot(),
                operation.resources().get(0).logicalPath()
        );
        TargetState destination = files.inspect(
                context.workspaceRoot(),
                operation.resources().get(1).logicalPath()
        );
        String expectedHash = outcome.output().path("contentHash").asText();
        if (source.exists()
                || !destination.exists()
                || !destination.version().equals(expectedHash)) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "移动操作已返回，但源与目标的最终状态无法完整确认"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "workspace_file_moved",
                        source.logicalPath() + " → "
                                + destination.logicalPath(),
                        "源文件已不存在，目标文件内容版本已确认"
                ),
                new VerificationResult.Evidence(
                        "workspace_checkpoint",
                        outcome.output().path("checkpointId").asText(),
                        "移动前的源与目标状态已作为一个整体保留"
                )
        ));
    }

    private void requireMoveShape(
            Path workspaceRoot,
            TargetState source,
            TargetState destination
    ) throws IOException {
        if (!source.exists()) {
            throw new ToolRuntimeException(
                    "workspace_path_not_found",
                    files.describeMissingPath(
                            workspaceRoot,
                            source.logicalPath()
                    )
            );
        }
        if (destination.exists()) {
            throw new ToolRuntimeException(
                    "workspace_move_destination_exists",
                    "移动目标已经存在；Iris 不会隐式覆盖："
                            + destination.logicalPath()
            );
        }
        if (source.logicalPath().equals(destination.logicalPath())) {
            throw new ToolRuntimeException(
                    "workspace_move_same_path",
                    "移动源路径与目标路径相同"
            );
        }
    }

    private JsonNode inputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("source_path")
                .put("type", "string")
                .put("description", "要移动的工作区内相对普通文件路径");
        properties.putObject("destination_path")
                .put("type", "string")
                .put("description", "不存在的工作区内相对目标文件路径；父目录必须存在");
        schema.putArray("required")
                .add("source_path")
                .add("destination_path");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("sourcePath")
                .put("type", "string")
                .put("description", "移动前的工作区逻辑路径");
        properties.putObject("destinationPath")
                .put("type", "string")
                .put("description", "移动后的工作区逻辑路径");
        properties.putObject("movedBytes")
                .put("type", "integer")
                .put("description", "移动的文件字节数");
        properties.putObject("contentHash")
                .put("type", "string")
                .put("description", "目标文件确认后的 SHA-256 内容版本");
        properties.putObject("checkpointId")
                .put("type", "string")
                .put("description", "包含源与目标写前状态的 Checkpoint ID");
        schema.putArray("required")
                .add("sourcePath")
                .add("destinationPath")
                .add("movedBytes")
                .add("contentHash")
                .add("checkpointId");
        return schema;
    }
}
