package com.iris.agent.model;

import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

@Service
public class ModelContextWindowPlanner {
    private static final int PROTOCOL_HEADROOM_TOKENS = 512;

    /**
     * Explicit drop-priority table for dynamic, non-required context sections.
     *
     * <p>Lower ordinal = dropped first. The ordering is chosen so that the
     * easiest-to-rediscover and oldest evidence is discarded before state that
     * is harder to regenerate or more central to the current conversation.</p>
     */
    private enum DropPriority {
        /**
         * Tool-result trajectories are the cheapest to re-discover: the source
         * observations remain durable and the micro-compactor can re-project
         * them on demand.
         */
        TOOL_OBSERVATION_TRAJECTORY,
        /**
         * The artifact index is only a pointer catalog. It can be replaced by
         * a single reference projection without losing immutable bodies.
         */
        ARTIFACT_INDEX,
        /**
         * Active-run state is a projection of durable lifecycle facts. It can
         * be refreshed, but dropping it reduces cross-run awareness.
         */
        AGENT_RUN_STATE,
        /**
         * History summaries are already lossy compression artifacts; dropping
         * the summary does not erase the underlying branch facts.
         */
        HISTORY_SUMMARY,
        /**
         * Older assistant reasoning turns anchor the model's own prior chain
         * of thought. Keep them when budget allows.
         */
        ASSISTANT_TRAJECTORY,
        /**
         * User messages are the conversation backbone. Drop only as a last
         * resort among optional content.
         */
        USER_MESSAGE
    }

    private final ModelTokenEstimator tokens;

    public ModelContextWindowPlanner(ModelTokenEstimator tokens) {
        this.tokens = tokens;
    }

    public WindowPlan plan(
            String systemInstruction,
            List<ModelInputItem> facts,
            List<ModelRequest.ToolDefinition> tools,
            ContextBudget budget
    ) {
        return plan(
                systemInstruction,
                facts,
                tools,
                budget,
                Set.of(),
                Set.of()
        );
    }

    public WindowPlan plan(
            String systemInstruction,
            List<ModelInputItem> facts,
            List<ModelRequest.ToolDefinition> tools,
            ContextBudget budget,
            Set<String> requiredUserFactIds
    ) {
        return plan(
                systemInstruction,
                facts,
                tools,
                budget,
                requiredUserFactIds,
                Set.of()
        );
    }

    public WindowPlan plan(
            String systemInstruction,
            List<ModelInputItem> facts,
            List<ModelRequest.ToolDefinition> tools,
            ContextBudget budget,
            Set<String> requiredUserFactIds,
            Set<String> requiredObservationIds
    ) {
        validateBudget(budget);
        Set<String> requiredUsers = requiredUserFactIds == null
                ? Set.of()
                : Set.copyOf(requiredUserFactIds);
        Set<String> requiredObservations = requiredObservationIds == null
                ? Set.of()
                : Set.copyOf(requiredObservationIds);
        int fixed = tokens.estimateText(systemInstruction)
                + tokens.estimate(tools)
                + budget.reservedOutputTokens()
                + PROTOCOL_HEADROOM_TOKENS;
        int available = budget.maxInputTokens() - fixed;
        if (available <= 0) {
            throw new PromptTooLargeException(
                    "System instruction and provider tool surface exceed the input budget"
            );
        }

        List<AtomicGroup> groups = atomicGroups(facts);
        boolean[] included = new boolean[groups.size()];
        int used = 0;
        int latestUserIndex = -1;
        for (int index = groups.size() - 1; index >= 0; index--) {
            if (groups.get(index).items().stream().anyMatch(
                    ModelInputItem.UserText.class::isInstance
            )) {
                latestUserIndex = index;
                break;
            }
        }
        if (latestUserIndex < 0) {
            throw new PromptTooLargeException(
                    "Model context has no user request"
            );
        }
        for (int index = 0; index < groups.size(); index++) {
            if (isRequiredGroup(
                    groups.get(index),
                    index,
                    latestUserIndex,
                    requiredUsers,
                    requiredObservations
            )) {
                int cost = tokens.estimate(groups.get(index).items());
                if (used + cost > available) {
                    throw new PromptTooLargeException(
                            "Current Turn instructions and non-refetchable tool evidence exceed the input budget"
                    );
                }
                included[index] = true;
                used += cost;
            }
        }

        List<Integer> candidateIndices = new ArrayList<>();
        for (int index = 0; index < groups.size(); index++) {
            if (!included[index]) {
                candidateIndices.add(index);
            }
        }
        candidateIndices.sort(java.util.Comparator
                .comparingInt(
                        (Integer index) -> dropPriority(
                                groups.get(index)
                        ).ordinal()
                )
                .thenComparingInt(index -> index));
        for (int index : candidateIndices) {
            AtomicGroup group = groups.get(index);
            int cost = tokens.estimate(group.items());
            if (used + cost <= available) {
                included[index] = true;
                used += cost;
            }
        }

        List<ModelInputItem> selected = new ArrayList<>();
        int dropped = 0;
        for (int index = 0; index < groups.size(); index++) {
            if (included[index]) {
                selected.addAll(groups.get(index).items());
            } else {
                dropped += groups.get(index).items().size();
            }
        }
        return new WindowPlan(
                selected,
                fixed + used - budget.reservedOutputTokens(),
                dropped,
                budget
        );
    }

