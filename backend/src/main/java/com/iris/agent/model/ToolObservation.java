package com.iris.agent.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.time.Instant;

public record ToolObservation(
        String observationId,
        String toolCallId,
        String executionId,
        String outcomeKind,
        JsonNode content,
        String contentHash,
        Instant createdAt
) {
}
