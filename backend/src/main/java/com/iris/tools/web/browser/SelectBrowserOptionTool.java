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

@Component
public class SelectBrowserOptionTool implements Tool {

    private final ObjectMapper objectMapper;
    private final BrowserRuntimeService runtimeService;
    private final WebBridgeClient client;
    private final ToolManifest manifest;

    public SelectBrowserOptionTool(
            ObjectMapper objectMapper,
            BrowserRuntimeService runtimeService,
            WebBridgeClient client
    ) {
        this.objectMapper = objectMapper;
        this.runtimeService = runtimeService;
        this.client = client;
        this.manifest = new ToolManifest(
                "iris.web.browser.select_browser_option",
                "2",
                "select_browser_option",
                "选择当前页面观察中原生下拉框的一个可用 option，并返回重读后的页面观察；使用 observation 提供的 option value",
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
                    "选择下拉项前必须传入最近页面观察的 ref"
            );
        }
        String elementRef = BrowserToolSupport.requiredId(input, "element_ref");
        if (!input.path("value").isTextual()) {
            throw new ToolRuntimeException(
                    "invalid_browser_option_value",
                    "value 必须是 observation 中 option 的字符串 value"
            );
        }
        String value = input.path("value").asText();
        JsonNode element = client.resolveElement(
                runtimeId,
                sessionId,
                pageId,
                observationRef,
                elementRef
        ).path("element");
        if (!"select".equals(element.path("tag").asText())) {
            throw new ToolRuntimeException(
                    "browser_select_not_supported",
                    "元素 " + elementRef + " 不是原生 select 下拉框"
            );
        }
        JsonNode option = findOption(element.path("options"), value);
        if (option == null || option.path("disabled").asBoolean(false)) {
            throw new ToolRuntimeException(
                    "browser_option_not_available",
                    "当前观察中没有可用 option value=" + value
            );
        }
        String fieldName = element.path("name").asText(elementRef);
        String label = option.path("label").asText(value);
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("runtime_id", runtimeId);
        normalized.put("session_id", sessionId);
        normalized.put("page_id", pageId);
        normalized.put("observation_ref", observationRef);
        normalized.put("element_ref", elementRef);
        normalized.put("value", value);
        normalized.put("field_name", fieldName);
        normalized.put("option_label", label);
        return new PreparedOperation(
                normalized,
                "将在 BrowserSession " + sessionId + " 的下拉框“"
                        + fieldName + "”中选择“" + label
                        + "”；仅当页面仍处于观察 " + observationRef
                        + " 时执行，随后重读确认",
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
                    "cancelled_before_browser_select",
                    "任务已停止，下拉项尚未改变"
            );
        }
        JsonNode input = operation.normalizedInput();
        JsonNode response = client.select(
                input.path("runtime_id").asText(),
                input.path("session_id").asText(),
                input.path("page_id").asText(),
                input.path("observation_ref").asText(),
                input.path("element_ref").asText(),
                input.path("value").asText(),
                operation.executionId()
        );
        return switch (response.path("status").asText()) {
            case "applied" -> ToolOutcome.succeeded(response);
            case "not_applied" -> ToolOutcome.failed(
                    "browser_action_not_applied",
                    response.path("message").asText(
                            "页面或下拉项已变化；选择未执行，请重新观察"
                    )
            );
            case "outcome_unknown" -> ToolOutcome.unknown(
                    "browser_action_outcome_unknown",
                    response.path("message").asText("无法确认下拉项是否改变")
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
                    "下拉项动作缺少重读证据"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "browser_select",
                        evidence.path("ref").asText(),
                        evidence.path("summary").asText("下拉项已改变并重读")
                ),
                new VerificationResult.Evidence(
                        "browser_page_observation",
                        observation.path("ref").asText(),
                        "选择后页面已重新观察"
                )
        ));
    }

    private JsonNode findOption(JsonNode options, String value) {
        if (!options.isArray()) {
            return null;
        }
        for (JsonNode option : options) {
            if (value.equals(option.path("value").asText())) {
                return option;
            }
        }
        return null;
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
                .put("description", "最近页面观察的 ref；用于阻止在已变化页面上误选");
        properties.putObject("element_ref").put("type", "string")
                .put("description", "同一 observation 中 tag=select 的元素 ref");
        properties.putObject("value").put("type", "string")
                .put("description", "该元素 options 数组中的精确 value，不要猜 label");
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
                .put("description", "本次选择动作尝试的稳定 ID");
        properties.putObject("idempotencyKey").put("type", "string")
                .put("description", "用于安全恢复选择结果的幂等键");
        properties.putObject("pageId").put("type", "string")
                .put("description", "选择后当前 BrowserPage ID");
        properties.putObject("openedNewPage").put("type", "boolean")
                .put("description", "选择是否打开并接管了新页面");
        properties.set(
                "observation",
                BrowserToolSupport.browserObservationSchema(objectMapper)
        );
        properties.putObject("evidence").put("type", "object")
                .put("description", "选项变化和页面状态变化证据");
        schema.putArray("required")
                .add("status").add("actionAttemptId")
                .add("idempotencyKey").add("pageId")
                .add("openedNewPage").add("observation").add("evidence");
        return schema;
    }
}
