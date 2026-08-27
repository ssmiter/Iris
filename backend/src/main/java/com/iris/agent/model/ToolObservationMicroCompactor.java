package com.iris.agent.model;

import com.iris.agent.model.ModelContextWindowPlanner.ContextBudget;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 只改变新 ModelContext 的 Tool Observation 投影，不改写规范历史。
 */
@Service
public class ToolObservationMicroCompactor {

    private static final int PROTOCOL_HEADROOM_TOKENS = 512;

    private final JdbcClient jdbc;
    private final ToolResultContextProjector contextProjector;
    private final ModelTokenEstimator tokens;
    private final int keepRecentRefetchable;
    private final double triggerWaterline;
    private final double targetWaterline;
    private final Clock clock = Clock.systemUTC();

    public ToolObservationMicroCompactor(
            JdbcClient jdbc,
            ToolResultContextProjector contextProjector,
            ModelTokenEstimator tokens,
            ToolObservationMicroCompactProperties properties
    ) {
        this.jdbc = jdbc;
        this.contextProjector = contextProjector;
        this.tokens = tokens;
        this.keepRecentRefetchable = properties.getKeepRecent();
        this.triggerWaterline = properties.getTriggerRatio();
        this.targetWaterline = properties.getTargetRatio();
    }

    public Projection project(
            String conversationId,
            String systemInstruction,
            List<ModelInputItem> sourceItems,
            List<ModelRequest.ToolDefinition> definitions,
            ContextBudget budget
    ) {
        Map<String, String> callNames = callNames(sourceItems);
        Set<String> frozen = frozenDecisions(conversationId);
        List<ModelInputItem> projected = new ArrayList<>(sourceItems);
        int compacted = 0;
        int tokensSaved = 0;

        for (int index = 0; index < projected.size(); index++) {
            ModelInputItem item = projected.get(index);
            if (item instanceof ModelInputItem.ToolResult result
                    && frozen.contains(result.observationId())) {
                ModelInputItem.ToolResult replacement = compacted(
                        result,
                        effectiveToolName(result, callNames)
                );
                tokensSaved += Math.max(
                        0,
                        tokens.estimate(result) - tokens.estimate(replacement)
                );
                projected.set(index, replacement);
                compacted++;
            }
        }

        int usableTokens = budget.maxInputTokens()
                - budget.reservedOutputTokens();
        int estimated = estimate(
                systemInstruction,
                definitions,
                projected
        );
        int trigger = (int) Math.floor(usableTokens * triggerWaterline);
        if (estimated <= trigger) {
            return new Projection(
                    List.copyOf(projected),
                    compacted,
                    0,
                    tokensSaved
            );
        }

        List<Integer> candidates = new ArrayList<>();
        for (int index = 0; index < projected.size(); index++) {
            ModelInputItem item = projected.get(index);
            if (item instanceof ModelInputItem.ToolResult result
                    && !frozen.contains(result.observationId())
                    && refetchable(
                            result,
                            effectiveToolName(result, callNames)
                    )) {
                candidates.add(index);
            }
        }
        int eligibleEnd = Math.max(
                0,
                candidates.size() - keepRecentRefetchable
        );
        int target = (int) Math.floor(usableTokens * targetWaterline);
        int decisionsAdded = 0;
        for (int candidateIndex = 0;
                candidateIndex < eligibleEnd && estimated > target;
                candidateIndex++) {
            int itemIndex = candidates.get(candidateIndex);
            ModelInputItem.ToolResult result =
                    (ModelInputItem.ToolResult) projected.get(itemIndex);
            String toolName = effectiveToolName(result, callNames);
            ModelInputItem.ToolResult replacement = compacted(
                    result,
                    toolName
            );
            int saved = Math.max(
                    0,
                    tokens.estimate(result) - tokens.estimate(replacement)
            );
            if (saved == 0) {
                continue;
            }
            if (!freeze(result)) {
                continue;
            }
            projected.set(itemIndex, replacement);
            estimated -= saved;
            tokensSaved += saved;
            compacted++;
            decisionsAdded++;
        }
        return new Projection(
                List.copyOf(projected),
                compacted,
                decisionsAdded,
                tokensSaved
        );
    }

