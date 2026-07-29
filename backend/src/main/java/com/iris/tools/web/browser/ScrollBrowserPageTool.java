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
import java.util.Set;

@Component
public class ScrollBrowserPageTool implements Tool {

    private static final Set<String> DIRECTIONS =
            Set.of("up", "down", "top", "bottom");

    private final ObjectMapper objectMapper;
    private final BrowserRuntimeService runtimeService;
    private final WebBridgeClient client;
    private final ToolManifest manifest;

    public ScrollBrowserPageTool(
            ObjectMapper objectMapper,
            BrowserRuntimeService runtimeService,
            WebBridgeClient client
    ) {
        this.objectMapper = objectMapper;
        this.runtimeService = runtimeService;
        this.client = client;
        this.manifest = new ToolManifest(
                "iris.web.browser.scroll_browser_page",
                "1",
                "scroll_browser_page",
                "移动当前 BrowserPage 的视口并返回滚动后的页面观察；用于查看当前视口之外的内容和交互元素",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                30,
                80_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT_WITH_KEY,
                ToolManifest.EvidencePolicy.REQUIRED,
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
    public PreparedOperation prepare(
            JsonNode input,
            ToolContext context
    ) {
        String runtimeId = runtimeService.resolveAvailable(
                BrowserToolSupport.optionalId(input, "runtime_id")
        );
        String sessionId = BrowserToolSupport.requiredId(
                input,
                "session_id"
        );
        String pageId = BrowserToolSupport.requiredId(input, "page_id");
        String observationRef =
                BrowserToolSupport.optionalObservationRef(
                        input,
                        "observation_ref"
                );
        if (observationRef == null) {
            throw new ToolRuntimeException(
                    "browser_observation_required",
                    "滚动前必须传入最近一次页面观察的 observation_ref"
            );
        }
        String direction = input.path("direction").asText("").trim();
        if (!DIRECTIONS.contains(direction)) {
            throw new ToolRuntimeException(
                    "invalid_browser_scroll_direction",
                    "direction 必须是 up、down、top 或 bottom"
            );
        }
        int amount = BrowserToolSupport.bounded(
                input,
                "amount",
                800,
                100,
                5_000
        );

        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("runtime_id", runtimeId);
        normalized.put("session_id", sessionId);
        normalized.put("page_id", pageId);
        normalized.put("observation_ref", observationRef);
        normalized.put("direction", direction);
        normalized.put("amount", amount);
        return new PreparedOperation(
                normalized,
                "从页面观察 " + observationRef + " 向"
                        + directionLabel(direction)
                        + ("up".equals(direction)
                        || "down".equals(direction)
                        ? "滚动约 " + amount + " 像素"
                        : "滚动")
                        + "；只改变本机会话视口并返回新观察",
                List.of(new ResourceClaim(
                        "browser_page",
                        runtimeId + "/" + sessionId + "/" + pageId,
                        observationRef
                )),
                Instant.now().plusSeconds(90)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_browser_scroll",
                    "任务已停止，页面视口尚未滚动"
            );
        }
        JsonNode input = operation.normalizedInput();
        JsonNode response = client.scroll(
                input.path("runtime_id").asText(),
                input.path("session_id").asText(),
                input.path("page_id").asText(),
                input.path("observation_ref").asText(),
                input.path("direction").asText(),
                input.path("amount").asInt(),
                operation.executionId()
        );
        return switch (response.path("status").asText()) {
            case "applied" -> ToolOutcome.succeeded(response);
            case "not_applied" -> ToolOutcome.failed(
                    "browser_action_not_applied",
                    response.path("message").asText(
                            "页面状态已经变化；滚动未执行，请重新观察"
                    )
            );
            case "outcome_unknown" -> ToolOutcome.unknown(
                    "browser_action_outcome_unknown",
                    response.path("message").asText(
                            "daemon 无法证明页面视口是否已经滚动"
                    )
            );
            default -> ToolOutcome.failed(
                    "invalid_browser_action_status",
                    "Browser Runtime 返回了未知动作状态"
            );
        };
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
                    "滚动已返回 applied，但缺少新 Observation 或 Evidence"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "browser_scroll",
                        evidence.path("ref").asText(),
                        evidence.path("summary").asText(
                                "页面视口已经滚动"
                        )
                ),
                new VerificationResult.Evidence(
                        "browser_page_observation",
                        observation.path("ref").asText(),
                        "滚动后视口位置为 "
                                + observation.path("viewport")
                                .path("scrollY").asInt()
                                + "px"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("runtime_id").put("type", "string")
                .put("description", "可选定向 Runtime ID；默认 Runtime 由 Backend 自动解析");
        properties.putObject("session_id").put("type", "string")
                .put("description", "当前短期 BrowserSession ID");
        properties.putObject("page_id").put("type", "string")
                .put("description", "当前 BrowserPage ID");
        properties.putObject("observation_ref").put("type", "string")
                .put("description", "最近一次页面观察 ref；页面已变化时滚动会安全地 not_applied");
        properties.putObject("direction").put("type", "string")
                .put("description", "滚动方向：up、down、top 或 bottom")
                .putArray("enum")
                .add("up").add("down").add("top").add("bottom");
        properties.putObject("amount").put("type", "integer")
                .put("minimum", 100).put("maximum", 5_000)
                .put("description", "up/down 的像素距离，默认 800；top/bottom 时忽略");
        schema.putArray("required")
                .add("session_id").add("page_id")
                .add("observation_ref").add("direction");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("status").put("type", "string")
                .put("description", "applied / not_applied / outcome_unknown");
        properties.putObject("actionAttemptId").put("type", "string")
                .put("description", "本次滚动尝试的稳定 ID");
        properties.putObject("idempotencyKey").put("type", "string")
                .put("description", "用于安全恢复滚动结果的幂等键");
        properties.putObject("pageId").put("type", "string")
                .put("description", "滚动后的当前 BrowserPage ID");
        properties.putObject("openedNewPage").put("type", "boolean")
                .put("description", "滚动不会打开新页面，固定为 false");
        properties.set(
                "observation",
                BrowserToolSupport.browserObservationSchema(objectMapper)
        );
        properties.putObject("evidence").put("type", "object")
                .put("description", "滚动前后视口变化的机器可读证据");
        schema.putArray("required")
                .add("status").add("actionAttemptId")
                .add("idempotencyKey").add("pageId")
                .add("openedNewPage").add("observation")
                .add("evidence");
        return schema;
    }

    private String directionLabel(String direction) {
        return switch (direction) {
            case "up" -> "上";
            case "down" -> "下";
            case "top" -> "页面顶部";
            case "bottom" -> "页面底部";
            default -> direction;
        };
    }
}
