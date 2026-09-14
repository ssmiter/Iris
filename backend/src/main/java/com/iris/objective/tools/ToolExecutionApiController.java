package com.iris.objective.tools;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.conversation.application.ApprovalCommandService;
import com.iris.conversation.domain.ApprovalCommands;
import com.iris.conversation.infrastructure.ConversationRepository;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolExecutionViews.Invocation;
import com.iris.tools.core.ToolExecutionViews.RuntimeResult;
import com.iris.tools.core.ToolRuntime;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.ToolRuntimeRepository;
import com.iris.workspace.WorkspaceService;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;
import reactor.core.scheduler.Schedulers;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 前端 Agent Runtime 的客观工具执行桥。
 *
 * <p>这里不决定下一轮、不拼接模型上下文，也不做工具发现；只把一次已由
 * 前端选定的调用接入 ToolRuntime，持久化最小运行上下文，并把运行事实以
 * SSE 归一返回。</p>
 */
@RestController
@RequestMapping("/api/tools")
public final class ToolExecutionApiController {
    private final ToolRuntime runtime;
    private final ToolRuntimeRepository facts;
    private final WorkspaceService workspace;
    private final JdbcClient jdbc;
    private final ConversationRepository conversations;
    private final ObjectMapper json;
    private final ApprovalCommandService approvals;

    public ToolExecutionApiController(
            ToolRuntime runtime,
            ToolRuntimeRepository facts,
            ConversationRepository conversations,
            WorkspaceService workspace,
            JdbcClient jdbc,
            ObjectMapper json,
            ApprovalCommandService approvals
    ) {
        this.runtime = runtime;
        this.facts = facts;
        this.conversations = conversations;
        this.workspace = workspace;
        this.jdbc = jdbc;
        this.json = json;
        this.approvals = approvals;
    }

    @PostMapping(value = "/execute", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> execute(@RequestBody ExecuteRequest request) {
        return Flux.defer(() -> Flux.just(toEvent(run(request))))
                .subscribeOn(Schedulers.boundedElastic())
                .onErrorResume(error -> Flux.just(toEvent(errorEvent(request, error))));
    }

    /** WonWork 兼容入口：把轻量审批请求翻译为 ToolRuntime 的快照决议。 */
    @PostMapping("/approval")
    public reactor.core.publisher.Mono<Map<String, Object>> approval(@RequestBody ApprovalRequest request) {
        return reactor.core.publisher.Mono.fromCallable(() -> {
            var row = jdbc.sql("""
                    SELECT a.approval_id, a.snapshot_hash, a.version, e.tool_call_id
                    FROM tool_approval_request a
                    JOIN tool_execution e ON e.execution_id = a.execution_id
                    WHERE a.execution_id = :executionId AND e.tool_call_id = :toolUseId
                    """)
                    .param("executionId", request.executionId())
                    .param("toolUseId", request.toolUseId())
                    .query((rs, n) -> new ApprovalRow(
                            rs.getString("approval_id"), rs.getString("snapshot_hash"),
                            rs.getLong("version")))
                    .optional()
                    .orElseThrow(() -> new IllegalArgumentException("找不到待审批的工具执行"));
            var decision = approvals.decide(
                    row.approvalId(), "frontend-approval-" + UUID.randomUUID(),
                    new ApprovalCommands.DecideApprovalRequest(
                            request.approved() ? ApprovalCommands.Decision.approve : ApprovalCommands.Decision.reject,
                            row.version(), row.snapshotHash(), request.reason()));
            // 审批决定是一次完整的客观执行边界：approve 会在 Runtime 内恢复工具，
            // 因此把终态一并返回给前端，避免前端再发一轮重复调用。
            RuntimeResult result = facts.findByExecutionId(request.executionId())
                    .orElse(null);
            Map<String, Object> response = result == null
                    ? new LinkedHashMap<>()
                    : new LinkedHashMap<>(resultEvent(result));
            response.put("executionId", request.executionId());
            response.put("approved", request.approved());
            response.putIfAbsent("toolUseId", decision.toolCallId());
            response.putIfAbsent("phase", decision.phase());
            return response;
        }).subscribeOn(Schedulers.boundedElastic());
    }

    private Map<String, Object> run(ExecuteRequest request) {
        String conversationId = required(request.conversationId(), "conversationId");
        String toolName = required(request.toolName(), "toolName");
        String toolCallId = request.toolUseId() == null || request.toolUseId().isBlank()
                ? "tool-call-" + UUID.randomUUID()
                : request.toolUseId();
        JsonNode input;
        try {
            input = json.readTree(request.arguments() == null ? "{}" : request.arguments());
        } catch (Exception exception) {
            return error(request, toolCallId, "工具参数不是合法 JSON：" + exception.getMessage());
        }
        if (input == null) input = json.createObjectNode();

        RuntimeResult existing = facts.findByToolCall(conversationId, toolCallId).orElse(null);
        if (existing != null) return resultEvent(existing);

        RequestContext context = createContext(conversationId, request.userMessage(), toolCallId);
        RuntimeResult result;
        try {
            result = runtime.invoke(new Invocation(toolCallId, toolName), input, context);
        } catch (ToolRuntimeException exception) {
            return error(request, toolCallId, exception.getMessage());
        } catch (RuntimeException exception) {
            return error(request, toolCallId, "工具执行失败：" + safe(exception));
        }
        return resultEvent(result);
    }

    /** 为 ToolRuntime 提供可追踪但无编排含义的最小 turn/run 外壳。 */
    private RequestContext createContext(String conversationId, String userMessage, String toolCallId) {
        String branchId = jdbc.sql("SELECT root_branch_id FROM iris_conversation WHERE conversation_id = :id")
                .param("id", conversationId).query(String.class).optional()
                .orElseThrow(() -> new IllegalArgumentException("找不到对话 " + conversationId));
        Instant now = Instant.now();
        String turnId = "tool-turn-" + UUID.randomUUID();
        String messageId = "tool-message-" + UUID.randomUUID();
        String runId = "tool-run-" + UUID.randomUUID();
        conversations.insertMessage(
                messageId, conversationId, branchId, turnId,
                userMessage == null ? "工具调用 " + toolCallId : userMessage,
                null, List.of(), now);
        conversations.insertTurn(turnId, conversationId, branchId, messageId, runId, now);
        conversations.insertRootRun(runId, conversationId, branchId, turnId,
                "frontend_tool", "", "", now);
        return new RequestContext(conversationId, turnId, runId, workspace.root());
    }

    private Map<String, Object> resultEvent(RuntimeResult result) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("toolUseId", result.toolCallId());
        event.put("toolName", result.toolName());
        event.put("executionId", result.executionId());
        if ("awaiting_approval".equals(result.phase())) {
            event.put("type", "approval_required");
            event.put("data", result.impactStatement() == null ? "该工具需要审批" : result.impactStatement());
            event.put("impactStatement", result.impactStatement());
            if (result.approvalId() != null) {
                facts.findApproval(result.approvalId()).ifPresent(approval -> {
                    event.put("riskLevel", approval.riskLevel());
                    event.put("expiresAt", approval.expiresAt().toEpochMilli());
                });
            }
            return event;
        }
        if ("succeeded".equals(result.phase())) {
            String output = facts.outputJson(result.executionId()).orElse("");
            event.put("type", "result");
            event.put("resultData", output);
            event.put("resultSummary", output);
            event.put("data", output);
            if (!output.isBlank()) {
                try { event.put("structuredData", json.readTree(output)); } catch (Exception ignored) { }
            }
            return event;
        }
        if (!result.terminal()) {
            // A duplicate request can observe an execution between claimed and
            // its terminal fact. Never present that intermediate snapshot as a
            // successful empty result; the caller can retry with executionId.
            String message = "工具仍在执行，尚未产生终态；请稍后用同一 toolUseId 重试";
            event.put("type", "error");
            event.put("error", message);
            event.put("data", message);
            event.put("errorCode", "tool_execution_in_progress");
            event.put("status", result.phase());
            return event;
        }
        String output = facts.outputJson(result.executionId()).orElse("");
        if (!output.isBlank()) {
            event.put("resultData", output);
            try { event.put("structuredData", json.readTree(output)); } catch (Exception ignored) { }
        }
        event.put("type", "error");
        String terminalMessage = result.message();
        if (terminalMessage == null || terminalMessage.isBlank()) {
            terminalMessage = "outcome_unknown".equals(result.phase())
                    ? "工具执行结果不确定，外部状态需要核对"
                    : "工具执行失败";
        }
        event.put("error", terminalMessage);
        event.put("data", terminalMessage);
        event.put("errorCode", result.errorCode());
        event.put("status", result.phase());
        return event;
    }

