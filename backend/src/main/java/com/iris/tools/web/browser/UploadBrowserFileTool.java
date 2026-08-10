package com.iris.tools.web.browser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.PreparedOperation.ResourceClaim;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.VerificationResult;
import com.iris.webbridge.BrowserRuntimeService;
import com.iris.webbridge.WebBridgeClient;
import com.iris.workspace.WorkspacePathGuard;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;

/** Bridges a workspace file into one observed browser file input. */
@Component
public class UploadBrowserFileTool implements Tool {
    private static final long MAX_UPLOAD_BYTES = 128L * 1024 * 1024;

    private final ObjectMapper objectMapper;
    private final BrowserRuntimeService runtimeService;
    private final WebBridgeClient client;
    private final WorkspacePathGuard pathGuard;
    private final ToolManifest manifest;

    public UploadBrowserFileTool(
            ObjectMapper objectMapper,
            BrowserRuntimeService runtimeService,
            WebBridgeClient client,
            WorkspacePathGuard pathGuard
    ) {
        this.objectMapper = objectMapper;
        this.runtimeService = runtimeService;
        this.client = client;
        this.pathGuard = pathGuard;
        this.manifest = new ToolManifest(
                "iris.web.browser.upload_browser_file",
                "1",
                "upload_browser_file",
                "把工作区围栏内的一个现有文件设置到最近页面观察中的 file input，并返回动作后观察；用于上传简历、附件和表单材料，不接受绝对路径",
                inputSchema(),
                outputSchema(),
                RiskLevel.ELEVATED,
                ToolManifest.SideEffect.EXTERNAL_WRITE,
                120,
                80_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT_WITH_KEY,
                ToolManifest.EvidencePolicy.REQUIRED,
                ToolManifest.ContextRetention.REFETCHABLE,
                ToolManifest.ConcurrencySemantics.SERIAL,
                ToolManifest.CancellationSemantics.COMMIT_BOUNDARY
        );
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public PreparedOperation prepare(
            JsonNode input,
            ToolContext context
    ) throws IOException {
        String runtimeId = runtimeService.resolveAvailable(
                BrowserToolSupport.optionalId(input, "runtime_id")
        );
        String sessionId = BrowserToolSupport.requiredId(input, "session_id");
        String pageId = BrowserToolSupport.requiredId(input, "page_id");
        String observationRef = BrowserToolSupport.optionalObservationRef(
                input,
                "observation_ref"
        );
        if (observationRef == null) {
            throw new ToolRuntimeException(
                    "browser_observation_required",
                    "上传前必须传入最近页面观察的 observation_ref"
            );
        }
        String elementRef = BrowserToolSupport.requiredId(input, "element_ref");
        JsonNode resolvedElement = client.resolveElement(
                runtimeId,
                sessionId,
                pageId,
                observationRef,
                elementRef
        ).path("element");
        if (!"input".equals(resolvedElement.path("tag").asText())
                || !"file".equals(resolvedElement.path("type").asText())) {
            throw new ToolRuntimeException(
                    "browser_file_input_required",
                    "element_ref 必须指向当前观察中的 file input"
            );
        }
        if (resolvedElement.path("disabled").asBoolean(false)) {
            throw new ToolRuntimeException(
                    "browser_element_disabled",
                    "目标 file input 当前不可用"
            );
        }

        WorkspacePathGuard.ResolvedPath file = pathGuard.resolveExistingFile(
                context.workspaceRoot(),
                input.path("workspace_path").asText()
        );
        long byteCount = Files.size(file.physicalPath());
        if (byteCount > MAX_UPLOAD_BYTES) {
            throw new ToolRuntimeException(
                    "browser_upload_file_too_large",
                    "上传文件为 " + byteCount + " 字节，超过 128 MiB 上限"
            );
        }
        String contentHash = sha256(file.physicalPath());
        String fileName = file.physicalPath().getFileName().toString();

        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("runtime_id", runtimeId);
        normalized.put("session_id", sessionId);
        normalized.put("page_id", pageId);
        normalized.put("observation_ref", observationRef);
        normalized.put("element_ref", elementRef);
        normalized.put("workspace_path", file.logicalPath());
        normalized.put("file_name", fileName);
        normalized.put("byte_count", byteCount);
        normalized.put("content_hash", contentHash);
        return new PreparedOperation(
                normalized,
                "将把工作区文件 " + file.logicalPath() + "（" + byteCount
                        + " 字节）设置到页面文件字段 " + describe(
                        resolvedElement,
                        elementRef
                ) + "；网页随后可读取并上传该文件内容",
                List.of(
                        new ResourceClaim(
                                "workspace_file",
                                file.logicalPath(),
                                contentHash
                        ),
                        new ResourceClaim(
                                "browser_page",
                                runtimeId + "/" + sessionId + "/" + pageId,
                                observationRef
                        )
                ),
                Instant.now().plusSeconds(300)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) throws IOException {
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_browser_upload",
                    "任务已停止，文件尚未设置到网页"
            );
        }
        JsonNode input = operation.normalizedInput();
        WorkspacePathGuard.ResolvedPath file = pathGuard.resolveExistingFile(
                context.workspaceRoot(),
                input.path("workspace_path").asText()
        );
        long byteCount = Files.size(file.physicalPath());
        String contentHash = sha256(file.physicalPath());
        if (byteCount != input.path("byte_count").asLong()
                || !contentHash.equals(input.path("content_hash").asText())) {
            throw ToolRuntimeException.beforeCommit(
                    "workspace_file_changed_after_approval",
                    "工作区文件在审批后发生变化；未上传，请重新确认"
            );
        }
        JsonNode response = client.uploadFile(
                input.path("runtime_id").asText(),
                input.path("session_id").asText(),
                input.path("page_id").asText(),
                input.path("observation_ref").asText(),
                input.path("element_ref").asText(),
                file.physicalPath(),
                input.path("file_name").asText(),
                byteCount,
                operation.executionId()
        );
        return BrowserToolSupport.actionOutcome(
                response,
                "browser_upload_not_applied",
                "页面、字段或工作区文件已变化；文件未设置",
                "browser_upload_outcome_unknown",
                "Browser Runtime 无法证明文件是否已经设置"
        );
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode output = outcome.output();
        JsonNode observation = output.path("observation");
        JsonNode evidence = output.path("evidence");
        if (observation.path("ref").asText().isBlank()
                || evidence.path("ref").asText().isBlank()) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "上传已返回 applied，但缺少字段确认或动作后观察"
            );
        }
        JsonNode input = operation.normalizedInput();
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "browser_file_input",
                        evidence.path("ref").asText(),
                        "工作区文件 " + input.path("workspace_path").asText()
                                + " 已设置到页面文件字段"
                ),
                new VerificationResult.Evidence(
                        "workspace_file_content",
                        input.path("content_hash").asText(),
                        "上传内容与审批时的工作区文件一致"
                ),
                new VerificationResult.Evidence(
                        "browser_page_observation",
                        observation.path("ref").asText(),
                        "文件设置后页面已重新观察"
                )
        ));
    }

    private String sha256(Path path) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
        try (InputStream input = Files.newInputStream(path)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                if (read > 0) {
                    digest.update(buffer, 0, read);
                }
            }
        }
        return "sha256:" + HexFormat.of().formatHex(digest.digest());
    }

    private String describe(JsonNode element, String fallback) {
        String name = element.path("name").asText("").trim();
        String context = element.path("context").asText("").trim();
        String base = name.isBlank() ? fallback : "“" + name + "”";
        return context.isBlank() ? base : base + "（" + context + "）";
    }

    private JsonNode inputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("runtime_id").put("type", "string")
                .put("description", "可选定向 Runtime ID；默认 Runtime 由 Backend 解析");
        properties.putObject("session_id").put("type", "string")
                .put("description", "当前短期 BrowserSession ID");
        properties.putObject("page_id").put("type", "string")
                .put("description", "当前活动 BrowserPage ID");
        properties.putObject("observation_ref").put("type", "string")
                .put("description", "包含目标 file input 的最近页面观察 ref");
        properties.putObject("element_ref").put("type", "string")
                .put("description", "同一 observation 中 type=file 的 input 元素 ref");
        properties.putObject("workspace_path").put("type", "string")
                .put("description", "工作区内现有文件的逻辑相对路径；禁止绝对路径和 ..");
        schema.putArray("required")
                .add("session_id").add("page_id")
                .add("observation_ref").add("element_ref")
                .add("workspace_path");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("status").put("type", "string")
                .put("description", "applied / not_applied / outcome_unknown");
        properties.putObject("actionAttemptId").put("type", "string")
                .put("description", "本次文件设置动作的稳定尝试 ID");
        properties.putObject("idempotencyKey").put("type", "string")
                .put("description", "用于防止重复设置文件的幂等键");
        properties.putObject("pageId").put("type", "string")
                .put("description", "文件设置后的当前 Page ID");
        properties.putObject("openedNewPage").put("type", "boolean")
                .put("description", "文件设置动作是否产生并接管了新页面");
        properties.set(
                "observation",
                BrowserToolSupport.browserObservationSchema(objectMapper)
        );
        properties.putObject("evidence").put("type", "object")
                .put("description", "文件字段状态、内容一致性与动作后页面证据");
        schema.putArray("required")
                .add("status").add("actionAttemptId")
                .add("idempotencyKey").add("pageId")
                .add("openedNewPage").add("observation")
                .add("evidence");
        return schema;
    }
}
