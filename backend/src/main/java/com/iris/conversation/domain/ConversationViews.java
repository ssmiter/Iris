package com.iris.conversation.domain;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import com.fasterxml.jackson.databind.JsonNode;

public final class ConversationViews {
    private ConversationViews() {
    }

    public record TurnView(
            String turnId,
            String branchId,
            String requestMessageId,
            RequestView request,
            String phase,
            List<String> runIds,
            String rootRunId,
            List<String> renderNodeIds,
            List<String> pendingAttentionIds,
            Object stop,
            FailureView failure,
            List<Object> supplements,
            TurnStats stats,
            long version
    ) {
    }

    public record RequestView(String text, List<String> attachmentRefs) {
    }

    public record TurnStats(
            int roundCount,
            int toolCallCount,
            int childRunCount,
            Instant startedAt,
            Instant endedAt
    ) {
    }

    public record RunView(
            String runId,
            String turnId,
            String parentRunId,
            String rootRunId,
            String invokingStepId,
            String kind,
            RunDefinition definition,
            String purpose,
            String phase,
            RunClosureView closure,
            List<Object> blockers,
            List<String> roundIds,
            List<String> childRunIds,
            RunBudget budget,
            String outputRef,
            List<String> evidenceRefs,
            FailureView failure,
            long version,
            Instant startedAt,
            Instant endedAt,
            String progressSummary
    ) {
        /** Root Runs have no progress summary; only child Runs project one. */
        public RunView(
                String runId,
                String turnId,
                String parentRunId,
                String rootRunId,
                String invokingStepId,
                String kind,
                RunDefinition definition,
                String purpose,
                String phase,
                RunClosureView closure,
                List<Object> blockers,
                List<String> roundIds,
                List<String> childRunIds,
                RunBudget budget,
                String outputRef,
                List<String> evidenceRefs,
                FailureView failure,
                long version,
                Instant startedAt,
                Instant endedAt
        ) {
            this(
                    runId,
                    turnId,
                    parentRunId,
                    rootRunId,
                    invokingStepId,
                    kind,
                    definition,
                    purpose,
                    phase,
                    closure,
                    blockers,
                    roundIds,
                    childRunIds,
                    budget,
                    outputRef,
                    evidenceRefs,
                    failure,
                    version,
                    startedAt,
                    endedAt,
                    null
            );
        }
    }

    public record RunDefinition(
            String id,
            String version,
            String snapshotHash,
            String normalizedInputHash,
            String dependencySnapshotRef
    ) {
    }

    public record RunBudget(
            int toolCallsUsed,
            int toolCallsLimit,
            long elapsedMs,
            long timeLimitMs
    ) {
    }

    public record RunClosureView(
            String executionStatus,
            String taskOutcome,
            String terminalReason,
            String finalStopReason,
            RunClosureCounts counts,
            boolean hasFinalAnswer,
            Instant recordedAt
    ) {
    }

    public record RunClosureCounts(
            int rounds,
            int modelAttempts,
            int toolCalls,
            int toolExecutions,
            int toolObservations,
            int toolSucceeded,
            int toolFailed,
            int toolOutcomeUnknown,
            int toolRejected,
            int toolExpired,
            int unresolvedProtocolFacts,
            int evidence,
            int artifacts
    ) {
    }

    public record FailureView(
            String code,
            String category,
            String userMessage,
            String traceId,
            String source,
            String recoveryAction,
            String sideEffectOutcome,
            String detailsRef
    ) {
    }

    public record RoundView(
            String roundId,
            String runId,
            int index,
            String phase,
            List<String> processNodeIds,
            String answerNodeId,
            RoundStats stats,
            long version
    ) {
    }

    public record RoundStats(int toolCallCount, long durationMs) {
    }

    public record ConversationSummary(
            String conversationId,
            String title,
            Instant updatedAt,
            int activeTurnCount,
            int pendingAttentionCount,
            String lastVisibleText,
            long version
    ) {
    }

    public record ConversationPage(
            List<ConversationSummary> items,
            String nextCursor
    ) {
    }

    public record BranchSummary(
            String branchId,
            String parentBranchId,
            ForkAnchor forkAnchor,
            String headTurnId,
            String status,
            long version
    ) {
    }

    public record ForkAnchor(
            String mode,
            String anchorMessageId,
            String sourceTurnId,
            long sourceEventSequence,
            String baseContextFrameId,
            long baseWaterlineSequence
    ) {
    }

    public record ConversationView(
            String conversationId,
            String title,
            String selectedBranchId,
            List<String> turnOrder,
            Map<String, TurnView> turnsById,
            Map<String, RunView> runsById,
            Map<String, RoundView> roundsById,
            Map<String, JsonNode> renderNodesById,
            List<BranchSummary> branches,
            List<JsonNode> compactBoundaries,
            Map<String, JsonNode> compactionsById,
            Map<String, JsonNode> attentionsById,
            List<String> pendingAttentionIds,
            long version,
            int projectionVersion,
            String eventCursor,
            boolean hasEarlierTurns
    ) {
    }

    public record RenameConversationRequest(long expectedVersion, String title) {
    }

    public record RenameConversationResponse(
            String conversationId,
            String title,
            long version,
            Instant updatedAt,
            String eventCursor
    ) {
    }

    public record ArchiveConversationRequest(
            long expectedVersion,
            boolean archived
    ) {
    }

    public record ArchiveConversationResponse(
            String conversationId,
            boolean archived,
            long version,
            Instant updatedAt,
            String eventCursor
    ) {
    }

    public record ContextUsageView(
            int used,
            int limit,
            int percent,
            String phase
    ) {
        public ContextUsageView(int used, int limit, int percent) {
            this(used, limit, percent, null);
        }
    }
}
