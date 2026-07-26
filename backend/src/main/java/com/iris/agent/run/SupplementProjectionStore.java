package com.iris.agent.run;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.run.RunRoundRepository.RoundRow;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.conversation.domain.SupplementCommands.SupplementView;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.Instant;

/**
 * SQLite representation of supplement render projections. It contains no
 * boundary policy; callers decide when a supplement becomes visible.
 */
@Repository
public class SupplementProjectionStore {
    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;

    public SupplementProjectionStore(
            JdbcClient jdbc,
            ObjectMapper objectMapper
    ) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
    }

    public ObjectNode insert(
            RunRow run,
            RoundRow round,
            SupplementView supplement,
            Instant now
    ) {
        int ordinal = nextOrdinal(run.turnId());
        ObjectNode node = objectMapper.createObjectNode();
        node.put("nodeId", "node_" + supplement.supplementId());
        node.put("turnId", run.turnId());
        node.put("runId", run.runId());
        node.put("roundId", round.roundId());
        node.putNull("pipelineStepRunId");
        node.putNull("groupId");
        node.put("ordinal", ordinal);
        node.put("rendererKey", "supplement");
        node.put("version", 1);
        node.put("createdAt", now.toString());
        node.put("updatedAt", now.toString());
        node.put("type", "supplement");
        node.put("status", "injected");
        node.put("supplementId", supplement.supplementId());
        node.put("messageId", supplement.messageId());
        node.put("state", supplement.state());
        node.put("text", supplement.text());
        node.set(
                "attachmentRefs",
                objectMapper.valueToTree(supplement.attachmentRefs())
        );
        if (supplement.injectedAfterRoundId() == null) {
            node.putNull("injectedAfterRoundId");
        } else {
            node.put(
                    "injectedAfterRoundId",
                    supplement.injectedAfterRoundId()
            );
        }

        jdbc.sql("""
                INSERT INTO render_node_projection(
                    node_id, conversation_id, branch_id, turn_id, run_id,
                    round_id, pipeline_step_run_id, node_type, node_status,
                    group_id, ordinal, renderer_key, version,
                    final_content_hash, projection_json, created_at, updated_at
                ) VALUES (
                    :nodeId, :conversationId, :branchId, :turnId, :runId,
                    :roundId, NULL, 'supplement', 'injected',
                    NULL, :ordinal, 'supplement', 1,
                    NULL, :projection, :now, :now
                )
                """)
                .param("nodeId", node.path("nodeId").asText())
                .param("conversationId", run.conversationId())
                .param("branchId", run.branchId())
                .param("turnId", run.turnId())
                .param("runId", run.runId())
                .param("roundId", round.roundId())
                .param("ordinal", ordinal)
                .param("projection", node.toString())
                .param("now", now.toString())
                .update();
        return node;
    }

    public String previousRoundId(String runId, int currentIndex) {
        return jdbc.sql("""
                SELECT round_id FROM agent_round
                WHERE run_id = :runId AND round_index < :currentIndex
                ORDER BY round_index DESC LIMIT 1
                """)
                .param("runId", runId)
                .param("currentIndex", currentIndex)
                .query(String.class)
                .optional()
                .orElse(null);
    }

    private int nextOrdinal(String turnId) {
        return jdbc.sql("""
                SELECT COALESCE(MAX(ordinal), -1) + 1
                FROM render_node_projection
                WHERE turn_id = :turnId
                """)
                .param("turnId", turnId)
                .query(Integer.class)
                .single();
    }
}
