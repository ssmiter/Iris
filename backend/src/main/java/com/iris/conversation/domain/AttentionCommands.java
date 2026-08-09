package com.iris.conversation.domain;

import jakarta.validation.constraints.NotBlank;

import java.time.Instant;

public final class AttentionCommands {
    private AttentionCommands() {
    }

    public record RespondAttentionRequest(
            long expectedVersion,
            @NotBlank String kind,
            @NotBlank String answer
    ) {
    }

    public record AttentionResponse(
            String attentionId,
            String inputRequestId,
            String toolExecutionId,
            String toolCallId,
            String phase,
            boolean runResumeRequested,
            long executionVersion,
            Instant updatedAt
    ) {
    }
}