    private boolean containsRequiredUser(
            AtomicGroup group,
            Set<String> requiredUserFactIds
    ) {
        return group.items().stream().anyMatch(item ->
                item instanceof ModelInputItem.UserText user
                        && requiredUserFactIds.contains(user.messageId())
        );
    }

    private boolean containsRequiredObservation(
            AtomicGroup group,
            Set<String> requiredObservationIds
    ) {
        return group.items().stream().anyMatch(item ->
                item instanceof ModelInputItem.ToolResult result
                        && requiredObservationIds.contains(
                        result.observationId()
                )
        );
    }

    private boolean isRequiredGroup(
            AtomicGroup group,
            int groupIndex,
            int latestUserIndex,
            Set<String> requiredUserFactIds,
            Set<String> requiredObservationIds
    ) {
        if (group.items().stream().anyMatch(
                item -> item.stability() == ModelInputItem.Stability.STATIC
        )) {
            return true;
        }
        if (groupIndex == latestUserIndex) {
            return true;
        }
        if (containsRequiredUser(group, requiredUserFactIds)) {
            return true;
        }
        if (containsRequiredObservation(group, requiredObservationIds)) {
            return true;
        }
        return group.items().stream().anyMatch(item ->
                item instanceof ModelInputItem.ContinuationDirective
                        || item instanceof ModelInputItem.FinalizationDirective
                        || item instanceof ModelInputItem.TaskWorkState
                        || item instanceof ModelInputItem.CapabilityRuntimeState
                        || item instanceof ModelInputItem.RuntimePulse
        );
    }

    private DropPriority dropPriority(AtomicGroup group) {
        List<ModelInputItem> items = group.items();
        if (items.stream().anyMatch(
                ModelInputItem.ToolResult.class::isInstance
        )) {
            return DropPriority.TOOL_OBSERVATION_TRAJECTORY;
        }
        if (items.stream().anyMatch(
                ModelInputItem.HistorySummary.class::isInstance
        )) {
            return DropPriority.HISTORY_SUMMARY;
        }
        if (items.stream().anyMatch(
                ModelInputItem.ArtifactContextIndex.class::isInstance
        )) {
            return DropPriority.ARTIFACT_INDEX;
        }
        if (items.stream().anyMatch(
                ModelInputItem.AgentRunState.class::isInstance
        )) {
            return DropPriority.AGENT_RUN_STATE;
        }
        if (items.stream().anyMatch(item ->
                item instanceof ModelInputItem.AssistantText
                        || item instanceof ModelInputItem.AssistantProviderState
                        || item instanceof ModelInputItem.AssistantToolCall
                        || item instanceof ModelInputItem.ContinuationDirective
        )) {
            return DropPriority.ASSISTANT_TRAJECTORY;
        }
        return DropPriority.USER_MESSAGE;
    }

