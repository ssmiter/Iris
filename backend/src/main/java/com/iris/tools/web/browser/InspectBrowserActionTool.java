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
import com.iris.webbridge.BrowserRuntimeService;
import com.iris.webbridge.WebBridgeClient;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

/**
 * 响应丢失后按原 execution/idempotency identity 读取 daemon 已知结果，
 * 不产生第二次浏览器动作。
 */
@Component
public class InspectBrowserActionTool implements Tool {

    private final ObjectMapper objectMapper;
    private final BrowserRuntimeService runtimeService;
    private final WebBridgeClient client;
    private final ToolManifest manifest;

    public InspectBrowserActionTool(
            ObjectMapper objectMapper,
            BrowserRuntimeService runtimeService,
            WebBridgeClient client
    ) {
        this.objectMapper = objectMapper;
        this.runtimeService = runtimeService;
        this.client = client;
        this.manifest = new ToolManifest(
                "iris.web.browser.inspect_browser_action",
                "2",
                "inspect_browser_action",
                "按原 Tool execution ID 读取 daemon 已保存的浏览器动作结果，不再次执行动作；上次动作 outcome_unknown 时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                15,
                80_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
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
        String runtimeId = runtimeService.resolveAvailable(
                BrowserToolSupport.optionalId(input, "runtime_id")
        );
        String sessionId = BrowserToolSupport.requiredId(
                input,
                "session_id"
        );
        String executionId = BrowserToolSupport.requiredId(
                input,
                "tool_execution_id"
        );
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("runtime_id", runtimeId);
        normalized.put("session_id", sessionId);
        normalized.put("tool_execution_id", executionId);
        return new PreparedOperation(
                normalized,
                "读取 BrowserSession " + sessionId
                        + " 中原执行 " + executionId
                        + " 的已保存结果，不重放点击或导航",
                List.of(new ResourceClaim(
                        "browser_action_result",
                        runtimeId + "/" + sessionId + "/" + executionId,
                        null
                )),
                Instant.now().plusSeconds(60)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode input = operation.normalizedInput();
        return ToolOutcome.succeeded(client.readActionResult(
                input.path("runtime_id").asText(),
                input.path("session_id").asText(),
                input.path("tool_execution_id").asText()
        ));
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "browser_action_journal",
                        operation.normalizedInput()
                                .path("tool_execution_id").asText(),
                        "结果来自 daemon 的幂等动作日志，没有重放外部动作"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("runtime_id").put("type", "string")
                .put("description", "可选定向 Runtime ID；默认 Runtime 会由 Backend 自动解析");
        properties.putObject("session_id").put("type", "string")
                .put("description", "原动作所在的短期 BrowserSession ID");
        properties.putObject("tool_execution_id")
                .put("type", "string")
                .put("description", "outcome_unknown Tool observation 中的 executionId；也是原动作 idempotency key");
        schema.putArray("required")
                .add("session_id")
                .add("tool_execution_id");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("status")
                .put("type", "string")
                .put("description", "applied / not_applied / outcome_unknown");
        properties.putObject("actionAttemptId").put("type", "string")
                .put("description", "原动作尝试的稳定 ID");
        properties.putObject("idempotencyKey").put("type", "string")
                .put("description", "原动作的幂等键");
        properties.set(
                "observation",
                BrowserToolSupport.browserObservationSchema(objectMapper)
        );
        properties.putObject("evidence").put("type", "object")
                .put("description", "原动作已生效时返回的机器可读证据");
        schema.putArray("required")
                .add("status").add("actionAttemptId")
                .add("idempotencyKey");
        return schema;
    }
}
