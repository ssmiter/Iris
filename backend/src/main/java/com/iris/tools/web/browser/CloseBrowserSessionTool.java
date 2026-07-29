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
import com.iris.webbridge.BrowserRuntimeCatalog;
import com.iris.webbridge.BrowserRuntimeService;
import com.iris.webbridge.WebBridgeClient;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

@Component
public class CloseBrowserSessionTool implements Tool {

    private final ObjectMapper objectMapper;
    private final BrowserRuntimeCatalog runtimes;
    private final BrowserRuntimeService runtimeService;
    private final WebBridgeClient client;
    private final ToolManifest manifest;

    public CloseBrowserSessionTool(
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
                "iris.web.browser.close_browser_session",
                "1",
                "close_browser_session",
                "关闭一个短期 BrowserSession 并释放其页面与 CDP handle；网页任务完成且不再需要人工接管时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.EXTERNAL_WRITE,
                30,
                4_000,
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
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String runtimeId = BrowserToolSupport.requiredId(
                input,
                "runtime_id"
        );
        runtimes.require(runtimeId);
        runtimeService.requireAvailable(runtimeId);
        String sessionId = BrowserToolSupport.requiredId(
                input,
                "session_id"
        );
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("runtime_id", runtimeId);
        normalized.put("session_id", sessionId);
        return new PreparedOperation(
                normalized,
                "将关闭短期 BrowserSession " + sessionId
                        + " 并释放其页面；已持久化的观察和工具历史不受影响",
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
                    "cancelled_before_browser_session_close",
                    "任务已停止，BrowserSession 尚未关闭"
            );
        }
        JsonNode input = operation.normalizedInput();
        JsonNode response = client.closeSession(
                input.path("runtime_id").asText(),
                input.path("session_id").asText()
        );
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
                        "browser_session_closed",
                        outcome.output().path("sessionId").asText(),
                        outcome.output().path("alreadyAbsent")
                                .asBoolean(false)
                                ? "Session 先前已经失效；目标状态仍是 closed"
                                : "daemon 已移除 Session 并关闭对应 Page handle"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("runtime_id").put("type", "string")
                .put("description", "list_browser_runtimes 返回的稳定 Runtime ID");
        properties.putObject("session_id").put("type", "string")
                .put("description", "要关闭的短期 BrowserSession ID");
        schema.putArray("required")
                .add("runtime_id").add("session_id");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("closed").put("type", "boolean")
                .put("description", "本次调用是否关闭了仍存活的会话");
        properties.putObject("alreadyAbsent").put("type", "boolean")
                .put("description", "会话在调用前是否已经不存在");
        properties.putObject("sessionId").put("type", "string")
                .put("description", "被请求关闭的 BrowserSession ID");
        schema.putArray("required")
                .add("closed").add("alreadyAbsent").add("sessionId");
        return schema;
    }
}