    /**
     * Returns observations that cannot be safely replaced by a stable result
     * reference under the exact Definition visible in this process.
     */
    public Set<String> pinnedObservationIds(
            List<ModelInputItem> items
    ) {
        Map<String, String> names = callNames(items);
        Set<String> pinned = new HashSet<>();
        for (ModelInputItem item : items) {
            if (item instanceof ModelInputItem.ToolResult result
                    && !refetchable(
                    result,
                    effectiveToolName(result, names)
            )) {
                pinned.add(result.observationId());
            }
        }
        return Set.copyOf(pinned);
    }

    private boolean refetchable(
            ModelInputItem.ToolResult result,
            String toolName
    ) {
        if (!"succeeded".equals(result.outcomeKind())
                || result.executionId() == null
                || result.payloadHash() == null
                || toolName == null) {
            return false;
        }
        return contextProjector.canReplace(
                result.outcomeKind(),
                result.executionId(),
                result.payloadHash(),
                toolName,
                result.manifestHash()
        );
    }

    private ModelInputItem.ToolResult compacted(
            ModelInputItem.ToolResult result,
            String toolName
    ) {
        String visibleToolName = result.content()
                .path("toolName")
                .asText(null);
        var content = contextProjector.toReference(
                result.content(),
                visibleToolName,
                toolName,
                result.executionId(),
                result.payloadHash()
        );
        return new ModelInputItem.ToolResult(
                result.assistantAttemptId(),
                result.observationId(),
                result.toolCallId(),
                result.providerCallId(),
                result.executionId(),
                result.outcomeKind(),
                result.manifestHash(),
                result.payloadHash(),
                content
        );
    }

    private Map<String, String> callNames(List<ModelInputItem> items) {
        Map<String, String> names = new HashMap<>();
        for (ModelInputItem item : items) {
            if (item instanceof ModelInputItem.AssistantToolCall call) {
                names.put(call.toolCallId(), call.name());
            }
        }
        return names;
    }

    private String effectiveToolName(
            ModelInputItem.ToolResult result,
            Map<String, String> visibleNames
    ) {
        String resolved = result.content()
                .path("resolvedToolName")
                .asText("")
                .trim();
        return resolved.isBlank()
                ? visibleNames.get(result.toolCallId())
                : resolved;
    }

    private Set<String> frozenDecisions(String conversationId) {
        return new HashSet<>(jdbc.sql("""
                SELECT decision.observation_id
                FROM tool_observation_retention_decision decision
                JOIN tool_observation observation
                  ON observation.observation_id = decision.observation_id
                JOIN tool_execution execution
                  ON execution.execution_id = observation.execution_id
                WHERE execution.conversation_id = :conversationId
                  AND decision.decision = 'micro_compacted'
                """)
                .param("conversationId", conversationId)
                .query(String.class)
                .list());
    }

    private boolean freeze(ModelInputItem.ToolResult result) {
        return jdbc.sql("""
                INSERT INTO tool_observation_retention_decision(
                    observation_id, execution_id, decision,
                    payload_hash, created_at
                )
                SELECT :observationId, :executionId, 'micro_compacted',
                       :payloadHash, :now
                FROM tool_observation observation
                JOIN tool_output_payload payload
                  ON payload.execution_id = observation.execution_id
                WHERE observation.observation_id = :observationId
                  AND observation.execution_id = :executionId
                  AND payload.content_hash = :payloadHash
                ON CONFLICT(observation_id) DO NOTHING
                """)
                .param("observationId", result.observationId())
                .param("executionId", result.executionId())
                .param("payloadHash", result.payloadHash())
                .param("now", clock.instant().toString())
                .update() == 1;
    }

    private int estimate(
            String systemInstruction,
            List<ModelRequest.ToolDefinition> definitions,
            List<ModelInputItem> items
    ) {
        return tokens.estimateText(systemInstruction)
                + tokens.estimate(definitions)
                + tokens.estimate(items)
                + PROTOCOL_HEADROOM_TOKENS;
    }

    public record Projection(
            List<ModelInputItem> items,
            int compactedObservationCount,
            int decisionsAdded,
            int estimatedTokensSaved
    ) {
        public Projection {
            items = List.copyOf(items);
        }
    }
}
