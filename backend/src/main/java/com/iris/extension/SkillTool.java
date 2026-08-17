package com.iris.extension;

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

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

/**
 * SKILL.md 技能投影成的只读能力（docs/31 §5.1）：invoke 无参返回
 * frontmatter 之后的正文与束内资源清单；{@code resource} 参数按相对
 * 路径读取束内文件，围栏到束目录（fail-close）。无执行体进程——
 * 文档本身就是全部真相；SKILL.md 内容 hash 即版本。
 */
public class SkillTool implements Tool {

    private static final int CONTENT_READ_LIMIT = 100_000;
    private static final int RESOURCE_LIST_LIMIT = 200;

    private final Path file;
    /** 束目录；扁平形态为 null。 */
    private final Path bundleDir;
    private final SkillDefinition definition;
    private final String capabilityPath;
    private final ToolManifest manifest;
    private final ObjectMapper objectMapper;

    public SkillTool(
            Path file,
            Path bundleDir,
            String name,
            SkillDefinition definition,
            String capabilityPath,
            String contentVersion,
            ObjectMapper objectMapper
    ) {
        this.file = file;
        this.bundleDir = bundleDir;
        this.definition = definition;
        this.capabilityPath = capabilityPath;
        this.objectMapper = objectMapper;
        String description = definition.description();
        this.manifest = new ToolManifest(
                "extension.skill." + name,
                contentVersion,
                name,
                description.length() <= 500
                        ? description : description.substring(0, 500),
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
                input == null ? objectMapper.createObjectNode() : input,
                "读取技能《" + manifest().name() + "》文档，不改变任何状态",
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
            return ToolOutcome.failed("cancelled", "技能读取已取消");
        }
        String resource = operation.normalizedInput() != null
                && operation.normalizedInput().has("resource")
                ? operation.normalizedInput().path("resource").asText()
                : null;
        if (resource == null || resource.isBlank()) {
            return readBody();
        }
        return readResource(resource.trim());
    }

    /** 无参：正文 + 束内资源相对路径清单。 */
    private ToolOutcome readBody() {
        String content;
        try {
            content = Files.readString(file, StandardCharsets.UTF_8);
        } catch (IOException exception) {
            return ToolOutcome.failed(
                    "skill_read_failed",
                    "技能文档读取失败: " + exception.getMessage()
            );
        }
        String[] parts = SkillDocument.split(content);
        String body = parts == null ? content : parts[1];
        boolean truncated = body.length() > CONTENT_READ_LIMIT;
        ObjectNode output = objectMapper.createObjectNode();
        output.put("path", capabilityPath);
        output.put("name", manifest().name());
        output.put("description", definition.description());
        if (definition.whenToUse() != null
                && !definition.whenToUse().isBlank()) {
            output.put("when_to_use", definition.whenToUse());
        }
        output.put("content", truncated
                ? body.substring(0, CONTENT_READ_LIMIT)
                : body);
        output.put("truncated", truncated);
        ArrayNode resources = output.putArray("resources");
        for (String relative : listResources()) {
            resources.add(relative);
        }
        return ToolOutcome.succeeded(output);
    }

    /** 束内资源按需读取：resolve 后必须仍在束目录内，纯文本同预算。 */
    private ToolOutcome readResource(String resource) {
        if (bundleDir == null) {
            return ToolOutcome.failed(
                    "skill_resource_unavailable",
                    "扁平技能没有束目录，无可读资源"
            );
        }
        Path resolved = bundleDir.resolve(resource).normalize();
        if (!resolved.startsWith(bundleDir)) {
            return ToolOutcome.failed(
                    "skill_resource_forbidden",
                    "资源路径越出束目录，已拒绝: " + resource
            );
        }
        if (!Files.isRegularFile(resolved)) {
            return ToolOutcome.failed(
                    "skill_resource_not_found",
                    "束内不存在该资源: " + resource
            );
        }
        String content;
        try {
            content = Files.readString(resolved, StandardCharsets.UTF_8);
        } catch (IOException exception) {
            return ToolOutcome.failed(
                    "skill_read_failed",
                    "资源读取失败: " + exception.getMessage()
            );
        }
        boolean truncated = content.length() > CONTENT_READ_LIMIT;
        ObjectNode output = objectMapper.createObjectNode();
        output.put("path", capabilityPath);
        output.put("resource", bundleDir.relativize(resolved).toString());
        output.put("content", truncated
                ? content.substring(0, CONTENT_READ_LIMIT)
                : content);
        output.put("truncated", truncated);
        return ToolOutcome.succeeded(output);
    }

    /** 束内全部文件的相对路径（不含 SKILL.md 自身），排序、≤200 条。 */
    private List<String> listResources() {
        if (bundleDir == null) {
            return List.of();
        }
        try (Stream<Path> walk = Files.walk(bundleDir)) {
            return walk.filter(Files::isRegularFile)
                    .filter(path -> !path.equals(file))
                    .map(path -> bundleDir.relativize(path).toString())
                    .sorted(Comparator.naturalOrder())
                    .limit(RESOURCE_LIST_LIMIT)
                    .toList();
        } catch (IOException | UncheckedIOException exception) {
            return List.of();
        }
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
                        "skill_document",
                        "file://" + file.toAbsolutePath(),
                        "技能内容来自拓展根内的 SKILL.md 原文"
                )
        ));
    }

    private static JsonNode inputSchema(ObjectMapper mapper) {
        ObjectNode schema = mapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("resource").put("type", "string")
                .put("description",
                        "束内资源的相对路径；不传则返回技能正文与资源清单");
        return schema;
    }

    private static JsonNode outputSchema(ObjectMapper mapper) {
        ObjectNode schema = mapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", true);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("path").put("type", "string")
                .put("description", "技能的能力路径");
        properties.putObject("content").put("type", "string")
                .put("description", "技能正文或资源内容（超出预算时截断）");
        properties.putObject("truncated").put("type", "boolean")
                .put("description", "内容是否被结果预算截断");
        properties.putObject("resources").put("type", "array")
                .put("description", "束内资源相对路径清单（无参调用时返回）");
        return schema;
    }
}
