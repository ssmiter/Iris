package com.iris.agent.model;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.ModelAttemptRepository.FinalAnswerSource;
import com.iris.agent.run.RunRoundRepository;
import com.iris.agent.run.RunRoundRepository.RoundRow;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.conversation.application.ConversationEventAppender;
import com.iris.conversation.application.ConversationEventAppender.EventDraft;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Optional;
import java.util.UUID;

@Service
public class AnswerProjectionService {
    private final JdbcClient jdbc;
    private final ModelAttemptRepository attempts;
    private final RunRoundRepository runs;
    private final TransactionTemplate transactions;
    private final ObjectMapper objectMapper;
    private final ConversationEventAppender events;
    private final Clock clock = Clock.systemUTC();

    public AnswerProjectionService(
            JdbcClient jdbc,
            ModelAttemptRepository attempts,
            RunRoundRepository runs,
            TransactionTemplate transactions,
            ObjectMapper objectMapper,
            ConversationEventAppender events
    ) {
        this.jdbc = jdbc;
        this.attempts = attempts;
        this.runs = runs;
        this.transactions = transactions;
        this.objectMapper = objectMapper;
        this.events = events;
    }

    public PublishedAnswer publishFinal(String roundId) {
        return publish(roundId, "final", true).orElseThrow();
    }

    public Optional<PublishedAnswer> publishStage(String roundId) {
        return publish(roundId, "stage", false);
    }

    private Optional<PublishedAnswer> publish(
            String roundId,
            String role,
            boolean textRequired
    ) {
        PublishedAnswer result = transactions.execute(status ->
                publishOnce(roundId, role, textRequired)
        );
        if (result == null) {
            if (!textRequired) {
                return Optional.empty();
            }
            throw new IllegalStateException(
                    "Answer projection transaction returned no result"
            );
        }
        if (!result.replayed()) {
            emitAdded(roundId, result.nodeId());
        }
        return Optional.of(result);
    }

    private PublishedAnswer publishOnce(
            String roundId,
            String role,
            boolean textRequired
    ) {
        ExistingAnswer existing = existing(roundId);
        if (existing != null) {
            return new PublishedAnswer(
                    existing.nodeId(),
                    existing.messageId(),
                    true
            );
        }
        RoundRow round = runs.findRound(roundId).orElseThrow();
        if (("final".equals(role) && round.toolCallCount() != 0)
                || ("stage".equals(role) && round.toolCallCount() == 0)) {
            throw new IllegalStateException(
                    "Answer role does not match Round tool-call state"
            );
        }
        RunRow run = runs.findRun(round.runId()).orElseThrow();
        FinalAnswerSource source = attempts.finalAnswer(roundId).orElseThrow(
                () -> new IllegalStateException(
                        "Completed Round has no completed ModelAttempt"
                )
        );
        if (source.text() == null || source.text().isBlank()) {
            if (!textRequired) {
                return null;
            }
            throw new ModelProtocolException(
                    "final_answer_empty",
                    "Final model response contains no visible text"
            );
        }

        Instant now = clock.instant();
        String messageId = id("msg");
        String nodeId = id("node");
        int ordinal = nextOrdinal(run.turnId());
        jdbc.sql("""
                INSERT INTO message(
                    message_id, conversation_id, branch_id, turn_id,
                    role, content, client_request_id, created_at
                ) VALUES (
                    :messageId, :conversationId, :branchId, :turnId,
                    'assistant', :content, NULL, :now
                )
                """)
                .param("messageId", messageId)
                .param("conversationId", run.conversationId())
                .param("branchId", run.branchId())
                .param("turnId", run.turnId())
                .param("content", source.text())
                .param("now", now.toString())
                .update();

        ObjectNode projection = objectMapper.createObjectNode();
        projection.put("nodeId", nodeId);
        projection.put("turnId", run.turnId());
        projection.put("runId", run.runId());
        projection.put("roundId", roundId);
        projection.putNull("pipelineStepRunId");
        projection.putNull("groupId");
        projection.put("ordinal", ordinal);
        projection.put("rendererKey", "default");
        projection.put("version", 1);
        projection.put("createdAt", now.toString());
        projection.put("updatedAt", now.toString());
        projection.put("type", "answer");
        projection.put("status", "completed");
        projection.put("content", source.text());
        projection.put("role", role);
        projection.put("sourceMessageId", messageId);

        jdbc.sql("""
                INSERT INTO render_node_projection(
                    node_id, conversation_id, branch_id, turn_id, run_id,
                    round_id, pipeline_step_run_id, node_type, node_status,
                    group_id, ordinal, renderer_key, version,
                    final_content_hash, projection_json, created_at, updated_at
                ) VALUES (
                    :nodeId, :conversationId, :branchId, :turnId, :runId,
                    :roundId, NULL, 'answer', 'completed',
                    NULL, :ordinal, 'default', 1,
                    :contentHash, :projection, :now, :now
                )
                """)
                .param("nodeId", nodeId)
                .param("conversationId", run.conversationId())
                .param("branchId", run.branchId())
                .param("turnId", run.turnId())
                .param("runId", run.runId())
                .param("roundId", roundId)
                .param("ordinal", ordinal)
                .param("contentHash", hash(source.text()))
                .param("projection", projection.toString())
                .param("now", now.toString())
                .update();
        int linked = jdbc.sql("""
                UPDATE agent_round
                SET answer_node_id = :nodeId, version = version + 1,
                    updated_at = :now
                WHERE round_id = :roundId AND answer_node_id IS NULL
                """)
                .param("nodeId", nodeId)
                .param("now", now.toString())
                .param("roundId", roundId)
                .update();
        if (linked != 1) {
            throw new IllegalStateException(
                    "Round answer was concurrently published"
            );
        }
        return new PublishedAnswer(nodeId, messageId, false);
    }

