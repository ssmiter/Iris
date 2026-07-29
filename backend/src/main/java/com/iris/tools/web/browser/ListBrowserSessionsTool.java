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
public class ListBrowserSessionsTool implements Tool {

    private final ObjectMapper objectMapper;
    private final BrowserRuntimeService runtimeService;
    private final WebBridgeClient client;
    private final ToolManifest manifest;

    public ListBrowserSessionsTool(
            ObjectMapper objectMapper,
            BrowserRuntimeService runtimeService,
            WebBridgeClient client
    ) {
        this.objectMapper = objectMapper;
        this.runtimeService = runtimeService;
        this.client = client;
        this.manifest = new ToolManifest(
                "iris.web.browser.list_browser_sessions",
                "2",
                "list_browser_sessions",
                "列出指定浏览器运行时仍存活的短期会话与页面；需要继续已有网页任务或判断会话是否失效时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                12,
                16_000,
                ToolManifest.IdempotencySemantics.NON_IDEMPOTENT,
                ToolManifest.EvidencePolicy.SUMMARY,
                ToolManifest.ContextRetention.PINNED,
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
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("runtime_id", runtimeId);
        return new PreparedOperation(
                normalized,
                "读取 Runtime " + runtimeId
                        + " 的当前 BrowserSession 租约，不启动或改变页面",
                List.of(new ResourceClaim(
                        "browser_runtime",
                        runtimeId,
                        null
                )),
                Instant.now().plusSeconds(30)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        String runtimeId = operation.normalizedInput()
                .path("runtime_id").asText();
        JsonNode response = client.listSessions(runtimeId).deepCopy();
        if (response instanceof ObjectNode object) {
            object.put("runtimeId", runtimeId);
            object.put(
                    "guidance",
                    response.path("count").asInt(0) == 0
                            ? "当前没有存活会话；使用 open_browser_session 创建"
                            : "选择 sessionId/pageId 后调用 observe_browser_page；页面引用只在会话存活期间有效"
            );
        }
        return ToolOutcome.succeeded(response);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "browser_session_catalog",
                        operation.normalizedInput()
                                .path("runtime_id").asText(),
                        "daemon 已返回当前 BrowserSession 租约"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ((ObjectNode) schema.path("properties"))
                .putObject("runtime_id")
                .put("type", "string")
                .put("description", "可选定向 Runtime ID；默认 Runtime 会由 Backend 自动解析");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("runtimeId").put("type", "string")
                .put("description", "本次列举对应的 Browser Runtime ID");
        properties.putObject("sessions")
                .put("type", "array")
                .put("description", "仍存活的短期 Session/Page 引用");
        properties.putObject("count").put("type", "integer")
                .put("description", "仍存活的 BrowserSession 数量");
        properties.putObject("guidance").put("type", "string")
                .put("description", "复用或新建会话的简短提示");
        schema.putArray("required")
                .add("runtimeId").add("sessions")
                .add("count").add("guidance");
        return schema;
    }
}
