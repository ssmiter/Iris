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
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;

/**
 * 向工作区笔记追加一行。package 目录自动形成 /life/notes/append_note。
 */
@Component
public class AppendNoteTool implements Tool {
    private final ObjectMapper objectMapper;
    private final ToolManifest manifest;

    public AppendNoteTool(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        this.manifest = new ToolManifest(
                "iris.life.notes.append_note",
                "1",
                "append_note",
                "向工作区笔记文件追加一行；记录待办、想法或持续日志时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.WORKSPACE_WRITE,
                30,
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
        String logicalPath = normalizeLogicalPath(input.path("path").asText());
        Path target = resolveInsideWorkspace(
                context.workspaceRoot(),
                logicalPath
        );
        String expectedVersion = versionOf(target);
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("path", logicalPath);
        normalized.put("line", input.path("line").asText());
        String impact = Files.exists(target)
                ? "将向工作区文件 " + logicalPath + " 追加一行，当前版本 "
                        + expectedVersion.substring(0, 12)
                : "将创建工作区文件 " + logicalPath + " 并写入一行";
        return new PreparedOperation(
                normalized,
                impact,
                List.of(new ResourceClaim(
                        "workspace_file",
                        logicalPath,
                        expectedVersion
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
        Path target = resolveInsideWorkspace(
                context.workspaceRoot(),
                resource.logicalPath()
        );
        String currentVersion = versionOf(target);
        if (!currentVersion.equals(resource.expectedVersion())) {
            return ToolOutcome.failed(
                    "resource_version_changed",
                    "文件在审批期间发生变化，需要重新预览并批准"
            );
        }
        Path parent = target.getParent();
        if (parent == null) {
            return ToolOutcome.failed(
                    "invalid_workspace_path",
                    "文件路径缺少安全父目录"
            );
        }
        Files.createDirectories(parent);
        String line = operation.normalizedInput().path("line").asText();
        Files.writeString(
                target,
                line + System.lineSeparator(),
                StandardCharsets.UTF_8,
                StandardOpenOption.CREATE,
                StandardOpenOption.APPEND
        );
        ObjectNode output = objectMapper.createObjectNode();
        output.put("path", resource.logicalPath());
        output.put(
                "bytesAppended",
                (line + System.lineSeparator())
                        .getBytes(StandardCharsets.UTF_8).length
        );
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) throws IOException {
        ResourceClaim resource = operation.resources().getFirst();
        Path target = resolveInsideWorkspace(
                context.workspaceRoot(),
                resource.logicalPath()
        );
        if (!Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS)) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "写入返回成功，但目标文件无法确认"
            );
        }
        String content = Files.readString(target, StandardCharsets.UTF_8);
        String line = operation.normalizedInput().path("line").asText();
        if (!content.endsWith(line + System.lineSeparator())) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "目标文件存在，但无法确认追加内容位于末尾"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "workspace_file_version",
                        resource.logicalPath(),
                        "追加已确认，文件版本 " + versionOf(target).substring(0, 12)
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("path")
                .put("type", "string")
                .put("description", "工作区内相对路径，如 notes/todo.md");
        properties.putObject("line")
                .put("type", "string")
                .put("description", "要追加的一行 UTF-8 文本");
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
                .put("description", "完成写入的工作区相对路径");
        properties.putObject("bytesAppended")
                .put("type", "integer")
                .put("description", "本次追加的 UTF-8 字节数");
        schema.putArray("required").add("path").add("bytesAppended");
        return schema;
    }

    private String normalizeLogicalPath(String rawPath) {
        if (rawPath == null || rawPath.isBlank()) {
            throw new ToolRuntimeException(
                    "invalid_workspace_path",
                    "工作区路径不能为空"
            );
        }
        Path logical;
        try {
            logical = Path.of(rawPath);
        } catch (RuntimeException exception) {
            throw new ToolRuntimeException(
                    "invalid_workspace_path",
                    "工作区路径格式无效"
            );
        }
        if (logical.isAbsolute()
                || rawPath.indexOf('\0') >= 0
                || rawPath.startsWith("\\\\")
                || rawPath.contains(":")
                || logical.normalize().startsWith("..")) {
            throw new ToolRuntimeException(
                    "workspace_path_outside_fence",
                    "路径越界：只能使用工作区内相对路径"
            );
        }
        String normalized = logical.normalize().toString().replace('\\', '/');
        if (normalized.isBlank() || ".".equals(normalized)) {
            throw new ToolRuntimeException(
                    "invalid_workspace_path",
                    "路径必须指向工作区内文件"
            );
        }
        return normalized;
    }

    private Path resolveInsideWorkspace(Path configuredRoot, String logicalPath)
            throws IOException {
        Path root = configuredRoot.toRealPath(LinkOption.NOFOLLOW_LINKS);
        Path target = root.resolve(logicalPath).normalize();
        if (!target.startsWith(root)) {
            throw new ToolRuntimeException(
                    "workspace_path_outside_fence",
                    "路径越界：只能操作工作区内文件"
            );
        }
        Path ancestor = target;
        while (ancestor != null && !Files.exists(
                ancestor,
                LinkOption.NOFOLLOW_LINKS
        )) {
            ancestor = ancestor.getParent();
        }
        if (ancestor == null
                || !ancestor.toRealPath().startsWith(root)) {
            throw new ToolRuntimeException(
                    "workspace_path_outside_fence",
                    "目标路径的已存在父目录越过工作区围栏"
            );
        }
        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)
                && !target.toRealPath().startsWith(root)) {
            throw new ToolRuntimeException(
                    "workspace_path_outside_fence",
                    "目标符号链接指向工作区之外"
            );
        }
        return target;
    }

    private String versionOf(Path target) throws IOException {
        if (!Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            return "absent";
        }
        if (!Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS)) {
            throw new ToolRuntimeException(
                    "workspace_target_not_file",
                    "目标存在但不是普通文件"
            );
        }
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256")
                            .digest(Files.readAllBytes(target))
            );
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 unavailable", exception);
        }
    }
}
