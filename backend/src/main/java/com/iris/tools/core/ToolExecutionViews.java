package com.iris.tools.core;

import java.time.Instant;

public final class ToolExecutionViews {
    private ToolExecutionViews() {
    }

    public record Invocation(
            String toolCallId,
            String toolName
    ) {
    }

    public record ApprovalDecision(
            String approvalId,
            String decisionKey,
            String snapshotHash,
            long expectedVersion,
            boolean approved,
            String decidedBy
    ) {
    }

    public record UserInputDecision(
            String inputRequestId,
            String decisionKey,
            long expectedVersion,
            String answer
    ) {
    }

    public record RuntimeResult(
            String executionId,
            String toolCallId,
            String toolName,
            String phase,
            String snapshotId,
            String approvalId,
            String snapshotHash,
            String impactStatement,
            String outcomeKind,
            String errorCode,
            String message,
            long version,
            Instant updatedAt
    ) {
        public boolean terminal() {
            return switch (phase) {
                case "succeeded", "failed", "outcome_unknown",
                     "rejected", "expired" -> true;
                default -> false;
            };
        }
    }
}
