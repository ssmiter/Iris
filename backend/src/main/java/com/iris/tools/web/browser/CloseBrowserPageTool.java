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

/** Closes one owned page without discarding the rest of the session. */
@Component
public class CloseBrowserPageTool implements Tool {
    private final ObjectMapper objectMapper;
    private final BrowserRuntimeService runtimeService;
    private final WebBridgeClient client;
    private final ToolManifest manifest;

    public CloseBrowserPageTool(
            ObjectMapper objectMapper,
            BrowserRuntimeService runtimeService,
            WebBridgeClient client
    ) {
        this.objectMapper = objectMapper;
        this.runtimeService = runtimeService;
        this.client = client;
        this.manifest = new ToolManifest(
                "iris.web.browser.close_browser_page",
                "1",
                "close_browser_page",
                "关闭当前 BrowserSession 拥有的一个明确页面并保留其他页面；用于释放已完成的来源页或误开的标签，最后一页应关闭整个会话",
                inputSchema(),
                outputSchema(),
                RiskLevel.ELEVATED,
                ToolManifest.SideEffect.INTERNAL_STATE,
                30,
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
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("runtime_id", runtimeId);
        normalized.put("session_id", sessionId);
        normalized.put("page_id", pageId);
        return new PreparedOperation(
                normalized,
                "将关闭 BrowserSession " + sessionId + " 中的页面 " + pageId
                        + "；该页面未提交的本地表单状态会丢失，其他页面和网页端已提交数据不受影响",
                List.of(new ResourceClaim(
                        "browser_page",
                        runtimeId + "/" + sessionId + "/" + pageId,
                        null
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
                    "cancelled_before_browser_page_close",
                    "任务已停止，浏览器页面尚未关闭"
            );
        }
        JsonNode input = operation.normalizedInput();
        JsonNode response = client.closePage(
                input.path("runtime_id").asText(),
                input.path("session_id").asText(),
                input.path("page_id").asText(),
                operation.executionId()
        );
        return BrowserToolSupport.actionOutcome(
                response,
                "browser_page_close_not_applied",
                "浏览器页面未关闭",
                "browser_page_close_outcome_unknown",
                "Browser Runtime 无法证明页面是否已经关闭"
        );
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode output = outcome.output();
        String expected = operation.normalizedInput().path("page_id").asText();
        String closed = output.path("closedPageId").asText();
        String evidenceRef = output.path("evidence").path("ref").asText();
        if (!expected.equals(closed) || evidenceRef.isBlank()) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "daemon 返回了页面关闭结果，但缺少关闭身份或证据"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "browser_page_close",
                        evidenceRef,
                        output.path("evidence").path("summary").asText(
                                "目标浏览器页面已关闭"
                        )
                ),
                new VerificationResult.Evidence(
                        "browser_active_page",
                        output.path("activePageId").asText(),
                        "Session 仍保留可继续使用的活动页面"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("runtime_id").put("type", "string")
                .put("description", "可选定向 Runtime ID；默认 Runtime 由 Backend 解析");
        properties.putObject("session_id").put("type", "string")
                .put("description", "list_browser_sessions 返回的 BrowserSession ID");
        properties.putObject("page_id").put("type", "string")
                .put("description", "同一 Session 的 pages 中要关闭的明确 Page ID");
        schema.putArray("required").add("session_id").add("page_id");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("status").put("type", "string")
                .put("description", "applied / not_applied / outcome_unknown");
        properties.putObject("actionAttemptId").put("type", "string")
                .put("description", "本次关闭动作的稳定尝试 ID");
        properties.putObject("idempotencyKey").put("type", "string")
                .put("description", "用于防止重复关闭的幂等键");
        properties.putObject("closedPageId").put("type", "string")
                .put("description", "已关闭的 BrowserPage ID");
        properties.putObject("activePageId").put("type", "string")
                .put("description", "关闭后仍可继续使用的活动 Page ID");
        properties.putObject("pages").put("type", "array")
                .put("description", "关闭后 Session 仍拥有的页面摘要");
        properties.set(
                "observation",
                BrowserToolSupport.browserObservationSchema(objectMapper)
        );
        properties.putObject("evidence").put("type", "object")
                .put("description", "页面关闭及剩余活动页面的证据");
        schema.putArray("required")
                .add("status").add("actionAttemptId")
                .add("idempotencyKey").add("closedPageId")
                .add("activePageId").add("pages")
                .add("observation").add("evidence");
        return schema;
    }
}
