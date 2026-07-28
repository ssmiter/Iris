package com.iris.tools.system.files;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.VerificationResult;
import com.iris.workspace.WorkspaceFileService;
import com.iris.workspace.WorkspaceFileService.FileEntry;
import com.iris.workspace.WorkspaceFileService.ListRequest;
import com.iris.workspace.WorkspaceFileService.ListResult;
import com.iris.workspace.WorkspacePathGuard;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.time.Instant;
import java.util.List;

/**
 * 有界列出工作区目录。package 自动形成 /system/files/list_files。
 */
@Component
public class ListFilesTool implements Tool {

    private static final int DEFAULT_RECURSIVE_DEPTH = 8;
    private static final int DEFAULT_RESULTS = 200;

    private final ObjectMapper objectMapper;
    private final WorkspacePathGuard pathGuard;
    private final WorkspaceFileService fileService;
    private final ToolManifest manifest;

    public ListFilesTool(
            ObjectMapper objectMapper,
            WorkspacePathGuard pathGuard,
            WorkspaceFileService fileService
    ) {
        this.objectMapper = objectMapper;
        this.pathGuard = pathGuard;
        this.fileService = fileService;
        this.manifest = new ToolManifest(
                "iris.system.files.list_files",
                "2",
                "list_files",
                "列出工作区目录结构；需要确认文件位置、名称或范围时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                15,
                80_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
                ToolManifest.EvidencePolicy.SUMMARY,
                ToolManifest.ContextRetention.REFETCHABLE,
                ToolManifest.ConcurrencySemantics.PARALLEL_SAFE,
                ToolManifest.CancellationSemantics.COOPERATIVE
        );
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String path = pathGuard.normalizeDirectory(
                input.path("path").asText(".")
        );
        boolean recursive = input.path("recursive").asBoolean(false);
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("path", path);
        normalized.put("recursive", recursive);
        putOptionalText(normalized, "pattern", input.get("pattern"));
        return new PreparedOperation(
                normalized,
                "列出工作区目录 " + path
                        + (recursive ? " 的有界递归结构" : " 的直接内容")
                        + "，不改变任何外部状态",
                List.of(),
                Instant.now().plusSeconds(60)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) throws IOException {
        JsonNode input = operation.normalizedInput();
        ListResult result = fileService.list(
                context.workspaceRoot(),
                new ListRequest(
                        input.path("path").asText(),
                        input.path("recursive").asBoolean(),
                        input.path("recursive").asBoolean()
                                ? DEFAULT_RECURSIVE_DEPTH
                                : 1,
                        nullableText(input.get("pattern")),
                        false,
                        false,
                        DEFAULT_RESULTS
                ),
                context::cancelled
        );
        ObjectNode output = objectMapper.createObjectNode();
        output.put("path", result.path());
        ArrayNode entries = output.putArray("entries");
        for (FileEntry entry : result.entries()) {
            ObjectNode item = entries.addObject();
            item.put("path", entry.path());
            item.put("kind", entry.kind());
            if (entry.sizeBytes() == null) {
                item.putNull("sizeBytes");
            } else {
                item.put("sizeBytes", entry.sizeBytes());
            }
            item.put("modifiedAt", entry.modifiedAt().toString());
        }
        output.put("scannedEntries", result.scannedEntries());
        output.put("skippedEntries", result.skippedEntries());
        output.put("truncated", result.truncated());
        output.put("guidance", result.truncated()
                ? "结果已到预算；请缩小 path、pattern 或改为非递归查看"
                : result.entries().isEmpty()
                        ? "目录存在但当前条件下没有可见条目"
                        : "目录范围已列完");
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        String path = operation.normalizedInput().path("path").asText();
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "workspace_directory_snapshot",
                        path,
                        "已在工作区围栏内完成有界目录枚举"
                )
        ));
    }

    private void putOptionalText(
            ObjectNode target,
            String field,
            JsonNode value
    ) {
        if (value != null && !value.isNull() && !value.asText().isBlank()) {
            target.put(field, value.asText());
        }
    }

    private String nullableText(JsonNode value) {
        return value == null || value.isNull() ? null : value.asText();
    }

    private JsonNode inputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("path").put("type", "string")
                .put("description", "工作区内相对目录；默认 . 表示根目录");
        properties.putObject("recursive").put("type", "boolean")
                .put("description", "是否递归列出；默认 false");
        properties.putObject("pattern").put("type", "string")
                .put("description", "相对基础目录的可选 glob，如 **/*.java");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("path").put("type", "string")
                .put("description", "实际枚举的工作区逻辑目录");
        ObjectNode entries = properties.putObject("entries");
        entries.put("type", "array");
        entries.put("description", "稳定排序后的文件、目录与链接条目");
        ObjectNode item = entries.putObject("items");
        item.put("type", "object");
        ObjectNode itemProperties = item.putObject("properties");
        itemProperties.putObject("path").put("type", "string");
        itemProperties.putObject("kind").put("type", "string");
        itemProperties.putObject("sizeBytes").put("type", "integer");
        itemProperties.putObject("modifiedAt").put("type", "string");
        properties.putObject("scannedEntries").put("type", "integer")
                .put("description", "为得到结果实际检查的条目数");
        properties.putObject("skippedEntries").put("type", "integer")
                .put("description", "因隐藏、生成目录或类型边界跳过的数量");
        properties.putObject("truncated").put("type", "boolean")
                .put("description", "是否因扫描或结果预算提前结束");
        properties.putObject("guidance").put("type", "string")
                .put("description", "范围状态与下一步收窄提示");
        schema.putArray("required")
                .add("path").add("entries").add("scannedEntries")
                .add("skippedEntries").add("truncated").add("guidance");
        return schema;
    }
}
