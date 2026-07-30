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

@Component
public class ObserveBrowserPageTool implements Tool {

    private static final int DEFAULT_INTERACTION_TEXT = 8_000;
    private static final int DEFAULT_READING_TEXT = 24_000;
    private static final int MAX_TEXT = 80_000;
    private static final int DEFAULT_INTERACTION_ELEMENTS = 160;
    private static final int DEFAULT_READING_ELEMENTS = 40;
    private static final int DEFAULT_SEARCH_ELEMENTS = 80;
    private static final int MAX_ELEMENTS = 500;
    private static final int DEFAULT_SEARCH_MATCHES = 20;
    private static final int MAX_SEARCH_MATCHES = 50;

    private final ObjectMapper objectMapper;
    private final BrowserRuntimeService runtimeService;
    private final WebBridgeClient client;
    private final ToolManifest manifest;

    public ObserveBrowserPageTool(
            ObjectMapper objectMapper,
            BrowserRuntimeService runtimeService,
            WebBridgeClient client
    ) {
        this.objectMapper = objectMapper;
        this.runtimeService = runtimeService;
        this.client = client;
        this.manifest = new ToolManifest(
                "iris.web.browser.observe_browser_page",
                "3",
                "observe_browser_page",
                "按交互、页面搜索或阅读目的观察存活页面；返回有界事实和本 revision 内可用的短期元素引用",
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
        String runtimeId = runtimeService.resolveAvailable(
                BrowserToolSupport.optionalId(input, "runtime_id")
        );
        String sessionId = BrowserToolSupport.requiredId(
                input,
                "session_id"
        );
        String pageId = BrowserToolSupport.optionalId(input, "page_id");
        String purpose = input.path("purpose").asText("interact");
        if (!"interact".equals(purpose)
                && !"search".equals(purpose)
                && !"read".equals(purpose)) {
            throw new com.iris.tools.core.ToolRuntimeException(
                    "invalid_browser_observation_purpose",
                    "purpose 必须是 interact、search 或 read"
            );
        }
        String searchQuery = null;
        if ("search".equals(purpose)) {
            searchQuery = input.path("search_query").asText("").trim();
            if (searchQuery.isBlank() || searchQuery.length() > 500) {
                throw new com.iris.tools.core.ToolRuntimeException(
                        "invalid_browser_search_query",
                        "purpose=search 时 search_query 必须为 1 到 500 个字符"
                );
            }
        }
        int maxText = BrowserToolSupport.bounded(
                input,
                "max_text_characters",
                "read".equals(purpose)
                        ? DEFAULT_READING_TEXT
                        : DEFAULT_INTERACTION_TEXT,
                1_000,
                MAX_TEXT
        );
        int maxElements = BrowserToolSupport.bounded(
                input,
                "max_elements",
                "read".equals(purpose)
                        ? DEFAULT_READING_ELEMENTS
                        : "search".equals(purpose)
                        ? DEFAULT_SEARCH_ELEMENTS
                        : DEFAULT_INTERACTION_ELEMENTS,
                1,
                MAX_ELEMENTS
        );
        int maxMatches = BrowserToolSupport.bounded(
                input,
                "max_matches",
                DEFAULT_SEARCH_MATCHES,
                1,
                MAX_SEARCH_MATCHES
        );
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("runtime_id", runtimeId);
        normalized.put("session_id", sessionId);
        if (pageId != null) {
            normalized.put("page_id", pageId);
        }
        normalized.put("purpose", purpose);
        if (searchQuery != null) {
            normalized.put("search_query", searchQuery);
        }
        normalized.put("max_text_characters", maxText);
        normalized.put("max_elements", maxElements);
        normalized.put("max_matches", maxMatches);
        return new PreparedOperation(
                normalized,
                "观察 BrowserSession " + sessionId
                        + " 的" + switch (purpose) {
                    case "read" -> "阅读";
                    case "search" -> "页面搜索";
                    default -> "交互";
                }
                        + "状态，最多读取 " + maxText
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
                input.path("purpose").asText(),
                input.path("search_query").asText(null),
                input.path("max_text_characters").asInt(),
                input.path("max_elements").asInt(),
                input.path("max_matches").asInt()
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
                .put("description", "可选定向 Runtime ID；默认 Runtime 会由 Backend 自动解析");
        properties.putObject("session_id").put("type", "string")
                .put("description", "open/list_browser_sessions 返回的短期 Session ID");
        properties.putObject("page_id").put("type", "string")
                .put("description", "可选 Page ID；省略时观察会话当前页");
        properties.putObject("purpose")
                .put("type", "string")
                .putArray("enum").add("interact").add("search").add("read");
        ((ObjectNode) properties.path("purpose")).put(
                "description",
                "interact（默认）用于定位和操作；search 查找页面关键词；read 按预算阅读正文"
        );
        properties.putObject("search_query")
                .put("type", "string").put("maxLength", 500)
                .put("description", "purpose=search 时必填；在当前页面正文和元素语义中查找");
        properties.putObject("max_text_characters")
                .put("type", "integer").put("minimum", 1_000)
                .put("maximum", MAX_TEXT)
                .put("description", "文字预算；interact 默认 8000，read 默认 24000");
        properties.putObject("max_elements")
                .put("type", "integer").put("minimum", 1)
                .put("maximum", MAX_ELEMENTS)
                .put("description", "元素预算；interact 默认 160，search 默认 80，read 默认 40");
        properties.putObject("max_matches")
                .put("type", "integer").put("minimum", 1)
                .put("maximum", MAX_SEARCH_MATCHES)
                .put("description", "search 命中片段预算，默认 20");
        schema.putArray("required")
                .add("session_id");
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
