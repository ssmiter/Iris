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
import com.iris.webbridge.BrowserRuntimeCatalog;
import com.iris.webbridge.BrowserRuntimeService;
import com.iris.webbridge.WebBridgeClient;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

@Component
public class OpenBrowserSessionTool implements Tool {

    private final ObjectMapper objectMapper;
    private final BrowserRuntimeCatalog runtimes;
    private final BrowserRuntimeService runtimeService;
    private final WebBridgeClient client;
    private final ToolManifest manifest;

    public OpenBrowserSessionTool(
            ObjectMapper objectMapper,
            BrowserRuntimeCatalog runtimes,
            BrowserRuntimeService runtimeService,
            WebBridgeClient client
    ) {
        this.objectMapper = objectMapper;
        this.runtimes = runtimes;
        this.runtimeService = runtimeService;
        this.client = client;
        this.manifest = new ToolManifest(
                "iris.web.browser.open_browser_session",
                "1",
                "open_browser_session",
                "在本机 Browser Runtime 中创建一个可见、短期的浏览器会话并返回首份页面观察；需要开始新的网页任务时使用",
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
        String runtimeId = BrowserToolSupport.requiredId(
                input,
                "runtime_id"
        );
        runtimes.require(runtimeId);
        runtimeService.requireAvailable(runtimeId);
        String url = BrowserToolSupport.optionalUrl(input, "url");
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("runtime_id", runtimeId);
        if (url != null) {
            normalized.put("url", url);
        }
        return new PreparedOperation(
                normalized,
                url == null
                        ? "将在本机 Runtime " + runtimeId
                        + " 创建一个可见浏览器会话并打开空白页"
                        : "将在本机 Runtime " + runtimeId
                        + " 创建一个可见浏览器会话并打开 " + url,
                List.of(new ResourceClaim(
                        "browser_runtime",
                        runtimeId,
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
            throw com.iris.tools.core.ToolRuntimeException.beforeCommit(
                    "cancelled_before_browser_session",
                    "任务已停止，尚未创建 BrowserSession"
            );
        }
        JsonNode input = operation.normalizedInput();
        JsonNode output = client.openSession(
                input.path("runtime_id").asText(),
                input.path("url").asText(null)
        );
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode output = outcome.output();
        JsonNode observation = output.path("observation");
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "browser_session",
                        output.path("sessionId").asText(),
                        "daemon 已创建短期 BrowserSession 与 Page"
                ),
                new VerificationResult.Evidence(
                        "browser_page_observation",
                        observation.path("ref").asText(),
                        "新页面已返回首份观察："
                                + observation.path("url").asText()
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("runtime_id").put("type", "string")
                .put("description", "list_browser_runtimes 返回且 available=true 的 Runtime ID");
        properties.putObject("url").put("type", "string")
                .put("description", "可选初始 http/https URL；省略时打开 about:blank");
        schema.putArray("required").add("runtime_id");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("sessionId").put("type", "string")
                .put("description", "新建短期 BrowserSession ID");
        properties.putObject("pageId").put("type", "string")
                .put("description", "会话当前 BrowserPage ID");
        properties.putObject("createdAt").put("type", "string")
                .put("description", "会话创建时间");
        properties.set(
                "observation",
                BrowserToolSupport.browserObservationSchema(objectMapper)
        );
        schema.putArray("required")
                .add("sessionId").add("pageId")
                .add("createdAt").add("observation");
        return schema;
    }
}