    private Map<String, Object> errorEvent(ExecuteRequest request, Throwable error) {
        return error(request, request.toolUseId(), safe(error));
    }

    private Map<String, Object> error(ExecuteRequest request, String toolCallId, String message) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("type", "error");
        event.put("toolUseId", toolCallId == null ? "" : toolCallId);
        event.put("toolName", request.toolName());
        event.put("error", message);
        event.put("data", message);
        return event;
    }

    private ServerSentEvent<String> toEvent(Map<String, Object> event) {
        try {
            return ServerSentEvent.<String>builder(json.writeValueAsString(event)).build();
        } catch (Exception exception) {
            return ServerSentEvent.<String>builder("{\"type\":\"error\",\"error\":\"结果序列化失败\"}").build();
        }
    }

    private String required(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " 不能为空");
        return value;
    }

    private String safe(Throwable error) {
        // ToolRuntime wraps non-ToolRuntimeException causes inside
        // IllegalStateException("Tool runtime failed", cause). Surface the
        // deepest meaningful message so the frontend sees the real root cause
        // instead of the opaque wrapper text.
        Throwable root = error;
        while (root.getCause() != null && root.getCause() != root) {
            root = root.getCause();
        }
        String message = root.getMessage();
        if (message == null || message.isBlank()) {
            message = root.getClass().getSimpleName();
        }
        return error == root ? message : message + "（包装自 " + error.getMessage() + "）";
    }

    public record ExecuteRequest(
            String toolName,
            String arguments,
            String conversationId,
            String userMessage,
            String toolUseId,
            String systemCode
    ) { }

    public record ApprovalRequest(String executionId, String toolUseId, boolean approved, String reason) { }
    private record ApprovalRow(String approvalId, String snapshotHash, long version) { }

    private record RequestContext(
            String conversationId,
            String turnId,
            String runId,
            java.nio.file.Path workspaceRoot
    ) implements ToolContext {
        @Override public String roundId() { return null; }
        @Override public boolean cancelled() { return false; }
    }
}
