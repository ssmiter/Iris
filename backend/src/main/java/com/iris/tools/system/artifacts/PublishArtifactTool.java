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
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.VerificationResult;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;
import java.util.Set;

@Component
public class PublishArtifactTool implements Tool {
    private static final Set<String> PUBLIC_VISIBILITY = Set.of(
            "model_context", "user_timeline"
    );

    private final ObjectMapper objectMapper;
    private final ArtifactService artifacts;
    private final ToolManifest manifest;

    public PublishArtifactTool(
            ObjectMapper objectMapper,
            ArtifactService artifacts
    ) {
        this.objectMapper = objectMapper;
        this.artifacts = artifacts;
        this.manifest = new ToolManifest(
                "iris.system.artifacts.publish_artifact",
                "1",
                "publish_artifact",
                "显式发布已登记 Artifact：供后续模型按引用使用，或作为用户时间线产物；不修改文件内容",
                inputSchema(),
                ArtifactToolSupport.outputSchema(objectMapper),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.INTERNAL_STATE,
                10,
                10_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
                ToolManifest.EvidencePolicy.REQUIRED,
                ToolManifest.ContextRetention.PINNED,
                ToolManifest.ConcurrencySemantics.SERIAL,
                ToolManifest.CancellationSemantics.COMMIT_BOUNDARY
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
        String visibility = input.path("visibility").asText("").trim();
        if (!PUBLIC_VISIBILITY.contains(visibility)) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_artifact_visibility",
                    "visibility 必须是 model_context 或 user_timeline"
            );
        }
        ArtifactSnapshot artifact = artifacts.require(
                reference,
                context.conversationId()
        );
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("artifact_ref", reference);
        normalized.put("visibility", visibility);
        return new PreparedOperation(
                normalized,
                "把 Artifact《" + artifact.title() + "》发布到 "
                        + visibility + "；只改变 Iris 内部可见性",
                List.of(new PreparedOperation.ResourceClaim(
                        "artifact_visibility",
                        reference + "/" + visibility,
                        String.join(",", artifact.visibility())
                )),
                Instant.now().plusSeconds(30)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode input = operation.normalizedInput();
        ArtifactSnapshot artifact = artifacts.publish(
                context,
                operation.executionId(),
                input.path("artifact_ref").asText(),
                input.path("visibility").asText()
        );
        return ToolOutcome.succeeded(artifacts.toJson(artifact));
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        String visibility = operation.normalizedInput()
                .path("visibility").asText();
        ArtifactSnapshot artifact = artifacts.require(
                outcome.output().path("artifactRef").asText(),
                context.conversationId()
        );
        if (!artifact.visibility().contains(visibility)) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "Artifact 发布后没有确认到目标可见性"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "artifact_visibility",
                        artifact.reference(),
                        "Artifact 已发布到 " + visibility
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = ArtifactToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("artifact_ref")
                .put("type", "string")
                .put("description", "已经登记的 artifact:// 版本化引用");
        properties.putObject("visibility")
                .put("type", "string")
                .put("description", "model_context 供模型交接；user_timeline 供用户查看")
                .putArray("enum")
                .add("model_context").add("user_timeline");
        schema.putArray("required").add("artifact_ref").add("visibility");
        return schema;
    }
}
