package com.iris.tools.system.files;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import com.iris.workspace.WorkspaceFileService.NumberedLine;
import com.iris.workspace.WorkspaceFileService.ReadRequest;
import com.iris.workspace.WorkspaceFileService.ReadResult;
import com.iris.workspace.WorkspacePathGuard;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.time.Instant;
import java.util.List;

/**
 * 按行读取工作区文本文件。package 自动形成 /system/files/read_file。
 */
@Component
public class ReadFileTool implements Tool {

    private static final int DEFAULT_LINE_COUNT = 400;
    private static final int MAX_LINE_COUNT = 2_000;

    private final ObjectMapper objectMapper;
    private final WorkspacePathGuard pathGuard;
    private final WorkspaceFileService fileService;
    private final ToolManifest manifest;

    public ReadFileTool(
            ObjectMapper objectMapper,
            WorkspacePathGuard pathGuard,
            WorkspaceFileService fileService
    ) {
        this.objectMapper = objectMapper;
        this.pathGuard = pathGuard;
        this.fileService = fileService;
        this.manifest = new ToolManifest(
                "iris.system.files.read_file",
                "2",
                "read_file",
                "按行读取工作区文本文件；已知文件路径并需要查看原文或核对搜索命中时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                15,
                70_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
                ToolManifest.EvidencePolicy.SUMMARY,
                ToolManifest.ContextRetention.REFETCHABLE,
                ToolManifest.ConcurrencySemantics.PARALLEL_SAFE,
                ToolManifest.CancellationSemantics.COOPERATIVE,
                "view contents open text lines peek"
        );
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String path = pathGuard.normalizeFile(input.path("path").asText());
        int startLine = WorkspaceFileToolSupport.boundedInteger(
                input.path("start_line").asInt(1),
                1,
                Integer.MAX_VALUE,
                "start_line"
        );
        int lineCount = WorkspaceFileToolSupport.boundedInteger(
                input.path("line_count").asInt(DEFAULT_LINE_COUNT),
                1,
                MAX_LINE_COUNT,
                "line_count"
        );
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("path", path);
        normalized.put("start_line", startLine);
        normalized.put("line_count", lineCount);
        return new PreparedOperation(
                normalized,
                "读取工作区文件 " + path + " 的第 "
                        + startLine + " 行起最多 " + lineCount
                        + " 行，不改变任何外部状态",
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
        ReadResult result = fileService.read(
                context.workspaceRoot(),
                new ReadRequest(
                        input.path("path").asText(),
                        input.path("start_line").asInt(),
                        input.path("line_count").asInt()
                ),
                context::cancelled
        );
        ObjectNode output = objectMapper.createObjectNode();
        output.put("path", result.path());
        output.put("encoding", result.encoding());
        output.put("sizeBytes", result.sizeBytes());
        output.put("content", projectContent(result.lines()));
        output.put("startLine", result.lines().isEmpty()
                ? input.path("start_line").asInt()
                : result.lines().getFirst().number());
        output.put("endLine", result.lines().isEmpty()
                ? 0
                : result.lines().getLast().number());
        output.put("returnedLines", result.lines().size());
        output.put("empty", result.empty());
        output.put("truncated", result.truncated());
        output.put("lineTruncated", result.lineTruncated());
        if (result.nextStartLine() == null) {
            output.putNull("nextStartLine");
        } else {
            output.put("nextStartLine", result.nextStartLine());
        }
        output.put("guidance", guidance(result));
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
                        "workspace_text_range",
                        path,
                        "已从工作区围栏内读取文本范围"
                )
        ));
    }

    private String projectContent(List<NumberedLine> lines) {
        StringBuilder content = new StringBuilder();
        for (NumberedLine line : lines) {
            if (!content.isEmpty()) {
                content.append('\n');
            }
            content.append(line.number()).append('→').append(line.text());
        }
        return content.toString();
    }

    private String guidance(ReadResult result) {
        if (result.empty()) {
            return "文件存在，但内容为空";
        }
        if (result.lineTruncated()) {
            return "当前单行超过输出预算，已保留前部；请用 search_files 定位更小范围";
        }
        if (result.nextStartLine() != null) {
            return "仍有后文；继续读取时把 start_line 设为 "
                    + result.nextStartLine();
        }
        return "已到达文件末尾";
    }

    private JsonNode inputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("path")
                .put("type", "string")
                .put("description", "工作区内相对文件路径，如 docs/notes.md");
        properties.putObject("start_line")
                .put("type", "integer")
                .put("minimum", 1)
                .put("description", "起始行号，1-based；默认 1");
        properties.putObject("line_count")
                .put("type", "integer")
                .put("minimum", 1)
                .put("maximum", MAX_LINE_COUNT)
                .put("description", "最多返回行数；默认 400，上限 2000");
        schema.putArray("required").add("path");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("path").put("type", "string")
                .put("description", "归一化后的工作区逻辑路径");
        properties.putObject("encoding").put("type", "string")
                .put("description", "检测并实际使用的文本编码");
        properties.putObject("sizeBytes").put("type", "integer")
                .put("description", "文件字节数");
        properties.putObject("content").put("type", "string")
                .put("description", "带 N→ 前缀的逐行内容，前缀不属于文件");
        properties.putObject("startLine").put("type", "integer")
                .put("description", "实际返回的首行号");
        properties.putObject("endLine").put("type", "integer")
                .put("description", "实际返回的末行号；空文件为 0");
        properties.putObject("returnedLines").put("type", "integer")
                .put("description", "实际返回行数");
        properties.putObject("empty").put("type", "boolean")
                .put("description", "文件是否为空");
        properties.putObject("truncated").put("type", "boolean")
                .put("description", "请求范围之后是否仍有内容");
        properties.putObject("lineTruncated").put("type", "boolean")
                .put("description", "是否因单行过长而截断该行");
        properties.putObject("nextStartLine").put("type", "integer")
                .put("description", "继续读取的起始行；没有后文时为 null");
        properties.putObject("guidance").put("type", "string")
                .put("description", "根据读取边界生成的下一步提示");
        schema.putArray("required")
                .add("path").add("encoding").add("sizeBytes")
                .add("content").add("startLine").add("endLine")
                .add("returnedLines").add("empty").add("truncated")
                .add("lineTruncated").add("guidance");
        return schema;
    }
}
