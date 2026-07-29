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
import java.util.Locale;
import java.util.Set;

@Component
public class FillBrowserFieldTool implements Tool {

    private static final int MAX_VALUE_CHARACTERS = 20_000;
    private static final Set<String> SENSITIVE_OR_UNSUPPORTED_TYPES =
            Set.of(
                    "password", "file", "hidden", "checkbox",
                    "radio", "button", "submit", "reset", "image"
            );

    private final ObjectMapper objectMapper;
    private final BrowserRuntimeService runtimeService;
    private final WebBridgeClient client;
    private final ToolManifest manifest;

    public FillBrowserFieldTool(
            ObjectMapper objectMapper,
            BrowserRuntimeService runtimeService,
            WebBridgeClient client
    ) {
        this.objectMapper = objectMapper;
        this.runtimeService = runtimeService;
        this.client = client;
        this.manifest = new ToolManifest(
                "iris.web.browser.fill_browser_field",
                "2",
                "fill_browser_field",
                "填写当前页面观察中的普通文本字段，并重读值和页面状态；密码、文件及不可安全确认的字段会被拒绝",
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
                    "填写前必须传入最近页面观察的 observation ref"
            );
        }
        String elementRef = BrowserToolSupport.requiredId(
                input,
                "element_ref"
        );
        String value = requireValue(input);
        JsonNode resolved = client.resolveElement(
                runtimeId,
                sessionId,
                pageId,
                observationRef,
                elementRef
        );
        JsonNode element = resolved.path("element");
        String description = describe(element, elementRef);
        requireFillable(element, description);

        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("runtime_id", runtimeId);
        normalized.put("session_id", sessionId);
        normalized.put("page_id", pageId);
        normalized.put("observation_ref", observationRef);
        normalized.put("element_ref", elementRef);
        normalized.put("value", value);
        normalized.put("element_description", description);
        return new PreparedOperation(
                normalized,
                "将在 BrowserSession " + sessionId + " 中填写"
                        + description + "，内容为" + valuePreview(value)
                        + "；仅当页面仍处于观察 " + observationRef
                        + " 时执行，随后重读字段确认",
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
                    "cancelled_before_browser_fill",
                    "任务已停止，页面字段尚未填写"
            );
        }
        JsonNode input = operation.normalizedInput();
        JsonNode response = client.fill(
                input.path("runtime_id").asText(),
                input.path("session_id").asText(),
                input.path("page_id").asText(),
                input.path("observation_ref").asText(),
                input.path("element_ref").asText(),
                input.path("value").asText(),
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
                    "daemon 返回 applied，但缺少填写读回证据或动作后观察"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "browser_fill",
                        evidence.path("ref").asText(),
                        evidence.path("summary").asText(
                                "字段值已写入并从页面重读"
                        )
                ),
                new VerificationResult.Evidence(
                        "browser_page_observation",
                        observation.path("ref").asText(),
                        "填写后页面状态已重新观察"
                )
        ));
    }

    private ToolOutcome actionOutcome(JsonNode response) {
        return switch (response.path("status").asText()) {
            case "applied" -> ToolOutcome.succeeded(response);
            case "not_applied" -> ToolOutcome.failed(
                    "browser_action_not_applied",
                    response.path("message").asText(
                            "页面或字段状态已变化；填写未执行，请重新观察"
                    )
            );
            case "outcome_unknown" -> ToolOutcome.unknown(
                    "browser_action_outcome_unknown",
                    response.path("message").asText(
                            "daemon 无法证明字段填写是否生效"
                    )
            );
            default -> ToolOutcome.failed(
                    "invalid_browser_action_status",
                    "Browser Runtime 返回了未知动作状态"
            );
        };
    }

    private String requireValue(JsonNode input) {
        JsonNode value = input.get("value");
        if (value == null || !value.isTextual()) {
            throw new ToolRuntimeException(
                    "invalid_browser_field_value",
                    "value 必须是字符串；清空字段请传空字符串"
            );
        }
        String text = value.asText();
        if (text.length() > MAX_VALUE_CHARACTERS) {
            throw new ToolRuntimeException(
                    "invalid_browser_field_value",
                    "value 不能超过 " + MAX_VALUE_CHARACTERS + " 个字符"
            );
        }
        return text;
    }

    private void requireFillable(
            JsonNode element,
            String description
    ) {
        String tag = element.path("tag").asText("");
        String role = element.path("role").asText("");
        String type = element.path("type").asText("")
                .toLowerCase(Locale.ROOT);
        boolean editable = "input".equals(tag)
                || "textarea".equals(tag)
                || "textbox".equals(role)
                || element.path("contentEditable").asBoolean(false);
        if (!editable
                || SENSITIVE_OR_UNSUPPORTED_TYPES.contains(type)) {
            throw new ToolRuntimeException(
                    "browser_field_not_fillable",
                    description + " 不是普通可重读文本字段；"
                            + "密码、文件与敏感输入应使用人工接管"
            );
        }
        if (element.path("disabled").asBoolean(false)) {
            throw new ToolRuntimeException(
                    "browser_element_disabled",
                    description + " 当前不可编辑"
            );
        }
    }

    private String describe(JsonNode element, String fallback) {
        String name = element.path("name").asText("").trim();
        String tag = element.path("tag").asText("field");
        String type = element.path("type").asText("").trim();
        return "页面字段"
                + (name.isBlank() ? " " + fallback : "“" + name + "”")
                + "（" + tag
                + (type.isBlank() ? "" : ", type=" + type)
                + "）";
    }

    private String valuePreview(String value) {
        String compact = value
                .replace("\r", " ")
                .replace("\n", " ");
        if (compact.length() > 80) {
            return "“" + compact.substring(0, 80)
                    + "…”（共 " + value.length() + " 字符）";
        }
        return "“" + compact + "”";
    }

    private JsonNode inputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("runtime_id").put("type", "string")
                .put("description", "可选定向 Runtime ID；默认 Runtime 会由 Backend 自动解析");
        properties.putObject("session_id").put("type", "string")
                .put("description", "当前短期 BrowserSession ID");
        properties.putObject("page_id").put("type", "string")
                .put("description", "当前 BrowserPage ID");
        properties.putObject("observation_ref").put("type", "string")
                .put("description", "最近一次页面观察 ref");
        properties.putObject("element_ref").put("type", "string")
                .put("description", "同一 observation 内的普通文本字段 ref");
        properties.putObject("value").put("type", "string")
                .put("maxLength", MAX_VALUE_CHARACTERS)
                .put("description", "要填写的非秘密文本；清空字段传空字符串");
        schema.putArray("required")
                .add("session_id").add("page_id")
                .add("observation_ref").add("element_ref").add("value");
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
                .put("description", "填写后当前 BrowserPage ID");
        properties.putObject("openedNewPage").put("type", "boolean")
                .put("description", "填写是否打开并接管了新页面");
        properties.set(
                "observation",
                BrowserToolSupport.browserObservationSchema(objectMapper)
        );
        properties.putObject("evidence").put("type", "object")
                .put("description", "字段写入和页面状态变化证据");
        schema.putArray("required")
                .add("status").add("actionAttemptId")
                .add("idempotencyKey").add("pageId")
                .add("openedNewPage").add("observation")
                .add("evidence");
        return schema;
    }
}
