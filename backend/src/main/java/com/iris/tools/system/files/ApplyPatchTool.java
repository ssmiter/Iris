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
import java.time.Instant;
import java.util.List;

/**
 * 对工作区文本文件执行确定性的精确替换。
 */
@Component
public class ApplyPatchTool implements Tool {

    private static final int MAX_PATCH_CHARACTERS = 200_000;

    private final ObjectMapper objectMapper;
    private final WorkspaceFileMutationService files;
    private final WorkspaceCheckpointService checkpoints;
    private final WorkspaceFileVisionService vision;
    private final ToolManifest manifest;

    public ApplyPatchTool(
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
                "iris.system.files.apply_patch",
                "2",
                "apply_patch",
                "精确替换工作区文本文件中的一段内容；只需局部修改且已读到准确原文时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.WORKSPACE_WRITE,
                30,
                8_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT_WITH_KEY,
                ToolManifest.EvidencePolicy.REQUIRED,
                "edit modify replace exact text change",
                "old_text 必须与读到的原文逐字一致（含缩进与换行）；"
                        + "多处匹配时加大上下文或设 replace_all=true。"
                        + "补丁总量上限 200000 字符；整文件重写改用 write_file。"
                        + "改动前先 read_file 取得准确原文。"
        );
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context)
            throws IOException {
        String rawOld = input.path("old_text").asText();
        String rawNew = input.path("new_text").asText();
        requirePatchSize(rawOld, rawNew);
        if (rawOld.isEmpty()) {
            throw new ToolRuntimeException(
                    "workspace_patch_empty_match",
                    "old_text 不能为空；插入操作应提供稳定的相邻原文"
            );
        }
        TextDocument document = files.readForEdit(
                context.workspaceRoot(),
                input.path("path").asText(),
                context::cancelled
        );
        TargetState target = files.inspect(
                context.workspaceRoot(),
                document.path()
        );
        checkpoints.requireCapturable(target);
        AdaptedPatch patch = adaptPatch(document.content(), rawOld, rawNew);
        boolean replaceAll = input.path("replace_all").asBoolean(false);
        int matches = countOccurrences(document.content(), patch.oldText());
        requireMatchCount(matches, replaceAll, document.path());

        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("path", document.path());
        normalized.put("old_text", patch.oldText());
        normalized.put("new_text", patch.newText());
        normalized.put("replace_all", replaceAll);
        String impact = "将在工作区文件 " + document.path() + " 中精确替换 "
                + (replaceAll ? matches : 1) + " 处文本（每处 "
                + patch.oldText().length() + " → "
                + patch.newText().length()
                + " 字符）；写入前保留 Checkpoint";
        return new PreparedOperation(
                normalized,
                impact,
                List.of(new ResourceClaim(
                        "workspace_file",
                        document.path(),
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
        // 读改写状态机（docs/42 §4-8）：必须在本会话读过且文件未变
        vision.requireFreshVision(
                context.conversationId(),
                target.logicalPath(),
                target.exists(),
                target.version()
        );
        TextDocument document = files.readForEdit(
                context.workspaceRoot(),
                resource.logicalPath(),
                context::cancelled
        );
        JsonNode input = operation.normalizedInput();
        String oldText = input.path("old_text").asText();
        String newText = input.path("new_text").asText();
        boolean replaceAll = input.path("replace_all").asBoolean();
        int matches = countOccurrences(document.content(), oldText);
        requireMatchCount(matches, replaceAll, document.path());
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_commit",
                    "任务已停止，文件尚未修改"
            );
        }

        Checkpoint checkpoint = checkpoints.capture(
                operation.executionId(),
                "patch",
                target
        );
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_commit",
                    "任务已停止，文件尚未修改"
            );
        }
        String changed = replaceAll
                ? document.content().replace(oldText, newText)
                : replaceFirst(document.content(), oldText, newText);
        files.writeDocument(target, document, changed);
        String afterHash = files.versionOf(target.physicalPath());
        checkpoints.markApplied(checkpoint.checkpointId(), afterHash);
        vision.recordWritten(
                context.conversationId(),
                target.logicalPath(),
                afterHash
        );

        ObjectNode output = objectMapper.createObjectNode();
        output.put("path", target.logicalPath());
        output.put("replacements", replaceAll ? matches : 1);
        output.put("encoding", document.encoding());
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
                    "替换已返回，但目标文件版本无法确认"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "workspace_file_version",
                        current.logicalPath(),
                        "精确替换后版本 " + expectedHash.substring(0, 12)
                ),
                new VerificationResult.Evidence(
                        "workspace_checkpoint",
                        outcome.output().path("checkpointId").asText(),
                        "替换前内容已保留"
                )
        ));
    }

    private AdaptedPatch adaptPatch(
            String content,
            String oldText,
            String newText
    ) {
        if (content.contains(oldText)) {
            return new AdaptedPatch(
                    oldText,
                    adaptLineEndings(newText, lineEnding(content))
            );
        }
        String ending = lineEnding(content);
        return new AdaptedPatch(
                adaptLineEndings(oldText, ending),
                adaptLineEndings(newText, ending)
        );
    }

    private String lineEnding(String content) {
        return content.contains("\r\n") ? "\r\n" : "\n";
    }

    private String adaptLineEndings(String value, String lineEnding) {
        return value.replace("\r\n", "\n")
                .replace('\r', '\n')
                .replace("\n", lineEnding);
    }

    private int countOccurrences(String content, String needle) {
        int count = 0;
        int from = 0;
        while ((from = content.indexOf(needle, from)) >= 0) {
            count++;
            from += needle.length();
        }
        return count;
    }

    private void requireMatchCount(
            int matches,
            boolean replaceAll,
            String path
    ) {
        if (matches == 0) {
            throw new ToolRuntimeException(
                    "workspace_patch_text_not_found",
                    "old_text 在 " + path
                            + " 中没有匹配。常见原因是文件内容已被改动，"
                            + "或缩进、空白与原文不一致；请先用 read_file "
                            + "重读目标区段，再按最新原文重试"
            );
        }
        if (!replaceAll && matches > 1) {
            throw new ToolRuntimeException(
                    "workspace_patch_not_unique",
                    "old_text 在 " + path + " 中出现 " + matches
                            + " 次，无法确定改哪一处；请在 old_text 里带上"
                            + "更多相邻上下文行使它唯一，或确实要全部替换时"
                            + "设 replace_all=true"
            );
        }
    }

    private String replaceFirst(
            String content,
            String oldText,
            String newText
    ) {
        int index = content.indexOf(oldText);
        return content.substring(0, index)
                + newText
                + content.substring(index + oldText.length());
    }

    private void requirePatchSize(String oldText, String newText) {
        if (oldText.length() > MAX_PATCH_CHARACTERS
                || newText.length() > MAX_PATCH_CHARACTERS) {
            throw new ToolRuntimeException(
                    "workspace_patch_too_large",
                    "单段替换内容不能超过 20 万字符；整体重写请用 write_file"
            );
        }
    }

    private JsonNode inputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("path").put("type", "string")
                .put("description", "工作区内相对文件路径");
        properties.putObject("old_text").put("type", "string")
                .put("description", "从 read_file 得到的精确原文，不含 N→ 行号前缀");
        properties.putObject("new_text").put("type", "string")
                .put("description", "替换后的文本");
        properties.putObject("replace_all").put("type", "boolean")
                .put("description", "是否替换全部匹配；默认 false，要求唯一匹配");
        schema.putArray("required")
                .add("path").add("old_text").add("new_text");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("path").put("type", "string")
                .put("description", "完成替换的工作区逻辑路径");
        properties.putObject("replacements").put("type", "integer")
                .put("description", "实际替换次数");
        properties.putObject("encoding").put("type", "string")
                .put("description", "保持的原文件编码");
        properties.putObject("checkpointId").put("type", "string")
                .put("description", "写前 Checkpoint ID");
        properties.putObject("beforeHash").put("type", "string")
                .put("description", "替换前 SHA-256");
        properties.putObject("afterHash").put("type", "string")
                .put("description", "替换后 SHA-256");
        schema.putArray("required")
                .add("path").add("replacements").add("encoding")
                .add("checkpointId").add("beforeHash").add("afterHash");
        return schema;
    }

    private record AdaptedPatch(String oldText, String newText) {
    }
}
