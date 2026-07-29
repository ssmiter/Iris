package com.iris.agent.model;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Provider-neutral, ordered model context facts.
 */
public sealed interface ModelInputItem {
    record HistorySummary(
            String boundaryId,
            String text
    ) implements ModelInputItem {
    }

    record UserText(String messageId, String text) implements ModelInputItem {
    }

    record AssistantProviderState(
            String attemptId,
            String blockId,
            String providerProfile,
            String modelId,
            String stateKey,
            String content
    ) implements ModelInputItem {
    }

    record AssistantText(
            String attemptId,
            String blockId,
            String text
    ) implements ModelInputItem {
    }

    record ContinuationDirective(
            String attemptId,
            String text
    ) implements ModelInputItem {
    }

    record AssistantToolCall(
            String attemptId,
            String toolCallId,
            String providerCallId,
            String name,
            JsonNode arguments
    ) implements ModelInputItem {
    }

    record ToolResult(
            String assistantAttemptId,
            String observationId,
            String toolCallId,
            String providerCallId,
            String executionId,
            String outcomeKind,
            String manifestHash,
            String payloadHash,
            JsonNode content
    ) implements ModelInputItem {
    }
}
