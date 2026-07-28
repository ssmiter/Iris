package com.iris.agent.model;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.ModelContextWindowPlanner.ContextBudget;
import com.iris.tools.core.ToolManifest.ContextRetention;
import com.iris.tools.core.ToolRegistry;
import com.iris.tools.core.ToolRegistry.ToolBinding;
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
    private static final double TRIGGER_WATERLINE = 0.70;
    private static final double TARGET_WATERLINE = 0.60;
    private static final int KEEP_RECENT_REFETCHABLE = 6;

    private final ToolRegistry tools;
    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;
    private final ModelTokenEstimator tokens;
    private final Clock clock = Clock.systemUTC();

    public ToolObservationMicroCompactor(
            ToolRegistry tools,
            JdbcClient jdbc,
            ObjectMapper objectMapper,
            ModelTokenEstimator tokens
    ) {
        this.tools = tools;
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.tokens = tokens;
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
                        callNames.get(result.toolCallId())
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
        int trigger = (int) Math.floor(usableTokens * TRIGGER_WATERLINE);
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
                            callNames.get(result.toolCallId())
                    )) {
                candidates.add(index);
            }
        }
        int eligibleEnd = Math.max(
                0,
                candidates.size() - KEEP_RECENT_REFETCHABLE
        );
        int target = (int) Math.floor(usableTokens * TARGET_WATERLINE);
        int decisionsAdded = 0;
        for (int candidateIndex = 0;
                candidateIndex < eligibleEnd && estimated > target;
                candidateIndex++) {
            int itemIndex = candidates.get(candidateIndex);
            ModelInputItem.ToolResult result =
                    (ModelInputItem.ToolResult) projected.get(itemIndex);
            String toolName = callNames.get(result.toolCallId());
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
        ToolBinding binding = tools.find(toolName).orElse(null);
        return binding != null
                && binding.manifestHash().equals(result.manifestHash())
                && binding.manifest().contextRetention()
                == ContextRetention.REFETCHABLE;
    }

    private ModelInputItem.ToolResult compacted(
            ModelInputItem.ToolResult result,
            String toolName
    ) {
        ObjectNode content = result.content().isObject()
                ? ((ObjectNode) result.content()).deepCopy()
                : objectMapper.createObjectNode();
        content.put("toolName", toolName == null ? "unknown" : toolName);
        content.put("status", "succeeded");
        content.put("isError", false);
        ObjectNode output = objectMapper.createObjectNode();
        output.put("microCompacted", true);
        output.put(
                "resultReference",
                "tool-result://" + result.executionId()
        );
        output.put("contentHash", result.payloadHash());
        output.put(
                "guidance",
                "旧的可重取结果已从当前视野收敛；需要原文时调用 read_tool_result"
        );
        content.set("output", output);
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
