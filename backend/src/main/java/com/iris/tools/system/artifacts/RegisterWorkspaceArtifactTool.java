package com.iris.tools.system.artifacts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.artifact.ArtifactService;
import com.iris.artifact.ArtifactService.ArtifactSnapshot;
import com.iris.artifact.ArtifactService.WorkspaceCandidate;
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
public class RegisterWorkspaceArtifactTool implements Tool {
    private final ObjectMapper objectMapper;
    private final ArtifactService artifacts;
    private final ToolManifest manifest;

    public RegisterWorkspaceArtifactTool(
            ObjectMapper objectMapper,
            ArtifactService artifacts
    ) {
        this.objectMapper = objectMapper;
        this.artifacts = artifacts;
        this.manifest = new ToolManifest(
                "iris.system.artifacts.register_workspace_artifact",
                "1",
                "register_workspace_artifact",
                "把工作区普通文件的精确版本冻结并登记为内部 Artifact；登记不会自动展示给用户",
                inputSchema(),
                ArtifactToolSupport.outputSchema(objectMapper),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.INTERNAL_STATE,
                30,
                10_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT_WITH_KEY,
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
    public PreparedOperation prepare(JsonNode input, ToolContext context)
            throws Exception {
        WorkspaceCandidate candidate = artifacts.inspectWorkspace(
                context,
                input.path("path").asText()
        );
        String name = ArtifactToolSupport.requiredText(
                input, "name", 240
        );
        String title = ArtifactToolSupport.requiredText(
                input, "title", 500
        );
        String kind = input.path("kind").asText("").trim();
        if (!ArtifactToolSupport.KINDS.contains(kind)) {
            throw com.iris.tools.core.ToolRuntimeException.beforeCommit(
                    "invalid_artifact_kind",
                    "kind 必须是已声明的 Artifact 类型"
            );
        }
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("path", candidate.logicalPath());
        normalized.put("name", name);
        normalized.put("title", title);
        normalized.put("kind", kind);
        String origin = input.path("origin_execution_id")
                .asText("").trim();
        if (!origin.isBlank()) {
            normalized.put("origin_execution_id", origin);
        }
        return new PreparedOperation(
                normalized,
                "把工作区文件 " + candidate.logicalPath()
                        + " 的当前 " + candidate.byteCount()
                        + " 字节版本冻结为内部 Artifact；"
                        + "不修改文件，也不展示到用户时间线",
                List.of(new PreparedOperation.ResourceClaim(
                        "workspace_file_version",
                        candidate.logicalPath(),
                        candidate.version()
                )),
                Instant.now().plusSeconds(60)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) throws Exception {
        JsonNode input = operation.normalizedInput();
        ArtifactSnapshot artifact = artifacts.registerWorkspace(
                context,
                operation.executionId(),
                input.path("path").asText(),
                operation.resources().getFirst().expectedVersion(),
                input.path("name").asText(),
                input.path("title").asText(),
                input.path("kind").asText(),
                input.path("origin_execution_id").asText(null)
        );
        return ToolOutcome.succeeded(artifacts.toJson(artifact));
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        ArtifactSnapshot artifact = artifacts.require(
                outcome.output().path("artifactRef").asText(),
                context.conversationId()
        );
        if (!artifact.visibility().contains("internal")) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "Artifact 内容已登记，但内部可见性没有确认"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "artifact_content_version",
                        artifact.reference(),
                        "已冻结 " + artifact.byteCount()
                                + " 字节，内容哈希 "
                                + artifact.contentHash().substring(0, 12)
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = ArtifactToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("path")
                .put("type", "string")
                .put("description", "围栏内已存在的工作区相对文件路径");
        properties.putObject("name")
                .put("type", "string")
                .put("description", "带扩展名的用户可识别文件名")
                .put("maxLength", 240);
        properties.putObject("title")
                .put("type", "string")
                .put("description", "产物解决什么问题的人话标题")
                .put("maxLength", 500);
        properties.putObject("kind")
                .put("type", "string")
                .put("description", "决定后续预览方式的内容类别")
                .putArray("enum")
                .add("document").add("spreadsheet").add("presentation")
                .add("pdf").add("image").add("html").add("data")
                .add("code").add("archive").add("file");
        properties.putObject("origin_execution_id")
                .put("type", "string")
                .put("description", "可选：真正生成该文件且已成功的工具执行 ID");
        schema.putArray("required")
                .add("path").add("name").add("title").add("kind");
        return schema;
    }
}
