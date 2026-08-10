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

/** Sends one bounded keyboard primitive against the current observation. */
@Component
public class PressBrowserKeyTool implements Tool {
    private static final Set<String> ALLOWED_KEYS = Set.of(
            "Enter", "Escape", "Tab",
            "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
            "Home", "End", "PageUp", "PageDown",
            "Backspace", "Delete", "Space"
    );

    private final ObjectMapper objectMapper;
    private final BrowserRuntimeService runtimeService;
    private final WebBridgeClient client;
    private final ToolManifest manifest;

    public PressBrowserKeyTool(
            ObjectMapper objectMapper,
            BrowserRuntimeService runtimeService,
            WebBridgeClient client
    ) {
        this.objectMapper = objectMapper;
        this.runtimeService = runtimeService;
        this.client = client;
        this.manifest = new ToolManifest(
                "iris.web.browser.press_browser_key",
                "1",
                "press_browser_key",
                "在最近页面观察上向当前焦点或指定元素发送一个受限键盘键，并返回动作后观察；用于提交搜索、关闭弹窗、切换焦点和选择自动补全，不接受快捷键脚本或任意文本",
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
                    "按键前必须传入最近页面观察的 observation ref"
            );
        }
        String key = input.path("key").asText("").trim();
        if (!ALLOWED_KEYS.contains(key)) {
            throw new ToolRuntimeException(
                    "invalid_browser_key",
                    "key 只能是 Enter、Escape、Tab、方向/翻页键、Backspace、Delete 或 Space"
            );
        }
        String elementRef = BrowserToolSupport.optionalId(
                input,
                "element_ref"
        );
        String targetDescription = "页面当前焦点";
        if (elementRef != null) {
            JsonNode resolved = client.resolveElement(
                    runtimeId,
                    sessionId,
                    pageId,
                    observationRef,
                    elementRef
            );
            JsonNode element = resolved.path("element");
            if (element.path("disabled").asBoolean(false)) {
                throw new ToolRuntimeException(
                        "browser_element_disabled",
                        "指定元素当前不可接收按键"
                );
            }
            targetDescription = describe(element, elementRef);
        }

        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("runtime_id", runtimeId);
        normalized.put("session_id", sessionId);
        normalized.put("page_id", pageId);
        normalized.put("observation_ref", observationRef);
        normalized.put("key", key);
        if (elementRef != null) {
            normalized.put("element_ref", elementRef);
        }
        normalized.put("target_description", targetDescription);
        return new PreparedOperation(
                normalized,
                "将在 BrowserSession " + sessionId + " 中向"
                        + targetDescription + "发送按键 " + key
                        + "；按键可能触发搜索、导航或表单动作，仅当页面仍处于观察 "
                        + observationRef + " 时执行",
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
                    "cancelled_before_browser_key",
                    "任务已停止，按键尚未发送"
            );
        }
        JsonNode input = operation.normalizedInput();
        JsonNode response = client.press(
                input.path("runtime_id").asText(),
                input.path("session_id").asText(),
                input.path("page_id").asText(),
                input.path("observation_ref").asText(),
                input.path("element_ref").asText(null),
                input.path("key").asText(),
                operation.executionId()
        );
        return switch (response.path("status").asText()) {
            case "applied" -> ToolOutcome.succeeded(response);
            case "not_applied" -> ToolOutcome.failed(
                    "browser_action_not_applied",
                    response.path("message").asText(
                            "页面或焦点状态已变化；按键未发送，请重新观察"
                    )
            );
            case "outcome_unknown" -> ToolOutcome.unknown(
                    "browser_action_outcome_unknown",
                    response.path("message").asText(
                            "daemon 无法证明按键动作是否生效"
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
        JsonNode evidence = outcome.output().path("evidence");
        JsonNode observation = outcome.output().path("observation");
        if (evidence.path("ref").asText().isBlank()
                || observation.path("ref").asText().isBlank()) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "daemon 返回 applied，但缺少按键证据或动作后页面观察"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "browser_key_press",
                        evidence.path("ref").asText(),
                        evidence.path("summary").asText(
                                "受限键盘动作已发送并重新观察页面"
                        )
                ),
                new VerificationResult.Evidence(
                        "browser_page_observation",
                        observation.path("ref").asText(),
                        "按键后页面状态已重新观察"
                )
        ));
    }

    private String describe(JsonNode element, String fallback) {
        String name = element.path("name").asText("").trim();
        String tag = element.path("tag").asText("element");
        return name.isBlank()
                ? "页面元素 " + fallback + "（" + tag + "）"
                : "页面元素“" + name + "”（" + tag + "）";
    }

    private JsonNode inputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("runtime_id").put("type", "string")
                .put("description", "可选定向 Runtime ID；默认 Runtime 由 Backend 解析");
        properties.putObject("session_id").put("type", "string")
                .put("description", "当前短期 BrowserSession ID");
        properties.putObject("page_id").put("type", "string")
                .put("description", "当前 BrowserPage ID");
        properties.putObject("observation_ref").put("type", "string")
                .put("description", "最近页面观察 ref，用于阻止在旧页面状态上发送按键");
        ObjectNode key = properties.putObject("key");
        key.put("type", "string");
        var values = key.putArray("enum");
        List.of(
                "Enter", "Escape", "Tab",
                "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
                "Home", "End", "PageUp", "PageDown",
                "Backspace", "Delete", "Space"
        ).forEach(values::add);
        key.put("description", "一个受限键名；不接受组合键或任意文本");
        properties.putObject("element_ref").put("type", "string")
                .put("description", "可选；同一 observation 中先获得焦点再接收按键的元素 ref");
        schema.putArray("required")
                .add("session_id").add("page_id")
                .add("observation_ref").add("key");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("status").put("type", "string")
                .put("description", "applied / not_applied / outcome_unknown");
        properties.putObject("actionAttemptId").put("type", "string");
        properties.putObject("idempotencyKey").put("type", "string");
        properties.putObject("pageId").put("type", "string")
                .put("description", "动作后的当前 Page ID");
        properties.putObject("openedNewPage").put("type", "boolean")
                .put("description", "按键是否打开并接管了新页面");
        properties.set(
                "observation",
                BrowserToolSupport.browserObservationSchema(objectMapper)
        );
        properties.putObject("evidence").put("type", "object")
                .put("description", "按键派发与动作后状态证据");
        schema.putArray("required")
                .add("status").add("actionAttemptId")
                .add("idempotencyKey").add("pageId")
                .add("openedNewPage").add("observation").add("evidence");
        return schema;
    }
}
