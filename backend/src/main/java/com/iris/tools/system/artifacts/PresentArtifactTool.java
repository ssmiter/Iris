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
import java.util.Locale;

/** Freezes an existing workspace file and presents it as a user-facing result. */
@Component
public class PresentArtifactTool implements Tool {
    private final ObjectMapper objectMapper;
    private final ArtifactService artifacts;
    private final ToolManifest manifest;

    public PresentArtifactTool(
            ObjectMapper objectMapper,
            ArtifactService artifacts
    ) {
        this.objectMapper = objectMapper;
        this.artifacts = artifacts;
        this.manifest = new ToolManifest(
                "iris.system.artifacts.present_artifact",
                "1",
                "present_artifact",
                "把工作区内已经完成的重要文件冻结为 Artifact 并呈现给用户；不用于原始查询、日志、截图或普通中间文件",
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
        String caption = ArtifactToolSupport.requiredText(
                input,
                "caption",
                500
        );
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("path", candidate.logicalPath());
        normalized.put("caption", caption);
        String origin = input.path("origin_execution_id")
                .asText("").trim();
        if (!origin.isBlank()) {
            normalized.put("origin_execution_id", origin);
        }
        return new PreparedOperation(
                normalized,
                "把《" + caption + "》作为最终成果呈现给用户（"
                        + candidate.logicalPath() + "，"
                        + candidate.byteCount() + " 字节）",
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
        String name = fileName(input.path("path").asText());
        ArtifactSnapshot registered = artifacts.registerWorkspace(
                context,
                operation.executionId(),
                input.path("path").asText(),
                operation.resources().getFirst().expectedVersion(),
                name,
                input.path("caption").asText(),
                inferKind(name),
                input.path("origin_execution_id").asText(null)
        );
        ArtifactSnapshot published = artifacts.publish(
                context,
                operation.executionId(),
                registered.reference(),
                "user_timeline"
        );
        return ToolOutcome.succeeded(artifacts.toJson(published));
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
        if (!artifact.visibility().contains("internal")
                || !artifact.visibility().contains("user_timeline")) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "成果内容已冻结，但用户时间线发布状态没有完全确认"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "artifact_presentation",
                        artifact.reference(),
                        "已呈现《" + artifact.title() + "》，内容哈希 "
                                + artifact.contentHash().substring(0, 12)
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = ArtifactToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("path")
                .put("type", "string")
                .put("description", "围栏内已经完成、值得交付的工作区相对文件路径");
        properties.putObject("caption")
                .put("type", "string")
                .put("description", "用户能直接理解该成果价值的一句话标题")
                .put("minLength", 1)
                .put("maxLength", 500);
        properties.putObject("origin_execution_id")
                .put("type", "string")
                .put("description", "可选：真正生成该文件且已成功的工具执行 ID");
        schema.putArray("required").add("path").add("caption");
        return schema;
    }

    private String fileName(String logicalPath) {
        String normalized = logicalPath.replace('\\', '/');
        int separator = normalized.lastIndexOf('/');
        String name = separator >= 0
                ? normalized.substring(separator + 1)
                : normalized;
        if (name.isBlank()) {
            throw com.iris.tools.core.ToolRuntimeException.beforeCommit(
                    "invalid_artifact_path",
                    "Artifact 路径必须指向文件"
            );
        }
        return name;
    }

    private String inferKind(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".xlsx") || lower.endsWith(".xls")
                || lower.endsWith(".csv") || lower.endsWith(".tsv")) {
            return "spreadsheet";
        }
        if (lower.endsWith(".pptx") || lower.endsWith(".ppt")) {
            return "presentation";
        }
        if (lower.endsWith(".pdf")) {
            return "pdf";
        }
        if (lower.endsWith(".png") || lower.endsWith(".jpg")
                || lower.endsWith(".jpeg") || lower.endsWith(".gif")
                || lower.endsWith(".webp") || lower.endsWith(".svg")) {
            return "image";
        }
        if (lower.endsWith(".html") || lower.endsWith(".htm")) {
            return "html";
        }
        if (lower.endsWith(".java") || lower.endsWith(".kt")
                || lower.endsWith(".py") || lower.endsWith(".js")
                || lower.endsWith(".ts") || lower.endsWith(".tsx")
                || lower.endsWith(".jsx") || lower.endsWith(".css")
                || lower.endsWith(".sql") || lower.endsWith(".sh")
                || lower.endsWith(".ps1")) {
            return "code";
        }
        if (lower.endsWith(".md") || lower.endsWith(".txt")
                || lower.endsWith(".docx") || lower.endsWith(".doc")
                || lower.endsWith(".rtf")) {
            return "document";
        }
        if (lower.endsWith(".json") || lower.endsWith(".jsonl")
                || lower.endsWith(".xml") || lower.endsWith(".yaml")
                || lower.endsWith(".yml")) {
            return "data";
        }
        if (lower.endsWith(".zip") || lower.endsWith(".7z")
                || lower.endsWith(".tar") || lower.endsWith(".gz")) {
            return "archive";
        }
        return "file";
    }
}
