package com.iris.agent.model;

public sealed interface ModelStreamEvent {
    record MessageStarted(
            String providerMessageId,
            String modelId
    ) implements ModelStreamEvent {
    }

    record BlockStarted(
            int index,
            BlockKind kind,
            String providerBlockId,
            String toolName
    ) implements ModelStreamEvent {
    }

    record BlockDelta(
            int index,
            String fragment,
            FragmentMode mode
    ) implements ModelStreamEvent {
    }

    record BlockCompleted(int index) implements ModelStreamEvent {
    }

    record MessageCompleted(
            String stopReason,
            int inputTokens,
            int outputTokens
    ) implements ModelStreamEvent {
    }

    enum BlockKind {
        PROVIDER_STATE,
        THINKING,
        TEXT,
        TOOL_CALL
    }

    enum FragmentMode {
        APPEND,
        CUMULATIVE
    }
}
