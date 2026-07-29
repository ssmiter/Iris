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
import com.iris.webbridge.WebBridgeClient;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

@Component
public class ObserveBrowserPageTool implements Tool {

    private static final int DEFAULT_TEXT = 24_000;
    private static final int MAX_TEXT = 80_000;
    private static final int DEFAULT_ELEMENTS = 160;
    private static final int MAX_ELEMENTS = 500;

    private final ObjectMapper objectMapper;
    private final BrowserRuntimeCatalog runtimes;
    private final WebBridgeClient client;
    private final ToolManifest manifest;

    public ObserveBrowserPageTool(
            ObjectMapper objectMapper,
            BrowserRuntimeCatalog runtimes,
            WebBridgeClient client
    ) {
        this.objectMapper = objectMapper;
        this.runtimes = runtimes;
        this.client = client;
        this.manifest = new ToolManifest(
                "iris.web.browser.observe_browser_page",
                "1",
                "observe_browser_page",
                "观察存活浏览器页面的标题、正文与可交互元素，返回本 revision 内可用的短期元素引用；操作前或页面变化后使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                50,
                80_000,
                ToolManifest.IdempotencySemantics.NON_IDEMPOTENT,
                ToolManifest.EvidencePolicy.SUMMARY,
                ToolManifest.ContextRetention.REFETCHABLE,
                ToolManifest.ConcurrencySemantics.SERIAL,
                ToolManifest.CancellationSemantics.COOPERATIVE
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
        String sessionId = BrowserToolSupport.requiredId(
                input,
                "session_id"
        );
        String pageId = BrowserToolSupport.optionalId(input, "page_id");
        int maxText = BrowserToolSupport.bounded(
                input,
                "max_text_characters",
                DEFAULT_TEXT,
                1_000,
                MAX_TEXT
        );
        int maxElements = BrowserToolSupport.bounded(
                input,
                "max_elements",
                DEFAULT_ELEMENTS,
                1,
                MAX_ELEMENTS
        );
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("runtime_id", runtimeId);
        normalized.put("session_id", sessionId);
        if (pageId != null) {
            normalized.put("page_id", pageId);
        }
        normalized.put("max_text_characters", maxText);
        normalized.put("max_elements", maxElements);
        return new PreparedOperation(
                normalized,
                "观察 BrowserSession " + sessionId
                        + " 的页面状态，最多读取 " + maxText
                        + " 个正文字符和 " + maxElements
                        + " 个交互元素，不改变页面",
                List.of(new ResourceClaim(
                        "browser_session",
                        runtimeId + "/" + sessionId,
                        null
                )),
                Instant.now().plusSeconds(45)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode input = operation.normalizedInput();
        JsonNode output = client.observe(
                input.path("runtime_id").asText(),
                input.path("session_id").asText(),
                input.path("page_id").asText(null),
                input.path("max_text_characters").asInt(),
                input.path("max_elements").asInt()
        );
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode observation = outcome.output().path("observation");
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "browser_page_observation",
                        observation.path("ref").asText(),
                        "已观察 " + observation.path("url").asText()
                                + "；元素引用属于 revision "
                                + observation.path("revision").asLong()
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("runtime_id").put("type", "string")
                .put("description", "稳定 Browser Runtime ID");
        properties.putObject("session_id").put("type", "string")
                .put("description", "open/list_browser_sessions 返回的短期 Session ID");
        properties.putObject("page_id").put("type", "string")
                .put("description", "可选 Page ID；省略时观察会话当前页");
        properties.putObject("max_text_characters")
                .put("type", "integer").put("minimum", 1_000)
                .put("maximum", MAX_TEXT)
                .put("description", "页面正文预算，默认 24000");
        properties.putObject("max_elements")
                .put("type", "integer").put("minimum", 1)
                .put("maximum", MAX_ELEMENTS)
                .put("description", "交互元素预算，默认 160");
        schema.putArray("required")
                .add("runtime_id").add("session_id");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("sessionId").put("type", "string")
                .put("description", "当前短期 BrowserSession ID");
        properties.putObject("pageId").put("type", "string")
                .put("description", "本次观察对应的 BrowserPage ID");
        properties.set(
                "observation",
                BrowserToolSupport.browserObservationSchema(objectMapper)
        );
        schema.putArray("required")
                .add("sessionId").add("pageId").add("observation");
        return schema;
    }
}
