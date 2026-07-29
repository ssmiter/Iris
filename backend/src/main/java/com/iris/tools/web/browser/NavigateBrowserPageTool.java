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
public class NavigateBrowserPageTool implements Tool {

    private final ObjectMapper objectMapper;
    private final BrowserRuntimeCatalog runtimes;
    private final BrowserRuntimeService runtimeService;
    private final WebBridgeClient client;
    private final ToolManifest manifest;

    public NavigateBrowserPageTool(
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
                "iris.web.browser.navigate_browser_page",
                "1",
                "navigate_browser_page",
                "让指定 BrowserPage 导航到一个网页，并在同一结果中返回动作状态、新页面观察与证据；需要打开链接时使用",
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
        String sessionId = BrowserToolSupport.requiredId(
                input,
                "session_id"
        );
        String pageId = BrowserToolSupport.requiredId(input, "page_id");
        String url = BrowserToolSupport.requiredUrl(input, "url");
        String expected = BrowserToolSupport.optionalObservationRef(
                input,
                "expected_observation_ref"
        );

        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("runtime_id", runtimeId);
        normalized.put("session_id", sessionId);
        normalized.put("page_id", pageId);
        normalized.put("url", url);
        if (expected != null) {
            normalized.put("expected_observation_ref", expected);
        }
        return new PreparedOperation(
                normalized,
                "将 BrowserSession " + sessionId + " 的页面 "
                        + pageId + " 导航到 " + url
                        + (expected == null
                        ? "；未声明页面观察水位线，daemon 仍会返回动作后观察"
                        : "；仅当页面仍处于观察 " + expected + " 时执行"),
                List.of(new ResourceClaim(
                        "browser_page",
                        runtimeId + "/" + sessionId + "/" + pageId,
                        expected
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
                    "cancelled_before_browser_navigation",
                    "任务已停止，页面尚未导航"
            );
        }
        JsonNode input = operation.normalizedInput();
        JsonNode response = client.navigate(
                input.path("runtime_id").asText(),
                input.path("session_id").asText(),
                input.path("page_id").asText(),
                input.path("url").asText(),
                input.path("expected_observation_ref").asText(null),
                operation.executionId()
        );
        String status = response.path("status").asText();
        if ("not_applied".equals(status)) {
            return ToolOutcome.failed(
                    "browser_action_not_applied",
                    response.path("message").asText(
                            "页面状态已经变化；动作未执行，请重新观察"
                    )
            );
        }
        if ("outcome_unknown".equals(status)) {
            return ToolOutcome.unknown(
                    "browser_action_outcome_unknown",
                    response.path("message").asText(
                            "daemon 无法证明页面动作是否生效"
                    )
            );
        }
        if (!"applied".equals(status)) {
            return ToolOutcome.failed(
                    "invalid_browser_action_status",
                    "Browser Runtime 返回了未知动作状态"
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
        JsonNode output = outcome.output();
        JsonNode observation = output.path("observation");
        JsonNode evidence = output.path("evidence");
        if (observation.path("ref").asText().isBlank()
                || evidence.path("ref").asText().isBlank()) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "导航已返回 applied，但缺少动作后 Observation 或 Evidence"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        evidence.path("kind").asText("browser_navigation"),
                        evidence.path("ref").asText(),
                        evidence.path("summary").asText(
                                "页面导航已由 daemon 验证"
                        )
                ),
                new VerificationResult.Evidence(
                        "browser_page_observation",
                        observation.path("ref").asText(),
                        "动作后页面为 " + observation.path("url").asText()
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("runtime_id").put("type", "string")
                .put("description", "list_browser_runtimes 返回的稳定 Runtime ID");
        properties.putObject("session_id").put("type", "string")
                .put("description", "当前短期 BrowserSession ID");
        properties.putObject("page_id").put("type", "string")
                .put("description", "当前 BrowserPage ID");
        properties.putObject("url").put("type", "string")
                .put("description", "目标 http/https URL 或 about:blank");
        properties.putObject("expected_observation_ref")
                .put("type", "string")
                .put("description", "建议传入最近一次页面观察 ref；页面变化时动作会安全地 not_applied");
        schema.putArray("required")
                .add("runtime_id").add("session_id")
                .add("page_id").add("url");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("status")
                .put("type", "string")
                .put("description", "applied / not_applied / outcome_unknown")
                .putArray("enum")
                .add("applied").add("not_applied")
                .add("outcome_unknown");
        properties.putObject("actionAttemptId").put("type", "string")
                .put("description", "本次导航尝试的稳定 ID");
        properties.putObject("idempotencyKey").put("type", "string")
                .put("description", "用于安全恢复导航结果的幂等键");
        properties.putObject("pageId").put("type", "string")
                .put("description", "导航后当前 BrowserPage ID");
        properties.putObject("openedNewPage").put("type", "boolean")
                .put("description", "导航是否接管了新页面");
        properties.set(
                "observation",
                BrowserToolSupport.browserObservationSchema(objectMapper)
        );
        properties.putObject("evidence")
                .put("type", "object")
                .put("description", "daemon 对动作效果的机器可读证据");
        schema.putArray("required")
                .add("status").add("actionAttemptId")
                .add("idempotencyKey").add("pageId")
                .add("openedNewPage").add("observation")
                .add("evidence");
        return schema;
    }
}
