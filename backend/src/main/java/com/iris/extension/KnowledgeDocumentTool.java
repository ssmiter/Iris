package com.iris.extension;

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

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;

/**
 * 知识文档投影成的只读能力（docs/31 §3）：invoke 即读取内容。
 * 无执行体进程——文档本身就是全部真相；内容 hash 即版本。
 */
public class KnowledgeDocumentTool implements Tool {

    private static final int CONTENT_READ_LIMIT = 100_000;

    private final Path file;
    private final String title;
    private final String capabilityPath;
    private final ToolManifest manifest;
    private final ObjectMapper objectMapper;

    public KnowledgeDocumentTool(
            Path file,
            String name,
            String title,
            String capabilityPath,
            String contentVersion,
            ObjectMapper objectMapper
    ) {
        this.file = file;
        this.title = title;
        this.capabilityPath = capabilityPath;
        this.objectMapper = objectMapper;
        this.manifest = new ToolManifest(
                "extension.knowledge." + name,
                contentVersion,
                name,
                title,
                inputSchema(objectMapper),
                outputSchema(objectMapper),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                5,
                CONTENT_READ_LIMIT,
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
        return new PreparedOperation(
                objectMapper.createObjectNode(),
                "读取知识文档《" + title + "》，不改变任何状态",
                List.of(),
                Instant.now().plusSeconds(30)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        if (context.cancelled()) {
            return ToolOutcome.failed("cancelled", "知识文档读取已取消");
        }
        String content;
        try {
            content = Files.readString(file, StandardCharsets.UTF_8);
        } catch (IOException exception) {
            return ToolOutcome.failed(
                    "knowledge_read_failed",
                    "知识文档读取失败: " + exception.getMessage()
            );
        }
        boolean truncated = content.length() > CONTENT_READ_LIMIT;
        ObjectNode output = objectMapper.createObjectNode();
        output.put("path", capabilityPath);
        output.put("title", title);
        output.put("content", truncated
                ? content.substring(0, CONTENT_READ_LIMIT)
                : content);
        output.put("truncated", truncated);
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        if (outcome.kind() != ToolOutcome.Kind.SUCCEEDED) {
            return new VerificationResult(
                    VerificationResult.Status.FAILED,
                    List.of(), outcome.message()
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "knowledge_document",
                        "file://" + file.toAbsolutePath(),
                        "知识文档内容来自拓展根内的原文文件"
                )
        ));
    }

    private static JsonNode inputSchema(ObjectMapper mapper) {
        ObjectNode schema = mapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        schema.set("properties", mapper.createObjectNode());
        return schema;
    }

    private static JsonNode outputSchema(ObjectMapper mapper) {
        ObjectNode schema = mapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", true);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("path").put("type", "string")
                .put("description", "知识文档的能力路径");
        properties.putObject("title").put("type", "string")
                .put("description", "文档标题（首个 # 标题行）");
        properties.putObject("content").put("type", "string")
                .put("description", "文档全文（超出结果预算时截断）");
        properties.putObject("truncated").put("type", "boolean")
                .put("description", "内容是否被结果预算截断");
        return schema;
    }
}
