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

    public record Usage(
            int inputTokens,
            int outputTokens,
            int cacheReadTokens,
            int cacheMissTokens,
            int reasoningTokens
    ) {
        public Usage(int inputTokens, int outputTokens) {
            this(inputTokens, outputTokens, 0, inputTokens, 0);
        }

        public Usage {
            if (inputTokens < 0 || outputTokens < 0
                    || cacheReadTokens < 0 || cacheMissTokens < 0
                    || reasoningTokens < 0) {
                throw new IllegalArgumentException(
                        "Model usage counters cannot be negative"
                );
            }
        }
    }
}
