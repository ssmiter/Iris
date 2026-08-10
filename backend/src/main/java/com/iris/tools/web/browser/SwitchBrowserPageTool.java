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
import com.iris.tools.core.VerificationResult;
import com.iris.webbridge.BrowserRuntimeService;
import com.iris.webbridge.WebBridgeClient;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

/** Activates one page already owned by a BrowserSession. */
@Component
public class SwitchBrowserPageTool implements Tool {
    private final ObjectMapper objectMapper;
    private final BrowserRuntimeService runtimeService;
    private final WebBridgeClient client;
    private final ToolManifest manifest;

    public SwitchBrowserPageTool(
            ObjectMapper objectMapper,
            BrowserRuntimeService runtimeService,
            WebBridgeClient client
    ) {
        this.objectMapper = objectMapper;
        this.runtimeService = runtimeService;
        this.client = client;
        this.manifest = new ToolManifest(
                "iris.web.browser.switch_browser_page",
                "1",
                "switch_browser_page",
                "切换到当前 BrowserSession 已拥有的另一个页面并返回新的交互观察；用于多标签检索和比对，不能接管会话之外的浏览器标签",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.INTERNAL_STATE,
                30,
                80_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
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
        String pageId = BrowserToolSupport.requiredId(input, "page_id");
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("runtime_id", runtimeId);
        normalized.put("session_id", sessionId);
        normalized.put("page_id", pageId);
        return new PreparedOperation(
                normalized,
                "将 BrowserSession " + sessionId + " 的活动页切换为 "
                        + pageId + " 并重新观察；不改变网页业务数据",
                List.of(new ResourceClaim(
                        "browser_session",
                        runtimeId + "/" + sessionId,
                        pageId
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
        return ToolOutcome.succeeded(client.switchPage(
                input.path("runtime_id").asText(),
                input.path("session_id").asText(),
                input.path("page_id").asText()
        ));
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode output = outcome.output();
        String requested = operation.normalizedInput().path("page_id").asText();
        String actual = output.path("activePageId").asText();
        String observationRef = output.path("observation").path("ref").asText();
        if (!requested.equals(actual) || observationRef.isBlank()) {
            return new VerificationResult(
                    VerificationResult.Status.FAILED,
                    List.of(),
                    "daemon 未确认目标页面成为活动页"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "browser_active_page",
                        actual,
                        "目标页面已成为活动页，并形成新观察 " + observationRef
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("runtime_id").put("type", "string")
                .put("description", "可选定向 Runtime ID；默认 Runtime 由 Backend 解析");
        properties.putObject("session_id").put("type", "string")
                .put("description", "list_browser_sessions 返回的 BrowserSession ID");
        properties.putObject("page_id").put("type", "string")
                .put("description", "同一 Session 的 pages 中要切换到的 Page ID");
        schema.putArray("required").add("session_id").add("page_id");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("sessionId").put("type", "string")
                .put("description", "发生页面切换的 BrowserSession ID");
        properties.putObject("pageId").put("type", "string")
                .put("description", "请求切换到的 BrowserPage ID");
        properties.putObject("activePageId").put("type", "string")
                .put("description", "切换后活动 Page ID");
        properties.putObject("pages").put("type", "array")
                .put("description", "Session 当前拥有的页面摘要");
        properties.set(
                "observation",
                BrowserToolSupport.browserObservationSchema(objectMapper)
        );
        schema.putArray("required")
                .add("sessionId").add("pageId").add("activePageId")
                .add("pages").add("observation");
        return schema;
    }
}
