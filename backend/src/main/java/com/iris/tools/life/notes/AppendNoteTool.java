package com.iris.tools.life.notes;

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
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.time.Instant;
import java.util.List;

/**
 * 向工作区文本笔记追加一条记录。
 */
@Component
public class AppendNoteTool implements Tool {

    private static final int MAX_LINE_CHARACTERS = 20_000;

    private final ObjectMapper objectMapper;
    private final WorkspaceFileMutationService files;
    private final WorkspaceCheckpointService checkpoints;
    private final ToolManifest manifest;

    public AppendNoteTool(
            ObjectMapper objectMapper,
            WorkspaceFileMutationService files,
            WorkspaceCheckpointService checkpoints
    ) {
        this.objectMapper = objectMapper;
        this.files = files;
        this.checkpoints = checkpoints;
        this.manifest = new ToolManifest(
                "iris.life.notes.append_note",
                "3",
                "append_note",
                "向工作区文本笔记追加一条记录；记录待办、想法或持续日志时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.WORKSPACE_WRITE,
                30,
                6_000,
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
        String line = requireLine(input.path("line").asText());
        TargetState target = files.inspect(
                context.workspaceRoot(),
                input.path("path").asText()
        );
        checkpoints.requireCapturable(target);
        if (target.exists()) {
            // 在审批前确认它确实是受支持的文本，而不是到提交阶段才猜编码。
            files.readForEdit(
                    context.workspaceRoot(),
                    target.logicalPath(),
                    context::cancelled
            );
        }
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("path", target.logicalPath());
        normalized.put("line", line);
        String impact = target.exists()
                ? "将向工作区笔记 " + target.logicalPath()
                        + " 末尾追加一条 " + line.length()
                        + " 字符记录；写入前保留完整 Checkpoint"
                : "将创建工作区笔记 " + target.logicalPath()
                        + " 并写入一条 " + line.length()
                        + " 字符记录；父目录必须已经存在";
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
        String line = operation.normalizedInput().path("line").asText();
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
                    "任务已停止，笔记尚未写入"
            );
        }
        Checkpoint checkpoint = checkpoints.capture(
                operation.executionId(),
                target.exists() ? "append_note" : "create_note",
                target
        );
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_commit",
                    "任务已停止，笔记尚未写入"
            );
        }

        if (document == null) {
            files.writeUtf8(target, line + "\n");
        } else {
            files.writeDocument(
                    target,
                    document,
                    appendLine(document.content(), line)
            );
        }
        TargetState after = files.inspect(
                context.workspaceRoot(),
                target.logicalPath()
        );
        checkpoints.markApplied(
                checkpoint.checkpointId(),
                after.version()
        );

        ObjectNode output = objectMapper.createObjectNode();
        output.put("path", target.logicalPath());
        output.put("bytesAppended", after.sizeBytes() - target.sizeBytes());
        output.put(
                "encoding",
                document == null ? "UTF-8" : document.encoding()
        );
        output.put("checkpointId", checkpoint.checkpointId());
        output.put("beforeHash", target.version());
        output.put("afterHash", after.version());
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
                    "追加操作已返回，但笔记文件版本无法确认"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "workspace_file_version",
                        current.logicalPath(),
                        "笔记追加后的内容版本为 "
                                + expectedHash.substring(0, 12)
                ),
                new VerificationResult.Evidence(
                        "workspace_checkpoint",
                        outcome.output().path("checkpointId").asText(),
                        "追加前的完整笔记内容已保留"
                )
        ));
    }

    private String requireLine(String value) {
        String line = value == null ? "" : value;
        if (line.isBlank()) {
            throw new ToolRuntimeException(
                    "note_line_empty",
                    "笔记内容不能为空"
            );
        }
        if (line.indexOf('\n') >= 0 || line.indexOf('\r') >= 0) {
            throw new ToolRuntimeException(
                    "note_line_has_line_break",
                    "append_note 每次只追加一条单行记录；多段内容请使用 write_file"
            );
        }
        if (line.length() > MAX_LINE_CHARACTERS) {
            throw new ToolRuntimeException(
                    "note_line_too_long",
                    "单条笔记不能超过 2 万字符"
            );
        }
        return line;
    }

    private String appendLine(String content, String line) {
        String ending = content.contains("\r\n") ? "\r\n" : "\n";
        if (content.isEmpty()) {
            return line + ending;
        }
        if (content.endsWith("\n") || content.endsWith("\r")) {
            return content + line + ending;
        }
        return content + ending + line + ending;
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("path")
                .put("type", "string")
                .put("description", "工作区内相对文本笔记路径；父目录必须已经存在");
        properties.putObject("line")
                .put("type", "string")
                .put("description", "要追加的一条单行记录，不包含换行符");
        schema.putArray("required").add("path").add("line");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("path")
                .put("type", "string")
                .put("description", "完成追加的工作区逻辑路径");
        properties.putObject("bytesAppended")
                .put("type", "integer")
                .put("description", "文件大小实际增加的字节数");
        properties.putObject("encoding")
                .put("type", "string")
                .put("description", "保持或新建时使用的文本编码");
        properties.putObject("checkpointId")
                .put("type", "string")
                .put("description", "追加前完整状态的 Checkpoint ID");
        properties.putObject("beforeHash")
                .put("type", "string")
                .put("description", "追加前内容版本或 absent");
        properties.putObject("afterHash")
                .put("type", "string")
                .put("description", "追加后 SHA-256 内容版本");
        schema.putArray("required")
                .add("path")
                .add("bytesAppended")
                .add("encoding")
                .add("checkpointId")
                .add("beforeHash")
                .add("afterHash");
        return schema;
    }
}
