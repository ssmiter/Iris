package com.iris.agent.model;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.CompactionService.CompactPlan;
import com.iris.conversation.domain.CompactionViews.CompactionView;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public class CompactionRepository {
    private static final int MIN_REFERENCE_PROJECTION_CHARACTERS = 2_048;

    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;
    private final ModelTokenEstimator tokens;
    private final ToolResultContextProjector contextProjector;

    public CompactionRepository(
            JdbcClient jdbc,
            ObjectMapper objectMapper,
            ModelTokenEstimator tokens,
            ToolResultContextProjector contextProjector
    ) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.tokens = tokens;
        this.contextProjector = contextProjector;
    }

    public SourceSnapshot buildSource(CompactPlan plan) {
        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("schemaVersion", 2);
        payload.put("parentFrameId", plan.parentFrameId());
        payload.put("sourceStartSequence", plan.sourceStartSequence());
        payload.put("waterlineSequence", plan.waterlineSequence());
        payload.put("beforeTurnId", plan.beforeTurnId());
        priorSummary(plan.parentFrameId()).ifPresentOrElse(
                value -> payload.put("priorFrameSummary", value),
                () -> payload.putNull("priorFrameSummary")
        );
        ArrayNode facts = payload.putArray("facts");
        sourceFacts(plan).forEach(facts::add);
        String json = write(payload);
        return new SourceSnapshot(
                "compact_source_"
                        + UUID.randomUUID().toString().replace("-", ""),
                hash(json),
                json,
                facts.size(),
                tokens.estimateText(json)
        );
    }

    public void insertAccepted(
            String runId,
            String roundId,
            CompactPlan plan,
            SourceSnapshot source,
            String trigger,
            Instant now
    ) {
        if (!"manual".equals(trigger) && !"auto".equals(trigger)) {
            throw new IllegalArgumentException(
                    "Compaction trigger must be manual or auto"
            );
        }
        jdbc.sql("""
                INSERT INTO agent_run(
                    run_id, conversation_id, branch_id, turn_id,
                    parent_run_id, root_run_id, kind, purpose,
                    phase, version, started_at, ended_at
                ) VALUES (
                    :runId, :conversationId, :branchId, :turnId,
                    NULL, :runId, 'pipeline', :purpose,
                    'running', 1, :now, NULL
                )
                """)
                .param("runId", runId)
                .param("conversationId", plan.conversationId())
                .param("branchId", plan.branchId())
                .param("turnId", plan.operationAnchorTurnId())
                .param(
                        "purpose",
                        "auto".equals(trigger)
                                ? "compact_context_auto"
                                : "compact_context"
                )
                .param("now", now.toString())
                .update();
        jdbc.sql("""
                INSERT INTO run_definition_snapshot(
                    run_id, definition_id, definition_version,
                    snapshot_hash, normalized_input_hash,
                    dependency_snapshot_ref, tool_calls_limit,
                    time_limit_ms
                ) VALUES (
                    :runId, 'iris.pipeline.compact', '1',
                    :snapshotHash, :inputHash,
                    :sourceRef, 0, 300000
                )
                """)
                .param("runId", runId)
                .param("snapshotHash", hash("iris.pipeline.compact:1"))
                .param("inputHash", source.contentHash())
                .param("sourceRef", source.snapshotId())
                .update();
        jdbc.sql("""
                INSERT INTO agent_round(
                    round_id, conversation_id, branch_id, turn_id,
                    run_id, round_index, phase, answer_node_id,
                    tool_call_count, duration_ms, version,
                    created_at, updated_at
                ) VALUES (
                    :roundId, :conversationId, :branchId, :turnId,
                    :runId, 0, 'accepted', NULL,
                    0, 0, 1, :now, :now
                )
                """)
                .param("roundId", roundId)
                .param("conversationId", plan.conversationId())
                .param("branchId", plan.branchId())
                .param("turnId", plan.operationAnchorTurnId())
                .param("runId", runId)
                .param("now", now.toString())
                .update();
        jdbc.sql("""
                INSERT INTO compaction_run(
                    run_id, conversation_id, branch_id, phase,
                    parent_frame_id, source_start_sequence,
                    waterline_sequence, before_turn_id,
                    source_snapshot_id, compact_boundary_id,
                    failure_json, version, requested_at,
                    ended_at, updated_at
                ) VALUES (
                    :runId, :conversationId, :branchId, 'accepted',
                    :parentFrameId, :sourceStart, :waterline,
                    :beforeTurnId, :snapshotId, NULL,
                    NULL, 1, :now, NULL, :now
                )
                """)
                .param("runId", runId)
                .param("conversationId", plan.conversationId())
                .param("branchId", plan.branchId())
                .param("parentFrameId", plan.parentFrameId())
                .param("sourceStart", plan.sourceStartSequence())
                .param("waterline", plan.waterlineSequence())
                .param("beforeTurnId", plan.beforeTurnId())
                .param("snapshotId", source.snapshotId())
                .param("now", now.toString())
                .update();
        jdbc.sql("""
                INSERT INTO compaction_source_snapshot(
                    snapshot_id, run_id, content_hash, payload_json,
                    fact_count, estimated_tokens, created_at
                ) VALUES (
                    :snapshotId, :runId, :contentHash, :payload,
                    :factCount, :estimatedTokens, :now
                )
                """)
                .param("snapshotId", source.snapshotId())
                .param("runId", runId)
                .param("contentHash", source.contentHash())
                .param("payload", source.payloadJson())
                .param("factCount", source.factCount())
                .param("estimatedTokens", source.estimatedTokens())
                .param("now", now.toString())
                .update();
    }

    public Optional<CompactionRow> find(String runId) {
        return jdbc.sql("""
                SELECT compact.*, source.content_hash,
                       source.payload_json, source.fact_count,
                       source.estimated_tokens, round.round_id,
                       run.phase AS agent_run_phase,
                       CASE
                         WHEN run.purpose = 'compact_context_auto'
                         THEN 'auto'
                         ELSE 'manual'
                       END AS trigger
                FROM compaction_run compact
                JOIN compaction_source_snapshot source
                  ON source.snapshot_id = compact.source_snapshot_id
                JOIN agent_round round ON round.run_id = compact.run_id
                JOIN agent_run run ON run.run_id = compact.run_id
                WHERE compact.run_id = :runId
                """)
                .param("runId", runId)
                .query((rs, rowNum) -> new CompactionRow(
                        rs.getString("run_id"),
                        rs.getString("conversation_id"),
                        rs.getString("branch_id"),
                        rs.getString("phase"),
                        rs.getString("trigger"),
                        rs.getString("parent_frame_id"),
                        rs.getLong("source_start_sequence"),
                        rs.getLong("waterline_sequence"),
                        rs.getString("before_turn_id"),
                        rs.getString("source_snapshot_id"),
                        rs.getString("content_hash"),
                        rs.getString("payload_json"),
                        rs.getInt("fact_count"),
                        rs.getInt("estimated_tokens"),
                        rs.getString("round_id"),
                        rs.getString("compact_boundary_id"),
                        rs.getString("failure_json"),
                        rs.getLong("version"),
                        Instant.parse(rs.getString("requested_at")),
                        rs.getString("ended_at") == null
                                ? null
                                : Instant.parse(rs.getString("ended_at"))
                ))
                .optional();
    }

    public Optional<CompactionView> view(String runId) {
        return find(runId).map(row -> new CompactionView(
                row.runId(),
                row.conversationId(),
                row.branchId(),
                row.phase(),
                row.trigger(),
                row.parentFrameId(),
                row.sourceStartSequence(),
                row.waterlineSequence(),
                row.beforeTurnId(),
                row.sourceSnapshotId(),
                row.sourceFactCount(),
                row.estimatedTokens(),
                row.boundaryId(),
                row.failureJson() == null
                        ? null
                        : read(row.failureJson()),
                row.version(),
                row.requestedAt(),
                row.endedAt()
        ));
    }

    public List<String> resumableRunIds() {
        return jdbc.sql("""
                SELECT run_id FROM compaction_run
                WHERE phase IN ('accepted', 'running')
                ORDER BY requested_at, run_id
                """)
                .query(String.class)
                .list();
    }

    public boolean hasActive(String conversationId, String branchId) {
        return jdbc.sql("""
                SELECT COUNT(*) FROM compaction_run
                WHERE conversation_id = :conversationId
                  AND branch_id = :branchId
                  AND phase IN ('accepted', 'running')
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .query(Integer.class)
                .single() > 0;
    }

    public Optional<String> completedSummary(String roundId) {
        List<String> blocks = jdbc.sql("""
                SELECT block.text_content
                FROM model_attempt attempt
                JOIN model_content_block block
                  ON block.attempt_id = attempt.attempt_id
                WHERE attempt.round_id = :roundId
                  AND attempt.phase = 'completed'
                  AND block.block_kind = 'text'
                  AND block.text_content IS NOT NULL
                ORDER BY attempt.attempt_index DESC, block.block_index
                """)
                .param("roundId", roundId)
                .query(String.class)
                .list();
        if (blocks.isEmpty()) {
            return Optional.empty();
        }
        return Optional.of(String.join("\n", blocks).trim());
    }

    public Optional<String> streamingAttemptId(String runId) {
        return jdbc.sql("""
                SELECT attempt_id FROM model_attempt
                WHERE run_id = :runId AND phase = 'streaming'
                ORDER BY attempt_index DESC
                LIMIT 1
                """)
                .param("runId", runId)
                .query(String.class)
                .optional();
    }

    public boolean markRunning(
            String runId,
            long expectedVersion,
            Instant now
    ) {
        return jdbc.sql("""
                UPDATE compaction_run
                SET phase = 'running', version = version + 1,
                    updated_at = :now
                WHERE run_id = :runId AND phase = 'accepted'
                  AND version = :expectedVersion
                """)
                .param("now", now.toString())
                .param("runId", runId)
                .param("expectedVersion", expectedVersion)
                .update() == 1;
    }

    public void complete(
            String runId,
            String boundaryId,
            Instant now
    ) {
        int compacted = jdbc.sql("""
                UPDATE compaction_run
                SET phase = 'completed',
                    compact_boundary_id = :boundaryId,
                    version = version + 1, ended_at = :now,
                    updated_at = :now
                WHERE run_id = :runId AND phase = 'running'
                """)
                .param("boundaryId", boundaryId)
                .param("now", now.toString())
                .param("runId", runId)
                .update();
        int run = jdbc.sql("""
                UPDATE agent_run
                SET phase = 'succeeded', version = version + 1,
                    ended_at = :now
                WHERE run_id = :runId AND phase = 'verifying'
                """)
                .param("now", now.toString())
                .param("runId", runId)
                .update();
        if (compacted != 1 || run != 1) {
            throw new IllegalStateException(
                    "Compaction completion state changed concurrently"
            );
        }
    }

    public void fail(String runId, String failureJson, Instant now) {
        jdbc.sql("""
                UPDATE compaction_run
                SET phase = 'failed', failure_json = :failure,
                    version = version + 1, ended_at = :now,
                    updated_at = :now
                WHERE run_id = :runId
                  AND phase IN ('accepted', 'running')
                """)
                .param("failure", failureJson)
                .param("now", now.toString())
                .param("runId", runId)
                .update();
        jdbc.sql("""
                UPDATE agent_run
                SET phase = 'failed', version = version + 1,
                    ended_at = :now
                WHERE run_id = :runId
                  AND phase IN ('running', 'verifying')
                """)
                .param("now", now.toString())
                .param("runId", runId)
                .update();
    }

    private Optional<String> priorSummary(String frameId) {
        return jdbc.sql("""
                SELECT summary.summary_text
                FROM context_frame frame
                JOIN compact_boundary boundary
                  ON boundary.frame_id = frame.frame_id
                JOIN compact_summary summary
                  ON summary.boundary_id = boundary.boundary_id
                WHERE frame.frame_id = :frameId
                  AND frame.frame_kind = 'compact'
                """)
                .param("frameId", frameId)
                .query(String.class)
                .optional();
    }

    private List<JsonNode> sourceFacts(CompactPlan plan) {
        return jdbc.sql("""
                WITH RECURSIVE branch_path(
                    branch_id, cutoff_sequence
                ) AS (
                    SELECT :branchId, NULL
                    UNION ALL
                    SELECT branch.parent_branch_id,
                           fork.source_event_sequence
                    FROM branch_path path
                    JOIN conversation_branch branch
                      ON branch.branch_id = path.branch_id
                    JOIN branch_fork fork
                      ON fork.branch_id = path.branch_id
                    WHERE branch.parent_branch_id IS NOT NULL
                ),
                facts AS (
                    SELECT event.sequence AS event_sequence,
                           -1 AS round_index, -100 AS fact_order,
                           'user' AS fact_kind, message.message_id AS fact_id,
                           message.content AS text_content,
                           NULL AS tool_name, NULL AS json_content,
                           NULL AS outcome_kind,
                           NULL AS execution_id,
                           NULL AS resolved_tool_name,
                           NULL AS manifest_hash,
                           NULL AS payload_hash
                    FROM message
                    JOIN conversation_event event
                      ON event.turn_id = message.turn_id
                     AND event.event_type = 'turn.accepted'
                    JOIN branch_path path
                      ON path.branch_id = message.branch_id
                    WHERE message.conversation_id = :conversationId
                      AND message.role = 'user'
                      AND event.sequence >= :sourceStart
                      AND event.sequence < :waterline
                      AND (
                        path.cutoff_sequence IS NULL
                        OR event.sequence < path.cutoff_sequence
                      )

                    UNION ALL

                    SELECT event.sequence, round.round_index,
                           10 + block.block_index,
                           block.block_kind, block.block_id,
                           block.text_content, call.tool_name,
                           call.arguments_json, NULL,
                           NULL, NULL, NULL, NULL
                    FROM model_attempt attempt
                    JOIN agent_round round
                      ON round.round_id = attempt.round_id
                    JOIN conversation_event event
                      ON event.turn_id = attempt.turn_id
                     AND event.event_type = 'turn.accepted'
                    JOIN branch_path path
                      ON path.branch_id = round.branch_id
                    JOIN model_content_block block
                      ON block.attempt_id = attempt.attempt_id
                    LEFT JOIN model_tool_call call
                      ON call.block_id = block.block_id
                    WHERE attempt.conversation_id = :conversationId
                      AND attempt.phase = 'completed'
                      AND block.block_kind IN ('text', 'tool_call')
                      AND event.sequence >= :sourceStart
                      AND event.sequence < :waterline
                      AND (
                        path.cutoff_sequence IS NULL
                        OR event.sequence < path.cutoff_sequence
                      )

                    UNION ALL

                    SELECT event.sequence, round.round_index,
                           1000 + call.ordinal,
                           'tool_result', observation.observation_id,
                           NULL, call.tool_name,
                           observation.content_json,
                           observation.outcome_kind,
                           execution.execution_id,
                           execution.tool_name,
                           execution.manifest_hash,
                           payload.content_hash
                    FROM tool_observation observation
                    JOIN model_tool_call call
                      ON call.tool_call_id = observation.tool_call_id
                    JOIN tool_execution execution
                      ON execution.execution_id = observation.execution_id
                    LEFT JOIN tool_output_payload payload
                      ON payload.execution_id = execution.execution_id
                    JOIN model_attempt attempt
                      ON attempt.attempt_id = call.attempt_id
                    JOIN agent_round round
                      ON round.round_id = attempt.round_id
                    JOIN conversation_event event
                      ON event.turn_id = attempt.turn_id
                     AND event.event_type = 'turn.accepted'
                    JOIN branch_path path
                      ON path.branch_id = round.branch_id
                    WHERE attempt.conversation_id = :conversationId
                      AND event.sequence >= :sourceStart
                      AND event.sequence < :waterline
                      AND (
                        path.cutoff_sequence IS NULL
                        OR event.sequence < path.cutoff_sequence
                      )
                )
                SELECT * FROM facts
                ORDER BY event_sequence, round_index, fact_order, fact_id
                """)
                .param("conversationId", plan.conversationId())
                .param("branchId", plan.branchId())
                .param("sourceStart", plan.sourceStartSequence())
                .param("waterline", plan.waterlineSequence())
                .query((rs, rowNum) -> {
                    ObjectNode fact = objectMapper.createObjectNode();
                    fact.put("eventSequence", rs.getLong("event_sequence"));
                    fact.put("kind", rs.getString("fact_kind"));
                    fact.put("id", rs.getString("fact_id"));
                    putNullable(
                            fact,
                            "text",
                            rs.getString("text_content")
                    );
                    putNullable(
                            fact,
                            "toolName",
                            rs.getString("tool_name")
                    );
                    String json = rs.getString("json_content");
                    if (json == null) {
                        fact.putNull("content");
                    } else {
                        JsonNode content = read(json);
                        String visibleToolName = rs.getString("tool_name");
                        String resolvedToolName = rs.getString(
                                "resolved_tool_name"
                        );
                        if (resolvedToolName != null
                                && !resolvedToolName.equals(visibleToolName)) {
                            fact.put("resolvedToolName", resolvedToolName);
                        }
                        if (json.length()
                                >= MIN_REFERENCE_PROJECTION_CHARACTERS
                                && contextProjector.canReplace(
                                rs.getString("outcome_kind"),
                                rs.getString("execution_id"),
                                rs.getString("payload_hash"),
                                resolvedToolName,
                                rs.getString("manifest_hash")
                        )) {
                            content = contextProjector.toReference(
                                    content,
                                    visibleToolName,
                                    resolvedToolName,
                                    rs.getString("execution_id"),
                                    rs.getString("payload_hash")
                            );
                            fact.put("contextProjection", "reference");
                        }
                        fact.set("content", content);
                    }
                    putNullable(
                            fact,
                            "outcome",
                            rs.getString("outcome_kind")
                    );
                    return (JsonNode) fact;
                })
                .list();
    }

    private void putNullable(ObjectNode node, String field, String value) {
        if (value == null) {
            node.putNull(field);
        } else {
            node.put(field, value);
        }
    }

    private JsonNode read(String json) {
        try {
            return objectMapper.readTree(json);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "Compaction source contains invalid canonical JSON",
                    exception
            );
        }
    }

    private String write(JsonNode value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "Cannot serialize compaction source snapshot",
                    exception
            );
        }
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

    public record SourceSnapshot(
            String snapshotId,
            String contentHash,
            String payloadJson,
            int factCount,
            int estimatedTokens
    ) {
    }

    public record CompactionRow(
            String runId,
            String conversationId,
            String branchId,
            String phase,
            String trigger,
            String parentFrameId,
            long sourceStartSequence,
            long waterlineSequence,
            String beforeTurnId,
            String sourceSnapshotId,
            String sourceContentHash,
            String sourcePayloadJson,
            int sourceFactCount,
            int estimatedTokens,
            String roundId,
            String boundaryId,
            String failureJson,
            long version,
            Instant requestedAt,
            Instant endedAt
    ) {
    }
}
