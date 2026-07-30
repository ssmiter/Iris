package com.iris.tools.system.artifacts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.artifact.ArtifactService;
import com.iris.artifact.ArtifactService.ArtifactTextWindow;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.VerificationResult;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

@Component
public class ReadArtifactTextTool implements Tool {
    private static final int DEFAULT_CHARACTER_COUNT = 8_000;
    private static final int MAX_CHARACTER_COUNT = 20_000;

    private final ObjectMapper objectMapper;
    private final ArtifactService artifacts;
    private final ToolManifest manifest;

    public ReadArtifactTextTool(
            ObjectMapper objectMapper,
            ArtifactService artifacts
    ) {
        this.objectMapper = objectMapper;
        this.artifacts = artifacts;
        this.manifest = new ToolManifest(
                "iris.system.artifacts.read_artifact_text",
                "1",
                "read_artifact_text",
                "按字符窗口读取文本 Artifact 的不可变正文；用于稳定交接，避免把整个长文件载入上下文",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                12,
                10_000,
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
        String reference = ArtifactToolSupport.requiredText(
                input, "artifact_ref", 120
        );
        int start = input.path("start_character").asInt(0);
        int count = input.path("character_count")
                .asInt(DEFAULT_CHARACTER_COUNT);
        if (start < 0 || count < 1 || count > MAX_CHARACTER_COUNT) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_artifact_text_window",
                    "start_character 必须大于等于 0，character_count 必须在 1 到 "
                            + MAX_CHARACTER_COUNT + " 之间"
            );
        }
        artifacts.require(reference, context.conversationId());
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("artifact_ref", reference);
        normalized.put("start_character", start);
        normalized.put("character_count", count);
        return new PreparedOperation(
                normalized,
                "读取 " + reference + " 从字符 " + start
                        + " 开始的最多 " + count + " 个字符",
                List.of(),
                Instant.now().plusSeconds(30)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode input = operation.normalizedInput();
        ArtifactTextWindow window = artifacts.readTextWindow(
                input.path("artifact_ref").asText(),
                context.conversationId(),
                input.path("start_character").asInt(),
                input.path("character_count").asInt()
        );
        ObjectNode output = objectMapper.createObjectNode();
        output.put("artifactRef", window.artifactRef());
        output.put("title", window.title());
        output.put("format", window.format());
        output.put("startCharacter", window.startCharacter());
        output.put("content", window.content());
        output.put("hasMore", window.hasMore());
        if (window.nextStartCharacter() != null) {
            output.put(
                    "nextStartCharacter",
                    window.nextStartCharacter()
            );
        }
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "artifact_text_window",
                        outcome.output().path("artifactRef").asText(),
                        "已从不可变对象仓读取指定字符窗口"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = ArtifactToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("artifact_ref")
                .put("type", "string")
                .put("description", "read_artifact 确认过的 artifact:// 版本化引用");
        properties.putObject("start_character")
                .put("type", "integer")
                .put("minimum", 0)
                .put("default", 0)
                .put("description", "从零开始的字符偏移；继续读取时使用 nextStartCharacter");
        properties.putObject("character_count")
                .put("type", "integer")
                .put("minimum", 1)
                .put("maximum", MAX_CHARACTER_COUNT)
                .put("default", DEFAULT_CHARACTER_COUNT)
                .put("description", "本次最多读取的字符数");
        schema.putArray("required").add("artifact_ref");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = ArtifactToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("artifactRef")
                .put("type", "string")
                .put("description", "本次读取的版本化 Artifact 引用");
        properties.putObject("title")
                .put("type", "string")
                .put("description", "Artifact 的用户可读标题");
        properties.putObject("format")
                .put("type", "string")
                .put("description", "Artifact 声明的内容格式");
        properties.putObject("startCharacter")
                .put("type", "integer")
                .put("description", "本窗口在完整文本中的起始字符偏移");
        properties.putObject("content")
                .put("type", "string")
                .put("description", "当前字符窗口内的文本内容");
        properties.putObject("hasMore")
                .put("type", "boolean")
                .put("description", "当前窗口之后是否仍有可读取文本");
        properties.putObject("nextStartCharacter")
                .put("type", "integer")
                .put(
                        "description",
                        "存在后续内容时，下一窗口应使用的起始字符偏移"
                );
        schema.putArray("required")
                .add("artifactRef")
                .add("title")
                .add("format")
                .add("startCharacter")
                .add("content")
                .add("hasMore");
        return schema;
    }
}
