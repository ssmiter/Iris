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

    record AssistantText(String blockId, String text) implements ModelInputItem {
    }

    record AssistantToolCall(
            String toolCallId,
            String providerCallId,
            String name,
            JsonNode arguments
    ) implements ModelInputItem {
    }

    record ToolResult(
            String toolCallId,
            String providerCallId,
            String outcomeKind,
            JsonNode content
    ) implements ModelInputItem {
    }
}
