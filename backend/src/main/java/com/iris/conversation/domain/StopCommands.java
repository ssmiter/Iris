package com.iris.conversation.domain;

import jakarta.validation.constraints.NotBlank;

import java.time.Instant;

public final class StopCommands {
    private StopCommands() {
    }

    public record StopTurnRequest(@NotBlank String reason) {
    }

    public record StopView(
            String stopRequestId,
            String turnId,
            String rootRunId,
            String reason,
            String state,
            long version,
            Instant requestedAt,
            Instant completedAt
    ) {
    }
}
