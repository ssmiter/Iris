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
import com.iris.workspace.WorkspaceFileMutationService.CopyResult;
import com.iris.workspace.WorkspaceFileMutationService.TargetState;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.time.Instant;
import java.util.List;

/**
 * 在工作区内流式复制一个普通文件，不隐式覆盖目标。
 */
@Component
public class CopyFileTool implements Tool {

    private static final long MAX_COPY_BYTES = 64L * 1024 * 1024;

    private final ObjectMapper objectMapper;
    private final WorkspaceFileMutationService files;
    private final WorkspaceCheckpointService checkpoints;
    private final ToolManifest manifest;

    public CopyFileTool(
            ObjectMapper objectMapper,
            WorkspaceFileMutationService files,
            WorkspaceCheckpointService checkpoints
    ) {
        this.objectMapper = objectMapper;
        this.files = files;
        this.checkpoints = checkpoints;
        this.manifest = new ToolManifest(
                "iris.system.files.copy_file",
                "1",
                "copy_file",
                "在工作区内复制一个普通文件；需要保留原件或从模板创建副本时使用，目标必须不存在",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.WORKSPACE_WRITE,
                60,
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
        requireCopyShape(source, destination);
        if (source.sizeBytes() > MAX_COPY_BYTES) {
            throw new ToolRuntimeException(
                    "workspace_copy_too_large",
                    "源文件超过 64 MiB；请使用面向大产物的专用复制能力"
            );
        }
        checkpoints.requireCapturable(destination);
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("source_path", source.logicalPath());
        normalized.put("destination_path", destination.logicalPath());
        return new PreparedOperation(
                normalized,
                "将工作区文件 " + source.logicalPath()
                        + " 复制到 " + destination.logicalPath()
                        + "（" + source.sizeBytes()
                        + " 字节）；保留原件且不覆盖已有目标",
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
        requireCopyShape(source, destination);
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_commit",
                    "任务已停止，目标文件尚未创建"
            );
        }
        Checkpoint checkpoint = checkpoints.capture(
                operation.executionId(),
                "copy_destination",
                destination
        );
        CopyResult copied = files.copyFile(
                source,
                destination,
                MAX_COPY_BYTES,
                context::cancelled
        );
        checkpoints.markApplied(
                checkpoint.checkpointId(),
                copied.contentHash()
        );

        ObjectNode output = objectMapper.createObjectNode();
        output.put("sourcePath", source.logicalPath());
        output.put("destinationPath", destination.logicalPath());
        output.put("copiedBytes", copied.copiedBytes());
        output.put("contentHash", copied.contentHash());
        output.put("checkpointId", checkpoint.checkpointId());
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) throws IOException {
        TargetState destination = files.inspect(
                context.workspaceRoot(),
                operation.resources().get(1).logicalPath()
        );
        String expectedHash = outcome.output().path("contentHash").asText();
        if (!destination.exists()
                || !destination.version().equals(expectedHash)) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "复制操作已返回，但目标文件内容版本无法确认"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "workspace_file_version",
                        destination.logicalPath(),
                        "目标副本的内容版本与复制源快照一致"
                ),
                new VerificationResult.Evidence(
                        "workspace_checkpoint",
                        outcome.output().path("checkpointId").asText(),
                        "目标写前的不存在状态已保留，可撤销本次复制"
                )
        ));
    }

    private void requireCopyShape(
            TargetState source,
            TargetState destination
    ) {
        if (!source.exists()) {
            throw new ToolRuntimeException(
                    "workspace_path_not_found",
                    "要复制的工作区文件不存在：" + source.logicalPath()
            );
        }
        if (destination.exists()) {
            throw new ToolRuntimeException(
                    "workspace_copy_destination_exists",
                    "复制目标已经存在；Iris 不会隐式覆盖："
                            + destination.logicalPath()
            );
        }
        if (source.logicalPath().equals(destination.logicalPath())) {
            throw new ToolRuntimeException(
                    "workspace_copy_same_path",
                    "复制源路径与目标路径相同"
            );
        }
    }

    private JsonNode inputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("source_path")
                .put("type", "string")
                .put("description", "要复制的工作区内相对普通文件路径");
        properties.putObject("destination_path")
                .put("type", "string")
                .put("description", "不存在的工作区内相对目标路径；父目录必须存在");
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
                .put("description", "复制源的工作区逻辑路径");
        properties.putObject("destinationPath")
                .put("type", "string")
                .put("description", "新副本的工作区逻辑路径");
        properties.putObject("copiedBytes")
                .put("type", "integer")
                .put("description", "实际复制的字节数");
        properties.putObject("contentHash")
                .put("type", "string")
                .put("description", "复制期间确认的 SHA-256 内容版本");
        properties.putObject("checkpointId")
                .put("type", "string")
                .put("description", "目标写前状态的 Checkpoint ID");
        schema.putArray("required")
                .add("sourcePath")
                .add("destinationPath")
                .add("copiedBytes")
                .add("contentHash")
                .add("checkpointId");
        return schema;
    }
}
