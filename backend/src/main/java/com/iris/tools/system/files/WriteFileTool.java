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
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;

/**
 * 创建或整体替换一个 UTF-8 工作区文件。
 */
@Component
public class WriteFileTool implements Tool {

    private static final int MAX_CONTENT_CHARACTERS = 1_000_000;

    private final ObjectMapper objectMapper;
    private final WorkspaceFileMutationService files;
    private final WorkspaceCheckpointService checkpoints;
    private final ToolManifest manifest;

    public WriteFileTool(
            ObjectMapper objectMapper,
            WorkspaceFileMutationService files,
            WorkspaceCheckpointService checkpoints
    ) {
        this.objectMapper = objectMapper;
        this.files = files;
        this.checkpoints = checkpoints;
        this.manifest = new ToolManifest(
                "iris.system.files.write_file",
                "3",
                "write_file",
                "创建或整体替换工作区文本文件；已确定完整目标内容时使用，局部修改优先 apply_patch",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.WORKSPACE_WRITE,
                30,
                8_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT_WITH_KEY,
                ToolManifest.EvidencePolicy.REQUIRED,
                "create save overwrite new document"
        );
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context)
            throws IOException {
        String content = input.path("content").asText();
        if (content.length() > MAX_CONTENT_CHARACTERS) {
            throw new ToolRuntimeException(
                    "workspace_write_content_too_large",
                    "写入内容超过 100 万字符；请拆分文件或使用专用产物工具"
            );
        }
        TargetState target = files.inspect(
                context.workspaceRoot(),
                input.path("path").asText()
        );
        checkpoints.requireCapturable(target);
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("path", target.logicalPath());
        normalized.put("content", content);
        long newBytes = content.getBytes(StandardCharsets.UTF_8).length;
        String impact = target.exists()
                ? "将整体替换工作区文件 " + target.logicalPath()
                        + "（" + target.sizeBytes() + " → " + newBytes
                        + " 字节）；写入前保留 Checkpoint"
                : "将创建工作区文件 " + target.logicalPath()
                        + "（" + newBytes + " 字节）；写入前记录不存在状态";
        return new PreparedOperation(
                normalized,
                impact,
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
                    "任务已停止，文件尚未写入"
            );
        }
        Checkpoint checkpoint = checkpoints.capture(
                operation.executionId(),
                target.exists() ? "replace" : "create",
                target
        );
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_commit",
                    "任务已停止，文件尚未写入"
            );
        }
        String content = operation.normalizedInput().path("content").asText();
        files.writeUtf8(target, content);
        String afterHash = files.versionOf(target.physicalPath());
        checkpoints.markApplied(checkpoint.checkpointId(), afterHash);

        ObjectNode output = objectMapper.createObjectNode();
        output.put("path", target.logicalPath());
        output.put("changeKind", target.exists() ? "replaced" : "created");
        output.put("encoding", "UTF-8");
        output.put(
                "bytesWritten",
                content.getBytes(StandardCharsets.UTF_8).length
        );
        output.put("checkpointId", checkpoint.checkpointId());
        output.put("beforeHash", checkpoint.beforeHash());
        output.put("afterHash", afterHash);
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) throws IOException {
        ResourceClaim resource = operation.resources().getFirst();
        TargetState current = files.inspect(
                context.workspaceRoot(),
                resource.logicalPath()
        );
        String expectedHash = outcome.output().path("afterHash").asText();
        if (!current.exists() || !current.version().equals(expectedHash)) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "写入已返回，但目标文件版本无法确认"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "workspace_file_version",
                        current.logicalPath(),
                        "原子写入后版本 " + expectedHash.substring(0, 12)
                ),
                new VerificationResult.Evidence(
                        "workspace_checkpoint",
                        outcome.output().path("checkpointId").asText(),
                        "写前状态已保留，可由独立恢复动作使用"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("path").put("type", "string")
                .put("description", "工作区内相对文件路径；父目录必须已经存在");
        properties.putObject("content").put("type", "string")
                .put("description", "文件的完整 UTF-8 文本内容");
        schema.putArray("required").add("path").add("content");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("path").put("type", "string")
                .put("description", "完成写入的工作区逻辑路径");
        properties.putObject("changeKind").put("type", "string")
                .put("description", "created 或 replaced");
        properties.putObject("encoding").put("type", "string")
                .put("description", "实际写入编码");
        properties.putObject("bytesWritten").put("type", "integer")
                .put("description", "写入字节数");
        properties.putObject("checkpointId").put("type", "string")
                .put("description", "写前 Checkpoint ID");
        properties.putObject("beforeHash").put("type", "string")
                .put("description", "写前版本；新文件为 absent");
        properties.putObject("afterHash").put("type", "string")
                .put("description", "写后 SHA-256 版本");
        schema.putArray("required")
                .add("path").add("changeKind").add("encoding")
                .add("bytesWritten").add("checkpointId")
                .add("beforeHash").add("afterHash");
        return schema;
    }
}
