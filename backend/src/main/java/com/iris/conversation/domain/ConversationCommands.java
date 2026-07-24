package com.iris.conversation.domain;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import java.time.Instant;
import java.util.List;

public final class ConversationCommands {
    private ConversationCommands() {
    }

    public record CreateConversationRequest(String title) {
    }

    public record CreateConversationResponse(
            String conversationId,
            String rootBranchId,
            long version
    ) {
    }

    public record CreateTurnRequest(
            @NotBlank String branchId,
            @NotBlank String clientRequestId,
            @NotNull @Valid TurnInput input,
            @Valid Entrypoint entrypoint
    ) {
    }

    public record TurnInput(
            @NotBlank String text,
            List<@NotBlank String> attachmentRefs
    ) {
        public TurnInput {
            attachmentRefs = attachmentRefs == null ? List.of() : List.copyOf(attachmentRefs);
        }
    }

    public record Entrypoint(String kind) {
        public String normalizedKind() {
            return kind == null || kind.isBlank() ? "agentic" : kind;
        }
    }

    public record TurnAcceptance(
            String conversationId,
            String branchId,
            String turnId,
            String requestMessageId,
            String rootRunId,
            Instant acceptedAt,
            String eventCursor
    ) {
    }
}