    private List<AtomicGroup> atomicGroups(List<ModelInputItem> facts) {
        List<AtomicGroup> groups = new ArrayList<>();
        Map<String, MutableAssistantTrajectory> trajectories =
                new LinkedHashMap<>();
        Map<String, MutableAssistantTrajectory> toolGroups =
                new LinkedHashMap<>();
        Set<String> resultIds = new HashSet<>();
        for (ModelInputItem fact : facts) {
            if (fact instanceof ModelInputItem.AssistantProviderState state) {
                trajectory(
                        state.attemptId(),
                        trajectories,
                        groups
                ).add(state);
            } else if (fact instanceof ModelInputItem.AssistantText text) {
                trajectory(
                        text.attemptId(),
                        trajectories,
                        groups
                ).add(text);
            } else if (fact
                    instanceof ModelInputItem.ContinuationDirective directive) {
                MutableAssistantTrajectory group =
                        trajectories.get(directive.attemptId());
                if (group == null) {
                    throw protocol(
                            "Continuation directive has no preceding assistant attempt"
                    );
                }
                group.add(directive);
            } else if (fact instanceof ModelInputItem.AssistantToolCall call) {
                if (toolGroups.containsKey(call.toolCallId())) {
                    throw protocol("Duplicate ToolCall in model context");
                }
                MutableAssistantTrajectory group = trajectory(
                        call.attemptId(),
                        trajectories,
                        groups
                );
                group.add(call);
                toolGroups.put(call.toolCallId(), group);
            } else if (fact instanceof ModelInputItem.ToolResult result) {
                MutableAssistantTrajectory group =
                        toolGroups.get(result.toolCallId());
                if (group == null) {
                    throw protocol(
                            "ToolResult has no preceding assistant ToolCall"
                    );
                }
                if (!group.attemptId().equals(
                        result.assistantAttemptId()
                )) {
                    throw protocol(
                            "ToolResult belongs to another assistant attempt"
                    );
                }
                if (!resultIds.add(result.toolCallId())) {
                    throw protocol("ToolCall has duplicate ToolResult facts");
                }
                group.add(result);
            } else {
                groups.add(new ImmutableGroup(List.of(fact)));
            }
        }
        for (Map.Entry<String, MutableAssistantTrajectory> entry
                : toolGroups.entrySet()) {
            if (!resultIds.contains(entry.getKey())) {
                throw protocol(
                        "Completed context contains ToolCall without ToolResult"
                );
            }
        }
        return List.copyOf(groups);
    }

    private MutableAssistantTrajectory trajectory(
            String attemptId,
            Map<String, MutableAssistantTrajectory> trajectories,
            List<AtomicGroup> groups
    ) {
        if (attemptId == null || attemptId.isBlank()) {
            throw protocol("Assistant fact has no source attempt");
        }
        MutableAssistantTrajectory existing = trajectories.get(attemptId);
        if (existing != null) {
            return existing;
        }
        MutableAssistantTrajectory created =
                new MutableAssistantTrajectory(attemptId);
        trajectories.put(attemptId, created);
        groups.add(created);
        return created;
    }

    private ModelProtocolException protocol(String message) {
        return new ModelProtocolException(
                "invalid_tool_pair_in_context",
                message
        );
    }

    private void validateBudget(ContextBudget budget) {
        if (budget == null
                || budget.maxInputTokens() < 1024
                || budget.reservedOutputTokens() < 1
                || budget.reservedOutputTokens()
                >= budget.maxInputTokens()) {
            throw new IllegalArgumentException(
                    "Invalid model context budget"
            );
        }
    }

    public record ContextBudget(
            int maxInputTokens,
            int reservedOutputTokens
    ) {
        public static ContextBudget defaults() {
            return new ContextBudget(120_000, 8_192);
        }
    }

    public record WindowPlan(
            List<ModelInputItem> items,
            int estimatedInputTokens,
            int droppedFactCount,
            ContextBudget budget
    ) {
        public WindowPlan {
            items = List.copyOf(items);
        }
    }

    private sealed interface AtomicGroup
            permits ImmutableGroup, MutableAssistantTrajectory {
        List<ModelInputItem> items();
    }

    private record ImmutableGroup(
            List<ModelInputItem> items
    ) implements AtomicGroup {
    }

    private static final class MutableAssistantTrajectory
            implements AtomicGroup {
        private final String attemptId;
        private final List<ModelInputItem> items = new ArrayList<>();

        private MutableAssistantTrajectory(String attemptId) {
            this.attemptId = attemptId;
        }

        private String attemptId() {
            return attemptId;
        }

        private void add(ModelInputItem item) {
            items.add(item);
        }

        @Override
        public List<ModelInputItem> items() {
            return List.copyOf(items);
        }
    }
}
