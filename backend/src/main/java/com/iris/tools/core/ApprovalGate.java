package com.iris.tools.core;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * 审批闸门（docs/03 §7）。
 *
 * 流程：执行器遇到需审批工具 → awaitApproval 挂起 → 推送 ApprovalRequest 到前端
 * → 用户批准/拒绝（或超时自动 expired→rejected）→ future 完成，执行器继续。
 *
 * 红线：超时即拒绝，不静默重发；拒绝原因可回注模型。
 */
@Component
public class ApprovalGate {

    /** 默认审批有效期：5 分钟 */
    private static final long DEFAULT_TTL_SEC = 300;

    private final Map<String, CompletableFuture<Boolean>> pending = new ConcurrentHashMap<>();
    private final Map<String, ApprovalRequest> requests = new ConcurrentHashMap<>();

    /** 挂起等待决定。返回 true=批准；false=拒绝/超时。 */
    public boolean awaitApproval(String toolCallId, Tool tool, JsonNode args, String sessionId) {
        ApprovalRequest req = ApprovalRequest.of(
                toolCallId, tool, tool.describeImpact(args), sessionId, DEFAULT_TTL_SEC);
        requests.put(toolCallId, req);
        CompletableFuture<Boolean> future = new CompletableFuture<>();
        pending.put(toolCallId, future);
        try {
            // TODO: 经 SSE 推送 req 到前端（接 docs/08 §2 /api/tools/events）
            return future.get(DEFAULT_TTL_SEC + 5, TimeUnit.SECONDS);
        } catch (Exception e) {
            return false; // 超时/异常 = 拒绝（fail-close）
        } finally {
            pending.remove(toolCallId);
            requests.remove(toolCallId);
        }
    }

    public boolean resolve(String toolCallId, boolean approved) {
        CompletableFuture<Boolean> future = pending.get(toolCallId);
        if (future == null) return false;
        return future.complete(approved);
    }

    public Optional<ApprovalRequest> pendingRequest(String toolCallId) {
        return Optional.ofNullable(requests.get(toolCallId));
    }
}
