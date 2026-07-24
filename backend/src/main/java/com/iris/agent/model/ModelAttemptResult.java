package com.iris.agent.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;

public record ModelAttemptResult(
        String providerMessageId,
        String modelId,
        List<ContentBlock> blocks,
        List<ToolCall> toolCalls,
        String stopReason,
        Usage usage
) {
    public ModelAttemptResult {
        blocks = List.copyOf(blocks);
        toolCalls = List.copyOf(toolCalls);
    }

    public record ContentBlock(
            int index,
            ModelStreamEvent.BlockKind kind,
            String providerBlockId,
            String text,
            String toolName,
            JsonNode toolArguments
    ) {
    }

    public record ToolCall(
            String toolCallId,
            String providerCallId,
            String name,
            JsonNode arguments,
            int ordinal
    ) {
    }

    public record Usage(int inputTokens, int outputTokens) {
    }
}
