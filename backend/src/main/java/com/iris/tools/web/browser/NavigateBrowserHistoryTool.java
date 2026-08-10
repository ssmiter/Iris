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

/** Moves through the active page's real navigation history. */
@Component
public class NavigateBrowserHistoryTool implements Tool {
    private static final Set<String> DIRECTIONS =
            Set.of("back", "forward", "reload");

    private final ObjectMapper objectMapper;
    private final BrowserRuntimeService runtimeService;
    private final WebBridgeClient client;
    private final ToolManifest manifest;

    public NavigateBrowserHistoryTool(
            ObjectMapper objectMapper,
            BrowserRuntimeService runtimeService,
            WebBridgeClient client
    ) {
        this.objectMapper = objectMapper;
        this.runtimeService = runtimeService;
        this.client = client;
        this.manifest = new ToolManifest(
                "iris.web.browser.navigate_browser_history",
                "1",
                "navigate_browser_history",
                "让当前 BrowserPage 按真实浏览历史后退、前进或刷新，并返回动作后观察；需要回到搜索结果、恢复前一页或刷新当前页时使用",
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
        String pageId = BrowserToolSupport.requiredId(input, "page_id");
        String observationRef = BrowserToolSupport.optionalObservationRef(
                input,
                "observation_ref"
        );
        if (observationRef == null) {
            throw new ToolRuntimeException(
                    "browser_observation_required",
                    "浏览历史动作前必须传入最近页面观察的 observation_ref"
            );
        }
        String direction = input.path("direction").asText("").trim();
        if (!DIRECTIONS.contains(direction)) {
            throw new ToolRuntimeException(
                    "invalid_browser_history_direction",
                    "direction 只能是 back、forward 或 reload"
            );
        }
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("runtime_id", runtimeId);
        normalized.put("session_id", sessionId);
        normalized.put("page_id", pageId);
        normalized.put("observation_ref", observationRef);
        normalized.put("direction", direction);
        return new PreparedOperation(
                normalized,
                "将在 BrowserSession " + sessionId + " 的当前页面执行“"
                        + directionLabel(direction) + "”；仅当页面仍处于观察 "
                        + observationRef + " 时执行，并返回新的页面观察",
                List.of(new ResourceClaim(
                        "browser_page",
                        runtimeId + "/" + sessionId + "/" + pageId,
                        observationRef
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
                    "cancelled_before_browser_history",
                    "任务已停止，浏览历史尚未改变"
            );
        }
        JsonNode input = operation.normalizedInput();
        JsonNode response = client.navigateHistory(
                input.path("runtime_id").asText(),
                input.path("session_id").asText(),
                input.path("page_id").asText(),
                input.path("observation_ref").asText(),
                input.path("direction").asText(),
                operation.executionId()
        );
        return BrowserToolSupport.actionOutcome(
                response,
                "browser_history_not_applied",
                "页面已变化或没有对应历史记录；历史动作未执行",
                "browser_history_outcome_unknown",
                "Browser Runtime 无法证明历史动作是否生效"
        );
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
                    "历史动作已返回 applied，但缺少动作后观察或证据"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "browser_history_navigation",
                        evidence.path("ref").asText(),
                        evidence.path("summary").asText(
                                "浏览器历史动作已执行"
                        )
                ),
                new VerificationResult.Evidence(
                        "browser_page_observation",
                        observation.path("ref").asText(),
                        "历史动作后页面为 " + observation.path("url").asText()
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("runtime_id").put("type", "string")
                .put("description", "可选定向 Runtime ID；默认 Runtime 由 Backend 解析");
        properties.putObject("session_id").put("type", "string")
                .put("description", "当前短期 BrowserSession ID");
        properties.putObject("page_id").put("type", "string")
                .put("description", "当前活动 BrowserPage ID");
        properties.putObject("observation_ref").put("type", "string")
                .put("description", "最近页面观察 ref；页面变化时动作安全地 not_applied");
        properties.putObject("direction").put("type", "string")
                .put("description", "back 后退、forward 前进、reload 刷新")
                .putArray("enum")
                .add("back").add("forward").add("reload");
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
                .put("description", "本次历史导航动作的稳定尝试 ID");
        properties.putObject("idempotencyKey").put("type", "string")
                .put("description", "用于防止重复导航的幂等键");
        properties.putObject("pageId").put("type", "string")
                .put("description", "历史导航后的当前 Page ID");
        properties.putObject("openedNewPage").put("type", "boolean")
                .put("description", "本次历史导航是否产生并接管了新页面");
        properties.set(
                "observation",
                BrowserToolSupport.browserObservationSchema(objectMapper)
        );
        properties.putObject("evidence").put("type", "object")
                .put("description", "历史导航动作及动作后页面状态的证据");
        schema.putArray("required")
                .add("status").add("actionAttemptId")
                .add("idempotencyKey").add("pageId")
                .add("openedNewPage").add("observation")
                .add("evidence");
        return schema;
    }

    private String directionLabel(String direction) {
        return switch (direction) {
            case "back" -> "后退";
            case "forward" -> "前进";
            case "reload" -> "刷新";
            default -> direction;
        };
    }
}
