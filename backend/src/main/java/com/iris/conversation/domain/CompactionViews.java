package com.iris.conversation.domain;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.NotBlank;

import java.time.Instant;

public final class CompactionViews {
    private CompactionViews() {
    }

    public record CreateCompactionRequest(
            @NotBlank String branchId,
            String scope,
            String reason
    ) {
        public String normalizedScope() {
            return scope == null || scope.isBlank()
                    ? "current_branch"
                    : scope;
        }
    }

    public record CreateCompactionResponse(
            String runId,
            String eventCursor
    ) {
    }

    public record CompactionView(
            String runId,
            String conversationId,
            String branchId,
            String phase,
            String parentContextFrameId,
            long sourceStartSequence,
            long waterlineSequence,
            String beforeTurnId,
            String sourceSnapshotId,
            int sourceFactCount,
            int estimatedInputTokens,
            String compactBoundaryId,
            JsonNode failure,
            long version,
            Instant requestedAt,
            Instant endedAt
    ) {
    }
}
