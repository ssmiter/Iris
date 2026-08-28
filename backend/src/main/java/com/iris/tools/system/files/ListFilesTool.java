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
                "4",
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
                ToolManifest.CancellationSemantics.COOPERATIVE,
                "browse directory tree show folder entries",
                "recursive 默认 false；递归深度上限 8 层，每页最多 200 条，"
                        + "按最近修改降序。truncated 出现时用 nextOffset 翻页，"
                        + "或用更具体的路径与 glob 收窄；guidance 说明实际扫描范围。"
                        + "它建立的是工作区事实，不代表能力发现。"
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
        int offset = Math.max(0, input.path("offset").asInt(0));
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("path", path);
        normalized.put("recursive", recursive);
        normalized.put("offset", offset);
        putOptionalText(normalized, "glob", input.get("glob"));
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
        int offset = input.path("offset").asInt(0);
        ListResult result = fileService.list(
                context.workspaceRoot(),
                new ListRequest(
                        input.path("path").asText(),
                        input.path("recursive").asBoolean(),
                        input.path("recursive").asBoolean()
                                ? DEFAULT_RECURSIVE_DEPTH
                                : 1,
                        nullableText(input.get("glob")),
                        false,
                        false,
                        offset,
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
        output.put("totalEntries", result.totalEntries());
        output.put("scannedEntries", result.scannedEntries());
        output.put("skippedEntries", result.skippedEntries());
        int shown = result.entries().size();
        boolean hasMore = offset + shown < result.totalEntries();
        // 截断信号仅在真正截断时出现，防模型把前一页当全集
        if (result.scanTruncated() || hasMore) {
            output.put("truncated", true);
            output.put("appliedLimit", DEFAULT_RESULTS);
            if (hasMore) {
                output.put("nextOffset", offset + shown);
            }
        }
        output.put("guidance", guidance(
                result,
                offset,
                hasMore,
                input.get("glob") != null
        ));
        return ToolOutcome.succeeded(output);
    }

    private String guidance(
            ListResult result,
            int offset,
            boolean hasMore,
            boolean hasGlob
    ) {
        int shown = result.entries().size();
        if (shown == 0) {
            if (offset > 0 && result.totalEntries() > 0) {
                return "offset 已超出结果末尾，共 " + result.totalEntries()
                        + " 条；用更小的 offset 翻页";
            }
            if (result.scanTruncated()) {
                return "扫描预算已用尽，未在已扫描部分找到可见条目；"
                        + "用更具体的路径或 glob 收窄";
            }
            if (hasGlob) {
                return "没有匹配该 glob 的条目；调整 glob，或去掉 glob 查看整个目录";
            }
            if (result.scannedEntries() == 0) {
                return "这个目录是空的";
            }
            return "没有可见条目，" + result.skippedEntries()
                    + " 个隐藏或生成目录条目已跳过";
        }
        if (result.scanTruncated()) {
            return "扫描预算已用尽，结果只覆盖部分目录，已收集 "
                    + result.totalEntries() + " 条中显示 " + shown
                    + " 条；用更具体的路径或 glob 收窄";
        }
        if (hasMore) {
            return "结果已截断，共 " + result.totalEntries() + " 条中显示第 "
                    + (offset + 1) + " 到 " + (offset + shown)
                    + " 条，按最近修改排序；用 offset=" + (offset + shown)
                    + " 翻页，或用更具体的路径或 glob 收窄";
        }
        return "目录范围已列完，共 " + result.totalEntries() + " 条";
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
        properties.putObject("glob").put("type", "string")
                .put("description", "相对基础目录的可选 glob，如 **/*.java");
        properties.putObject("offset").put("type", "integer")
                .put("description", "结果起始偏移，按最近修改排序后翻页用；默认 0");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("path").put("type", "string")
                .put("description", "实际枚举的工作区逻辑目录");
        ObjectNode entries = properties.putObject("entries");
        entries.put("type", "array");
        entries.put("description", "按最近修改时间降序、路径决胜排序的本页条目");
        ObjectNode item = entries.putObject("items");
        item.put("type", "object");
        ObjectNode itemProperties = item.putObject("properties");
        itemProperties.putObject("path").put("type", "string");
        itemProperties.putObject("kind").put("type", "string");
        itemProperties.putObject("sizeBytes").put("type", "integer");
        itemProperties.putObject("modifiedAt").put("type", "string");
        properties.putObject("totalEntries").put("type", "integer")
                .put("description", "本次扫描在预算内收集到的匹配条目总数");
        properties.putObject("scannedEntries").put("type", "integer")
                .put("description", "为得到结果实际检查的条目数");
        properties.putObject("skippedEntries").put("type", "integer")
                .put("description", "因隐藏、生成目录或类型边界跳过的数量");
        properties.putObject("truncated").put("type", "boolean")
                .put("description", "结果未完整时才出现，恒为 true；不出现即全集");
        properties.putObject("appliedLimit").put("type", "integer")
                .put("description", "每页条数上限；仅截断时出现");
        properties.putObject("nextOffset").put("type", "integer")
                .put("description", "下一页的 offset；仅当后面还有条目时出现");
        properties.putObject("guidance").put("type", "string")
                .put("description", "范围状态、空结果说明与下一步收窄或翻页提示");
        schema.putArray("required")
                .add("path").add("entries").add("totalEntries")
                .add("scannedEntries").add("skippedEntries").add("guidance");
        return schema;
    }
}
