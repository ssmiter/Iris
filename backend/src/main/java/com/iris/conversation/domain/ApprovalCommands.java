package com.iris.conversation.domain;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import java.time.Instant;

public final class ApprovalCommands {
    private ApprovalCommands() {
    }

    public record DecideApprovalRequest(
            @NotNull Decision decision,
            long expectedVersion,
            @NotBlank String operationSnapshotHash,
            String reason
    ) {
    }

    public enum Decision {
        approve,
        reject
    }

    public record ApprovalDecisionResponse(
            String approvalId,
            String toolExecutionId,
            String toolCallId,
            String phase,
            boolean approved,
            boolean runResumeRequested,
            long executionVersion,
            Instant updatedAt
    ) {
    }
}
