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
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

/** Opens one additional page while preserving the existing session pages. */
@Component
public class OpenBrowserPageTool implements Tool {
    private final ObjectMapper objectMapper;
    private final BrowserRuntimeService runtimeService;
    private final WebBridgeClient client;
    private final ToolManifest manifest;

    public OpenBrowserPageTool(
            ObjectMapper objectMapper,
            BrowserRuntimeService runtimeService,
            WebBridgeClient client
    ) {
        this.objectMapper = objectMapper;
        this.runtimeService = runtimeService;
        this.client = client;
        this.manifest = new ToolManifest(
                "iris.web.browser.open_browser_page",
                "1",
                "open_browser_page",
                "在现有 BrowserSession 中打开并激活一个新网页，同时保留旧页面；用于多来源检索、对照和需要随时切回原页的任务",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.EXTERNAL_WRITE,
                60,
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
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String runtimeId = runtimeService.resolveAvailable(
                BrowserToolSupport.optionalId(input, "runtime_id")
        );
        String sessionId = BrowserToolSupport.requiredId(input, "session_id");
        String url = BrowserToolSupport.requiredUrl(input, "url");
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("runtime_id", runtimeId);
        normalized.put("session_id", sessionId);
        normalized.put("url", url);
        return new PreparedOperation(
                normalized,
                "将在 BrowserSession " + sessionId + " 中打开新页面 "
                        + url + "；当前页面会保留，新页面将成为活动页并形成新观察",
                List.of(new ResourceClaim(
                        "browser_session",
                        runtimeId + "/" + sessionId,
                        null
                )),
                Instant.now().plusSeconds(300)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_browser_page_open",
                    "任务已停止，新浏览器页面尚未打开"
            );
        }
        JsonNode input = operation.normalizedInput();
        JsonNode response = client.openPage(
                input.path("runtime_id").asText(),
                input.path("session_id").asText(),
                input.path("url").asText(),
                operation.executionId()
        );
        return BrowserToolSupport.actionOutcome(
                response,
                "browser_page_open_not_applied",
                "新页面未打开",
                "browser_page_open_outcome_unknown",
                "Browser Runtime 未能证明新页面是否已经打开"
        );
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode output = outcome.output();
        String pageId = output.path("pageId").asText();
        String observationRef = output.path("observation").path("ref").asText();
        String evidenceRef = output.path("evidence").path("ref").asText();
        if (!output.path("openedNewPage").asBoolean(false)
                || pageId.isBlank()
                || observationRef.isBlank()
                || evidenceRef.isBlank()) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "daemon 返回了页面打开结果，但缺少新页面身份、观察或证据"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "browser_page_open",
                        evidenceRef,
                        "新页面 " + pageId + " 已成为活动页"
                ),
                new VerificationResult.Evidence(
                        "browser_page_observation",
                        observationRef,
                        "新页面已完成首次交互观察"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("runtime_id").put("type", "string")
                .put("description", "可选定向 Runtime ID；默认 Runtime 由 Backend 解析");
        properties.putObject("session_id").put("type", "string")
                .put("description", "要保留并增加页面的短期 BrowserSession ID");
        properties.putObject("url").put("type", "string")
                .put("description", "新页面要打开的 http/https URL 或 about:blank");
        schema.putArray("required").add("session_id").add("url");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("status").put("type", "string")
                .put("description", "成功时为 applied");
        properties.putObject("actionAttemptId").put("type", "string")
                .put("description", "本次新建页面动作的稳定尝试 ID");
        properties.putObject("idempotencyKey").put("type", "string")
                .put("description", "用于防止重复新建页面的幂等键");
        properties.putObject("pageId").put("type", "string")
                .put("description", "新建并激活的 BrowserPage ID");
        properties.putObject("openedNewPage").put("type", "boolean")
                .put("description", "是否成功新建并接管了页面");
        properties.putObject("pages").put("type", "array")
                .put("description", "Session 当前拥有的全部页面摘要");
        properties.set(
                "observation",
                BrowserToolSupport.browserObservationSchema(objectMapper)
        );
        properties.putObject("evidence").put("type", "object")
                .put("description", "页面创建及初始页面状态的证据");
        schema.putArray("required")
                .add("status").add("actionAttemptId")
                .add("idempotencyKey").add("pageId")
                .add("openedNewPage").add("pages")
                .add("observation").add("evidence");
        return schema;
    }
}
