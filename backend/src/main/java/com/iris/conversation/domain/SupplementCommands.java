package com.iris.conversation.domain;

import jakarta.validation.constraints.NotBlank;

import java.time.Instant;
import java.util.List;

public final class SupplementCommands {
    private SupplementCommands() {
    }

    public record CreateSupplementRequest(
            @NotBlank String text,
            List<@NotBlank String> attachmentRefs
    ) {
        public CreateSupplementRequest {
            attachmentRefs = attachmentRefs == null
                    ? List.of()
                    : List.copyOf(attachmentRefs);
        }
    }

    public record SupplementView(
            String supplementId,
            String turnId,
            String messageId,
            String state,
            String text,
            List<String> attachmentRefs,
            String injectedAfterRoundId,
            Instant acceptedAt,
            Instant updatedAt,
            long version
    ) {
    }
}
