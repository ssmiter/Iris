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
import com.iris.workspace.WorkspaceFileService.TextDocument;
import com.iris.workspace.WorkspaceFileVisionService;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;

/**
 * 在文本文件末尾追加内容；不暗中补换行。
 */
@Component
public class AppendFileTool implements Tool {

    private static final int MAX_APPEND_CHARACTERS = 200_000;

    private final ObjectMapper objectMapper;
    private final WorkspaceFileMutationService files;
    private final WorkspaceCheckpointService checkpoints;
    private final WorkspaceFileVisionService vision;
    private final ToolManifest manifest;

    public AppendFileTool(
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
                "iris.system.files.append_file",
                "1",
                "append_file",
                "向工作区文本文件末尾追加内容；新增日志、记录或小段文本且不应回传整份旧文件时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.WORKSPACE_WRITE,
                30,
                8_000,
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
        String requestedContent = input.path("content").asText();
        if (requestedContent.isEmpty()) {
            throw new ToolRuntimeException(
                    "workspace_append_empty",
                    "追加内容不能为空"
            );
        }
        if (requestedContent.length() > MAX_APPEND_CHARACTERS) {
            throw new ToolRuntimeException(
                    "workspace_append_too_large",
                    "单次追加不能超过 20 万字符；请拆分内容或使用专用产物工具"
            );
        }

        TargetState target = files.inspect(
                context.workspaceRoot(),
                input.path("path").asText()
        );
        checkpoints.requireCapturable(target);
        TextDocument document = target.exists()
                ? files.readForEdit(
                        context.workspaceRoot(),
                        target.logicalPath(),
                        context::cancelled
                )
                : null;
        String content = document == null
                ? requestedContent
                : adaptLineEndings(
                        requestedContent,
                        lineEnding(document.content())
                );
        Charset charset = document == null
                ? StandardCharsets.UTF_8
                : document.charset();
        int appendedBytes = content.getBytes(charset).length;

        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("path", target.logicalPath());
        normalized.put("content", content);
        String impact = target.exists()
                ? "将在工作区文本文件 " + target.logicalPath()
                        + " 末尾追加 " + appendedBytes
                        + " 字节；不自动补换行，写入前保留 Checkpoint"
                : "将创建工作区文本文件 " + target.logicalPath()
                        + " 并写入 " + appendedBytes
                        + " 字节；父目录必须已经存在";
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
        // 读改写状态机（docs/42 §4-8）：已存在文件必须在本会话读过且未变
        vision.requireFreshVision(
                context.conversationId(),
                target.logicalPath(),
                target.exists(),
                target.version()
        );
        TextDocument document = target.exists()
                ? files.readForEdit(
                        context.workspaceRoot(),
                        target.logicalPath(),
                        context::cancelled
                )
                : null;
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_commit",
                    "任务已停止，内容尚未追加"
            );
        }

        Checkpoint checkpoint = checkpoints.capture(
                operation.executionId(),
                target.exists() ? "append" : "create",
                target
        );
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_commit",
                    "任务已停止，内容尚未追加"
            );
        }

        String appended = operation.normalizedInput()
                .path("content").asText();
        String encoding;
        int appendedBytes;
        if (document == null) {
            files.writeUtf8(target, appended);
            encoding = StandardCharsets.UTF_8.name();
            appendedBytes = appended.getBytes(StandardCharsets.UTF_8).length;
        } else {
            files.writeDocument(
                    target,
                    document,
                    document.content() + appended
            );
            encoding = document.encoding();
            appendedBytes = appended.getBytes(document.charset()).length;
        }
        String afterHash = files.versionOf(target.physicalPath());
        checkpoints.markApplied(checkpoint.checkpointId(), afterHash);
        vision.recordWritten(
                context.conversationId(),
                target.logicalPath(),
                afterHash
        );

        ObjectNode output = objectMapper.createObjectNode();
        output.put("path", target.logicalPath());
        output.put("changeKind", target.exists() ? "appended" : "created");
        output.put("encoding", encoding);
        output.put("appendedBytes", appendedBytes);
        output.put("sizeBytes", java.nio.file.Files.size(target.physicalPath()));
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
        TargetState current = files.inspect(
                context.workspaceRoot(),
                operation.resources().getFirst().logicalPath()
        );
        String expectedHash = outcome.output().path("afterHash").asText();
        if (!current.exists() || !current.version().equals(expectedHash)) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "追加已返回，但目标文件内容版本无法确认"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "workspace_file_version",
                        current.logicalPath(),
                        "追加后版本 " + expectedHash.substring(0, 12)
                ),
                new VerificationResult.Evidence(
                        "workspace_checkpoint",
                        outcome.output().path("checkpointId").asText(),
                        "追加前内容已保留"
                )
        ));
    }

    private String lineEnding(String content) {
        if (content.contains("\r\n")) {
            return "\r\n";
        }
        if (content.indexOf('\r') >= 0) {
            return "\r";
        }
        return "\n";
    }

    private String adaptLineEndings(String value, String lineEnding) {
        return value.replace("\r\n", "\n")
                .replace('\r', '\n')
                .replace("\n", lineEnding);
    }

    private JsonNode inputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("path")
                .put("type", "string")
                .put("description", "工作区内相对文本文件路径；父目录必须已存在");
        properties.putObject("content")
                .put("type", "string")
                .put("description", "要原样追加的文本；不会隐式在前后补换行");
        schema.putArray("required").add("path").add("content");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("path").put("type", "string")
                .put("description", "已追加内容的工作区逻辑文件");
        properties.putObject("changeKind").put("type", "string")
                .put("description", "appended 或 created");
        properties.putObject("encoding").put("type", "string")
                .put("description", "写入时保留的文本编码");
        properties.putObject("appendedBytes").put("type", "integer")
                .put("description", "本次实际追加的字节数");
        properties.putObject("sizeBytes").put("type", "integer")
                .put("description", "追加后文件总字节数");
        properties.putObject("checkpointId").put("type", "string")
                .put("description", "追加前文件状态对应的恢复检查点");
        properties.putObject("beforeHash").put("type", "string")
                .put("description", "追加前文件内容哈希");
        properties.putObject("afterHash").put("type", "string")
                .put("description", "追加后文件内容哈希");
        schema.putArray("required")
                .add("path").add("changeKind").add("encoding")
                .add("appendedBytes").add("sizeBytes")
                .add("checkpointId").add("beforeHash").add("afterHash");
        return schema;
    }
}
