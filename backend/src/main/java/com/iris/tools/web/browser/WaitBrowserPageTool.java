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
import com.iris.webbridge.WebBridgeClient;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;
import java.util.Set;

@Component
public class WaitBrowserPageTool implements Tool {

    private static final Set<String> CONDITIONS =
            Set.of("change", "ready", "text");

    private final ObjectMapper objectMapper;
    private final BrowserRuntimeCatalog runtimes;
    private final WebBridgeClient client;
    private final ToolManifest manifest;

    public WaitBrowserPageTool(
            ObjectMapper objectMapper,
            BrowserRuntimeCatalog runtimes,
            WebBridgeClient client
    ) {
        this.objectMapper = objectMapper;
        this.runtimes = runtimes;
        this.client = client;
        this.manifest = new ToolManifest(
                "iris.web.browser.wait_browser_page",
                "1",
                "wait_browser_page",
                "等待页面变化、加载完成或出现指定文本，并只返回最终页面观察；动作触发异步 UI 时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                20,
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
        String runtimeId = BrowserToolSupport.requiredId(input, "runtime_id");
        runtimes.require(runtimeId);
        String sessionId = BrowserToolSupport.requiredId(input, "session_id");
        String pageId = BrowserToolSupport.requiredId(input, "page_id");
        String baseline = BrowserToolSupport.optionalObservationRef(
                input,
                "after_observation_ref"
        );
        if (baseline == null) {
            throw new ToolRuntimeException(
                    "browser_observation_required",
                    "等待必须以最近页面观察作为 after_observation_ref"
            );
        }
        String condition = input.path("condition").asText("change");
        if (!CONDITIONS.contains(condition)) {
            throw new ToolRuntimeException(
                    "invalid_browser_wait_condition",
                    "condition 只能是 change、ready 或 text"
            );
        }
        String text = input.hasNonNull("text")
                ? input.path("text").asText()
                : null;
        if ("text".equals(condition)
                && (text == null || text.isBlank())) {
            throw new ToolRuntimeException(
                    "invalid_browser_wait_text",
                    "condition=text 时必须提供非空 text"
            );
        }
        int timeoutMs = BrowserToolSupport.bounded(
                input,
                "timeout_ms",
                5_000,
                250,
                15_000
        );
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("runtime_id", runtimeId);
        normalized.put("session_id", sessionId);
        normalized.put("page_id", pageId);
        normalized.put("after_observation_ref", baseline);
        normalized.put("condition", condition);
        if (text != null) {
            normalized.put("text", text);
        }
        normalized.put("timeout_ms", timeoutMs);
        return new PreparedOperation(
                normalized,
                "在页面 " + pageId + " 上最多等待 "
                        + timeoutMs + "ms，条件为 " + condition
                        + "；只读取页面，不改变状态",
                List.of(new ResourceClaim(
                        "browser_page",
                        runtimeId + "/" + sessionId + "/" + pageId,
                        baseline
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
        if (context.cancelled()) {
            throw new ToolRuntimeException(
                    "tool_cancelled",
                    "页面等待已停止"
            );
        }
        return ToolOutcome.succeeded(client.waitForPage(
                input.path("runtime_id").asText(),
                input.path("session_id").asText(),
                input.path("page_id").asText(),
                input.path("after_observation_ref").asText(),
                input.path("condition").asText(),
                input.path("text").asText(null),
                input.path("timeout_ms").asInt()
        ));
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode output = outcome.output();
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "browser_wait",
                        output.path("observation").path("ref").asText(),
                        output.path("conditionMet").asBoolean(false)
                                ? "等待条件已满足，返回最终页面观察"
                                : "等待达到预算，返回当前页面观察；没有伪造条件成功"
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
        properties.putObject("after_observation_ref").put("type", "string")
                .put("description", "最近页面观察 ref，等待变化时作为水位线");
        properties.putObject("condition").put("type", "string")
                .put("description", "change / ready / text，默认 change");
        properties.putObject("text").put("type", "string")
                .put("description", "condition=text 时等待出现的精确文本片段");
        properties.putObject("timeout_ms").put("type", "integer")
                .put("minimum", 250).put("maximum", 15_000)
                .put("description", "等待预算，默认 5000ms");
        schema.putArray("required")
                .add("runtime_id").add("session_id").add("page_id")
                .add("after_observation_ref");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("sessionId").put("type", "string")
                .put("description", "当前短期 BrowserSession ID");
        properties.putObject("pageId").put("type", "string")
                .put("description", "等待结束时的 BrowserPage ID");
        properties.putObject("condition").put("type", "string")
                .put("description", "本次等待使用的规范化条件");
        properties.putObject("conditionMet").put("type", "boolean")
                .put("description", "条件是否在预算内满足");
        properties.putObject("waitedMs").put("type", "integer")
                .put("description", "实际等待毫秒数");
        properties.set(
                "observation",
                BrowserToolSupport.browserObservationSchema(objectMapper)
        );
        schema.putArray("required")
                .add("sessionId").add("pageId").add("condition")
                .add("conditionMet").add("waitedMs").add("observation");
        return schema;
    }
}
