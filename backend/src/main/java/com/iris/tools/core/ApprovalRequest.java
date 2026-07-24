package com.iris.tools.core;

import java.time.Instant;

/**
 * 审批请求（docs/03 §7）。elevated/destructive 工具执行前挂起生成，
 * 经 SSE 推到前端，在对话框上方以审批条呈现。
 *
 * impactStatement 必须是人话：不说"调用 write_file"，
 * 而说"将覆盖 notes/旅行清单.md（原有 2.3KB 内容）"——由 Tool.describeImpact 生成。
 */
public record ApprovalRequest(
        String toolCallId,
        String toolName,
        String impactStatement,
        RiskLevel riskLevel,
        String sessionId,
        Instant expiresAt
) {
    public static ApprovalRequest of(String toolCallId, Tool tool, String impactStatement,
                                     String sessionId, long ttlSec) {
        return new ApprovalRequest(
                toolCallId, tool.name(), impactStatement, tool.riskLevel(),
                sessionId, Instant.now().plusSeconds(ttlSec));
    }
}
