package com.iris.tools.system.artifacts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.artifact.ArtifactService;
import com.iris.artifact.ArtifactService.ArtifactSnapshot;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.VerificationResult;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

@Component
public class ReadArtifactTool implements Tool {
    private final ObjectMapper objectMapper;
    private final ArtifactService artifacts;
    private final ToolManifest manifest;

    public ReadArtifactTool(
            ObjectMapper objectMapper,
            ArtifactService artifacts
    ) {
        this.objectMapper = objectMapper;
        this.artifacts = artifacts;
        this.manifest = new ToolManifest(
                "iris.system.artifacts.read_artifact",
                "1",
                "read_artifact",
                "按 artifact:// 稳定引用读取产物元数据、来源和可见性；不把文件正文载入上下文",
                inputSchema(),
                ArtifactToolSupport.outputSchema(objectMapper),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                5,
                10_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
                ToolManifest.EvidencePolicy.SUMMARY,
                ToolManifest.ContextRetention.PINNED,
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
        artifacts.require(reference, context.conversationId());
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("artifact_ref", reference);
        return new PreparedOperation(
                normalized,
                "读取 Artifact " + reference + " 的元数据，不读取正文",
                List.of(),
                Instant.now().plusSeconds(30)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        ArtifactSnapshot artifact = artifacts.require(
                operation.normalizedInput().path("artifact_ref").asText(),
                context.conversationId()
        );
        return ToolOutcome.succeeded(artifacts.toJson(artifact));
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "artifact_metadata",
                        outcome.output().path("artifactRef").asText(),
                        "Artifact 元数据来自内部注册表"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = ArtifactToolSupport.objectSchema(objectMapper);
        ((ObjectNode) schema.path("properties"))
                .putObject("artifact_ref")
                .put("type", "string")
                .put("description", "register_workspace_artifact 返回的版本化引用");
        schema.putArray("required").add("artifact_ref");
        return schema;
    }
}
