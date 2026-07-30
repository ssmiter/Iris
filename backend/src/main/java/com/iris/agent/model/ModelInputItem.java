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

    record UserText(
            String messageId,
            String text,
            java.util.List<AttachmentContext> attachments
    ) implements ModelInputItem {
        public UserText(String messageId, String text) {
            this(messageId, text, java.util.List.of());
        }

        public UserText {
            attachments = java.util.List.copyOf(attachments);
        }
    }

    record AttachmentContext(
            String artifactRef,
            String name,
            String mediaType,
            long byteCount,
            String contentHash
    ) {
    }

    /**
     * A code-maintained, bounded projection of the current long-running task.
     * It is working memory, not a replacement for the user's messages.
     */
    record TaskWorkState(
            String taskId,
            int stateVersion,
            String content
    ) implements ModelInputItem {
    }

    /**
     * Bounded metadata index of explicitly published immutable artifacts.
     * Bodies are never injected implicitly.
     */
    record ArtifactContextIndex(
            String content
    ) implements ModelInputItem {
    }

    /**
     * Code-maintained execution waterline for the current model attempt.
     */
    record RuntimePulse(
            String runId,
            int roundIndex,
            int toolCallsUsed,
            int toolCallsLimit,
            long elapsedMs,
            long timeLimitMs,
            String observedAt,
            String localTimeZone,
            String hostPlatform,
            int activeCapabilitySchemas,
            int omittedCapabilityCandidates,
            java.util.List<ToolActivity> recentToolActivity
    ) implements ModelInputItem {
        public RuntimePulse {
            recentToolActivity = java.util.List.copyOf(
                    recentToolActivity
            );
        }
    }

    record ToolActivity(
            String toolName,
            int callCount,
            int failedCount,
            int outcomeUnknownCount,
            int maxIdenticalInputCount,
            String latestErrorCode
    ) {
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
