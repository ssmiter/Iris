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

/**
 * 消费 Observation 内的短期元素引用，不让模型持有物理 selector。
 */
@Component
public class ClickBrowserElementTool implements Tool {

    private final ObjectMapper objectMapper;
    private final BrowserRuntimeCatalog runtimes;
    private final BrowserRuntimeService runtimeService;
    private final WebBridgeClient client;
    private final ToolManifest manifest;

    public ClickBrowserElementTool(
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
                "iris.web.browser.click_browser_element",
                "1",
                "click_browser_element",
                "点击最近页面观察中的一个可交互元素，并返回动作后页面观察与证据；只使用同一 observation 的 element_ref",
                inputSchema(),
                outputSchema(),
                RiskLevel.ELEVATED,
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
        String observationRef =
                BrowserToolSupport.optionalObservationRef(
                        input,
                        "observation_ref"
                );
        if (observationRef == null) {
            throw new ToolRuntimeException(
                    "browser_observation_required",
                    "点击前必须传入最近 observe_browser_page 返回的 observation ref"
            );
        }
        String elementRef = BrowserToolSupport.requiredId(
                input,
                "element_ref"
        );
        JsonNode resolved = client.resolveElement(
                runtimeId,
                sessionId,
                pageId,
                observationRef,
                elementRef
        );
        JsonNode element = resolved.path("element");
        String elementName = describe(element, elementRef);
        if (element.path("disabled").asBoolean(false)) {
            throw new ToolRuntimeException(
                    "browser_element_disabled",
                    "页面元素当前不可点击：" + elementName
            );
        }

        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("runtime_id", runtimeId);
        normalized.put("session_id", sessionId);
        normalized.put("page_id", pageId);
        normalized.put("observation_ref", observationRef);
        normalized.put("element_ref", elementRef);
        normalized.put("element_description", elementName);
        return new PreparedOperation(
                normalized,
                "将在 BrowserSession " + sessionId + " 中点击"
                        + elementName + "；仅当页面仍处于观察 "
                        + observationRef + " 时执行，动作后重新观察页面",
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
                    "cancelled_before_browser_click",
                    "任务已停止，页面元素尚未点击"
            );
        }
        JsonNode input = operation.normalizedInput();
        JsonNode response = client.click(
                input.path("runtime_id").asText(),
                input.path("session_id").asText(),
                input.path("page_id").asText(),
                input.path("observation_ref").asText(),
                input.path("element_ref").asText(),
                operation.executionId()
        );
        return actionOutcome(response);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode output = outcome.output();
        JsonNode evidence = output.path("evidence");
        JsonNode observation = output.path("observation");
        if (evidence.path("ref").asText().isBlank()
                || observation.path("ref").asText().isBlank()) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "daemon 返回 applied，但缺少点击证据或动作后页面观察"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "browser_click",
                        evidence.path("ref").asText(),
                        evidence.path("summary").asText(
                                "浏览器已向目标元素派发点击"
                        )
                ),
                new VerificationResult.Evidence(
                        "browser_page_observation",
                        observation.path("ref").asText(),
                        evidence.path("stateChanged").asBoolean(false)
                                ? "点击后页面可观察状态已变化"
                                : "点击已派发；页面可观察状态没有明显变化"
                )
        ));
    }

    private ToolOutcome actionOutcome(JsonNode response) {
        return switch (response.path("status").asText()) {
            case "applied" -> ToolOutcome.succeeded(response);
            case "not_applied" -> ToolOutcome.failed(
                    "browser_action_not_applied",
                    response.path("message").asText(
                            "页面或元素状态已变化；点击未执行，请重新观察"
                    )
            );
            case "outcome_unknown" -> ToolOutcome.unknown(
                    "browser_action_outcome_unknown",
                    response.path("message").asText(
                            "daemon 无法证明点击是否生效"
                    )
            );
            default -> ToolOutcome.failed(
                    "invalid_browser_action_status",
                    "Browser Runtime 返回了未知动作状态"
            );
        };
    }

    private String describe(JsonNode element, String fallback) {
        String name = element.path("name").asText("").trim();
        String tag = element.path("tag").asText("element");
        String role = element.path("role").asText("").trim();
        String type = element.path("type").asText("").trim();
        StringBuilder description = new StringBuilder("页面元素");
        if (!name.isBlank()) {
            description.append("“").append(name).append("”");
        } else {
            description.append(" ").append(fallback);
        }
        description.append("（").append(tag);
        if (!role.isBlank()) {
            description.append(", role=").append(role);
        }
        if (!type.isBlank()) {
            description.append(", type=").append(type);
        }
        return description.append("）").toString();
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
        properties.putObject("observation_ref").put("type", "string")
                .put("description", "最近页面观察的 ref；用于阻止在已变化页面上误点");
        properties.putObject("element_ref").put("type", "string")
                .put("description", "同一 observation.elements 中的短期 ref，如 e3");
        schema.putArray("required")
                .add("runtime_id").add("session_id").add("page_id")
                .add("observation_ref").add("element_ref");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("status").put("type", "string")
                .put("description", "applied / not_applied / outcome_unknown");
        properties.putObject("actionAttemptId").put("type", "string")
                .put("description", "本次动作尝试的稳定 ID");
        properties.putObject("idempotencyKey").put("type", "string")
                .put("description", "用于安全恢复动作结果的幂等键");
        properties.putObject("pageId").put("type", "string")
                .put("description", "动作后当前 Page ID；新标签打开时会变化");
        properties.putObject("openedNewPage").put("type", "boolean")
                .put("description", "点击是否打开并接管了新页面");
        properties.set(
                "observation",
                BrowserToolSupport.browserObservationSchema(objectMapper)
        );
        properties.putObject("evidence")
                .put("type", "object")
                .put("description", "点击派发与页面状态变化证据");
        schema.putArray("required")
                .add("status").add("actionAttemptId")
                .add("idempotencyKey").add("pageId")
                .add("openedNewPage").add("observation")
                .add("evidence");
        return schema;
    }
}