    private ExistingAnswer existing(String roundId) {
        return jdbc.sql("""
                SELECT ar.answer_node_id, json_extract(
                           rp.projection_json, '$.sourceMessageId'
                       ) AS source_message_id
                FROM agent_round ar
                JOIN render_node_projection rp
                  ON rp.node_id = ar.answer_node_id
                WHERE ar.round_id = :roundId
                """)
                .param("roundId", roundId)
                .query((rs, rowNum) -> new ExistingAnswer(
                        rs.getString("answer_node_id"),
                        rs.getString("source_message_id")
                ))
                .optional()
                .orElse(null);
    }

    private void emitAdded(String roundId, String nodeId) {
        RoundRow round = runs.findRound(roundId).orElseThrow();
        RunRow run = runs.findRun(round.runId()).orElseThrow();
        String json = jdbc.sql("""
                SELECT projection_json
                FROM render_node_projection
                WHERE node_id = :nodeId
                """)
                .param("nodeId", nodeId)
                .query(String.class)
                .single();
        ObjectNode node;
        try {
            node = (ObjectNode) objectMapper.readTree(json);
        } catch (com.fasterxml.jackson.core.JsonProcessingException exception) {
            throw new IllegalStateException(
                    "Stored answer projection is invalid JSON",
                    exception
            );
        }
        ObjectNode payload = objectMapper.createObjectNode();
        payload.set("node", node);
        events.append(new EventDraft(
                "render_node.added",
                run.conversationId(),
                run.branchId(),
                run.turnId(),
                run.runId(),
                "render_node",
                nodeId,
                node.path("version").asLong(),
                roundId,
                run.runId(),
                payload
        ));
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

    private String hash(String value) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(
                            value.getBytes(StandardCharsets.UTF_8)
                    )
            );
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 unavailable", exception);
        }
    }

    private String id(String prefix) {
        return prefix + "_" + UUID.randomUUID().toString().replace("-", "");
    }

    public record PublishedAnswer(
            String nodeId,
            String messageId,
            boolean replayed
    ) {
    }

    private record ExistingAnswer(String nodeId, String messageId) {
    }
}
