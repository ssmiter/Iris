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
        validateBudget(budget);
        int fixed = tokens.estimateText(systemInstruction)
                + tokens.estimate(tools)
                + budget.reservedOutputTokens()
                + PROTOCOL_HEADROOM_TOKENS;
        int available = budget.maxInputTokens() - fixed;
        if (available <= 0) {
            throw new PromptTooLargeException(
                    "System instruction and capability lease exceed the input budget"
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
            boolean required = index == latestUserIndex
                    || groups.get(index).items().stream().anyMatch(
                    ModelInputItem.HistorySummary.class::isInstance
            );
            if (!required) {
                continue;
            }
            int cost = tokens.estimate(groups.get(index).items());
            if (used + cost > available) {
                throw new PromptTooLargeException(
                        "Required user request and compact summary exceed the input budget"
                );
            }
            included[index] = true;
            used += cost;
        }
        for (int index = groups.size() - 1; index >= 0; index--) {
            if (included[index]) {
                continue;
            }
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

    private List<AtomicGroup> atomicGroups(List<ModelInputItem> facts) {
        List<AtomicGroup> groups = new ArrayList<>();
        Map<String, MutableToolGroup> toolGroups = new LinkedHashMap<>();
        Set<String> resultIds = new HashSet<>();
        for (ModelInputItem fact : facts) {
            if (fact instanceof ModelInputItem.AssistantToolCall call) {
                if (toolGroups.containsKey(call.toolCallId())) {
                    throw protocol("Duplicate ToolCall in model context");
                }
                MutableToolGroup group = new MutableToolGroup(
                        call
                );
                toolGroups.put(call.toolCallId(), group);
                groups.add(group);
            } else if (fact instanceof ModelInputItem.ToolResult result) {
                MutableToolGroup group = toolGroups.get(result.toolCallId());
                if (group == null) {
                    throw protocol(
                            "ToolResult has no preceding assistant ToolCall"
                    );
                }
                if (!resultIds.add(result.toolCallId())) {
                    throw protocol("ToolCall has duplicate ToolResult facts");
                }
                group.addResult(result);
            } else {
                groups.add(new ImmutableGroup(List.of(fact)));
            }
        }
        for (Map.Entry<String, MutableToolGroup> entry : toolGroups.entrySet()) {
            if (!resultIds.contains(entry.getKey())) {
                throw protocol(
                        "Completed context contains ToolCall without ToolResult"
                );
            }
        }
        return List.copyOf(groups);
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
            permits ImmutableGroup, MutableToolGroup {
        List<ModelInputItem> items();
    }

    private record ImmutableGroup(
            List<ModelInputItem> items
    ) implements AtomicGroup {
    }

    private static final class MutableToolGroup implements AtomicGroup {
        private final List<ModelInputItem> items = new ArrayList<>(2);

        private MutableToolGroup(
                ModelInputItem.AssistantToolCall call
        ) {
            items.add(call);
        }

        private void addResult(ModelInputItem.ToolResult result) {
            items.add(result);
        }

        @Override
        public List<ModelInputItem> items() {
            return List.copyOf(items);
        }
    }
}
