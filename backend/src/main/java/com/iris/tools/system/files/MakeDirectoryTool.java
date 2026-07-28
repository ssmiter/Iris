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
 * 创建一个明确的工作区目录层级，不递归产生隐藏写入。
 */
@Component
public class MakeDirectoryTool implements Tool {

    private final ObjectMapper objectMapper;
    private final WorkspaceFileMutationService files;
    private final WorkspaceCheckpointService checkpoints;
    private final ToolManifest manifest;

    public MakeDirectoryTool(
            ObjectMapper objectMapper,
            WorkspaceFileMutationService files,
            WorkspaceCheckpointService checkpoints
    ) {
        this.objectMapper = objectMapper;
        this.files = files;
        this.checkpoints = checkpoints;
        this.manifest = new ToolManifest(
                "iris.system.files.make_directory",
                "1",
                "make_directory",
                "在已有父目录下创建一个工作区目录；需要为文件建立明确目录时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.WORKSPACE_WRITE,
                20,
                4_000,
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
        TargetState target = files.inspectDirectory(
                context.workspaceRoot(),
                input.path("path").asText()
        );
        if (target.exists()) {
            throw new ToolRuntimeException(
                    "workspace_directory_exists",
                    "工作区目录已经存在：" + target.logicalPath()
            );
        }
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("path", target.logicalPath());
        return new PreparedOperation(
                normalized,
                "将在已有父目录下创建工作区目录 "
                        + target.logicalPath()
                        + "；只创建这一层，写前记录不存在状态",
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
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_commit",
                    "任务已停止，目录尚未创建"
            );
        }
        Checkpoint checkpoint = checkpoints.capture(
                operation.executionId(),
                "create_directory",
                target
        );
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_commit",
                    "任务已停止，目录尚未创建"
            );
        }
        files.createDirectory(target);
        checkpoints.markApplied(
                checkpoint.checkpointId(),
                "directory"
        );

        ObjectNode output = objectMapper.createObjectNode();
        output.put("path", target.logicalPath());
        output.put("checkpointId", checkpoint.checkpointId());
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
        if (!current.exists()) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "目录创建已返回，但目标目录不存在"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "workspace_directory",
                        current.logicalPath(),
                        "工作区目录已创建"
                ),
                new VerificationResult.Evidence(
                        "workspace_checkpoint",
                        outcome.output().path("checkpointId").asText(),
                        "目录创建前的不存在状态已保留"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("path")
                .put("type", "string")
                .put("description", "要创建的工作区内相对目录；父目录必须已经存在");
        schema.putArray("required").add("path");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("path")
                .put("type", "string")
                .put("description", "已创建的工作区逻辑目录");
        properties.putObject("checkpointId")
                .put("type", "string")
                .put("description", "目录创建前状态的 Checkpoint ID");
        schema.putArray("required")
                .add("path")
                .add("checkpointId");
        return schema;
    }
}
