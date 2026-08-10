package com.iris.tools.web.browser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.PreparedOperation.ResourceClaim;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.UserInputTool;
import com.iris.tools.core.VerificationResult;
import com.iris.webbridge.BrowserRuntimeService;
import com.iris.webbridge.WebBridgeClient;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;

/**
 * Pauses a Browser task at a stable human boundary, then re-observes the
 * same visible page instead of treating the user's acknowledgement as proof.
 */
@Component
public class RequestBrowserTakeoverTool implements UserInputTool {

    private static final String CONTINUE_OPTION = "option_continue";
    private static final String SKIP_OPTION = "option_skip";
    private static final int MAX_REASON = 180;
    private static final int MAX_INSTRUCTIONS = 240;

    private final ObjectMapper objectMapper;
    private final BrowserRuntimeService runtimeService;
    private final WebBridgeClient client;
    private final ToolManifest manifest;

    public RequestBrowserTakeoverTool(
            ObjectMapper objectMapper,
            BrowserRuntimeService runtimeService,
            WebBridgeClient client
    ) {
        this.objectMapper = objectMapper;
        this.runtimeService = runtimeService;
        this.client = client;
        this.manifest = new ToolManifest(
                "iris.web.browser.request_browser_takeover",
                "1",
                "request_browser_takeover",
                "当当前可见页面必须由用户完成登录、验证码、敏感输入或主观确认时，持久暂停并给出最小操作清单；用户响应后重新观察同一页面再继续",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.INTERNAL_STATE,
                10,
                20_000,
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
        String runtimeId = runtimeService.resolveAvailable(
                BrowserToolSupport.optionalId(input, "runtime_id")
        );
        String sessionId = BrowserToolSupport.requiredId(
                input,
                "session_id"
        );
        String pageId = BrowserToolSupport.requiredId(input, "page_id");
        String observationRef = BrowserToolSupport.optionalObservationRef(
                input,
                "observation_ref"
        );
        if (observationRef == null) {
            throw ToolRuntimeException.beforeCommit(
                    "browser_takeover_observation_required",
                    "人工接管必须锚定最近一次页面观察；请先 observe_browser_page"
            );
        }
        String reason = requiredText(input, "reason", MAX_REASON);
        String instructions = requiredText(
                input,
                "instructions",
                MAX_INSTRUCTIONS
        );

        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("runtime_id", runtimeId);
        normalized.put("session_id", sessionId);
        normalized.put("page_id", pageId);
        normalized.put("observation_ref", observationRef);
        normalized.put("reason", reason);
        normalized.put("instructions", instructions);
        return new PreparedOperation(
                normalized,
                "需要用户在当前 Edge 页面接管：" + reason,
                List.of(new ResourceClaim(
                        "browser_page_takeover",
                        runtimeId + "/" + sessionId + "/" + pageId,
                        observationRef
                )),
                Instant.now().plus(1, ChronoUnit.DAYS)
        );
    }

    @Override
    public UserInputPrompt prompt(
            PreparedOperation operation,
            ToolContext context
    ) {
        JsonNode input = operation.normalizedInput();
        return new UserInputPrompt(
                "需要你在 Edge 中接管当前页面。原因："
                        + input.path("reason").asText()
                        + "。请完成："
                        + input.path("instructions").asText(),
                List.of(
                        new Option(
                                CONTINUE_OPTION,
                                "已完成，可以继续",
                                "Iris 会重新观察当前页面，再根据真实状态继续"
                        ),
                        new Option(
                                SKIP_OPTION,
                                "暂时跳过这一步",
                                "保留已完成成果，不把未完成步骤误报为成功"
                        )
                ),
                CONTINUE_OPTION
        );
    }

    @Override
    public ToolOutcome resolve(
            CommittedOperation operation,
            UserInputAnswer answer,
            ToolContext context
    ) {
        JsonNode input = operation.normalizedInput();
        ObjectNode output = objectMapper.createObjectNode();
        output.put("sessionId", input.path("session_id").asText());
        output.put("pageId", input.path("page_id").asText());
        output.put("inputRequestId", answer.inputRequestId());
        output.put("answer", answer.value());

        if (SKIP_OPTION.equals(answer.optionId())) {
            output.put("decision", "skipped");
            output.put("completedByUser", false);
            output.put(
                    "guidance",
                    "用户选择暂时跳过；保留已确认成果，并据此调整任务下一步"
            );
            return ToolOutcome.succeeded(output);
        }

        output.put("decision", "continued");
        output.put("completedByUser", true);
        JsonNode observed;
        try {
            observed = client.observe(
                    input.path("runtime_id").asText(),
                    input.path("session_id").asText(),
                    input.path("page_id").asText(),
                    "interact",
                    null,
                    8_000,
                    160,
                    20
            );
        } catch (RuntimeException exception) {
            output.put(
                    "guidance",
                    "用户已经交还控制，但原页面暂时无法重读；先恢复会话，不要要求用户重复操作"
            );
            return ToolOutcome.unknown(
                    output,
                    "browser_takeover_reobserve_failed",
                    "用户已完成接管，但 Backend 暂时无法重新观察原页面"
            );
        }
        output.set("observation", observed.path("observation"));
        output.put(
                "guidance",
                "用户已交还控制；只能依据新的 observation 判断页面结果"
        );
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode output = outcome.output();
        if ("skipped".equals(output.path("decision").asText())) {
            return VerificationResult.confirmed(List.of(
                    new VerificationResult.Evidence(
                            "user_response",
                            output.path("inputRequestId").asText(),
                            "用户选择暂时跳过当前浏览器步骤"
                    )
            ));
        }
        String observationRef = output.path("observation")
                .path("ref").asText();
        if (observationRef.isBlank()) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "用户已交还控制，但 Backend 没有取得新的页面观察"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "user_response",
                        output.path("inputRequestId").asText(),
                        "用户已完成接管并交还控制"
                ),
                new VerificationResult.Evidence(
                        "browser_page_observation",
                        observationRef,
                        "接管后页面已重新观察；后续判断不复用接管前引用"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("runtime_id").put("type", "string")
                .put("description", "可选定向 Runtime ID；默认 Runtime 由 Backend 解析");
        properties.putObject("session_id").put("type", "string")
                .put("description", "要保留并交给用户操作的 BrowserSession ID");
        properties.putObject("page_id").put("type", "string")
                .put("description", "用户需要接管的当前可见 Page ID");
        properties.putObject("observation_ref").put("type", "string")
                .put("description", "触发接管判断的最近 interact observation ref");
        properties.putObject("reason").put("type", "string")
                .put("minLength", 1).put("maxLength", MAX_REASON)
                .put("description", "为什么该步骤不能由 Iris 安全完成的一句话原因");
        properties.putObject("instructions").put("type", "string")
                .put("minLength", 1).put("maxLength", MAX_INSTRUCTIONS)
                .put("description", "用户只需完成的最小、可操作清单，不重复整段任务背景");
        schema.putArray("required")
                .add("session_id").add("page_id")
                .add("observation_ref").add("reason")
                .add("instructions");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("sessionId").put("type", "string")
                .put("description", "本次人工接管保留的 BrowserSession ID");
        properties.putObject("pageId").put("type", "string")
                .put("description", "用户接管并交还控制的 BrowserPage ID");
        properties.putObject("inputRequestId").put("type", "string")
                .put("description", "持久 UserInput/Attention 请求 ID");
        properties.putObject("answer").put("type", "string")
                .put("description", "用户对本次接管请求的可读响应");
        properties.putObject("decision").put("type", "string")
                .put("description", "continued 表示交还控制，skipped 表示暂时跳过")
                .putArray("enum").add("continued").add("skipped");
        properties.putObject("completedByUser").put("type", "boolean")
                .put("description", "用户是否声明已完成页面中的人工步骤");
        properties.set(
                "observation",
                BrowserToolSupport.browserObservationSchema(objectMapper)
        );
        properties.putObject("guidance").put("type", "string")
                .put("description", "Agent 接管恢复后应遵循的最短续接说明");
        schema.putArray("required")
                .add("sessionId").add("pageId")
                .add("inputRequestId").add("answer")
                .add("decision").add("completedByUser")
                .add("guidance");
        return schema;
    }

    private String requiredText(
            JsonNode input,
            String field,
            int maximum
    ) {
        String value = input.path(field).asText("").trim();
        if (value.isBlank() || value.length() > maximum) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_browser_takeover_" + field,
                    field + " 必须是 1 到 " + maximum + " 个字符"
            );
        }
        return value;
    }
}
