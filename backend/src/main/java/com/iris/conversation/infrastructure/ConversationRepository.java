package com.iris.conversation.infrastructure;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.conversation.domain.ConversationEvent;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.OptionalLong;

@Repository
public class ConversationRepository {
    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;

    public ConversationRepository(JdbcClient jdbc, ObjectMapper objectMapper) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
    }

    public void insertConversation(
            String conversationId,
            String rootBranchId,
            String title,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO iris_conversation(
                    conversation_id, root_branch_id, title, version, created_at, updated_at
                ) VALUES (:conversationId, :rootBranchId, :title, 1, :now, :now)
                """)
                .param("conversationId", conversationId)
                .param("rootBranchId", rootBranchId)
                .param("title", title, Types.VARCHAR)
                .param("now", now.toString())
                .update();
        jdbc.sql("""
                INSERT INTO conversation_branch(
                    branch_id, conversation_id, parent_branch_id, status, version, created_at
                ) VALUES (:branchId, :conversationId, NULL, 'active', 1, :now)
                """)
                .param("branchId", rootBranchId)
                .param("conversationId", conversationId)
                .param("now", now.toString())
                .update();
        String originFrameId = "frame_origin_" + conversationId;
        jdbc.sql("""
                INSERT INTO context_frame(
                    frame_id, conversation_id, owner_branch_id,
                    parent_frame_id, frame_kind, waterline_sequence,
                    before_turn_id, version, created_at
                ) VALUES (
                    :frameId, :conversationId, NULL,
                    NULL, 'origin', 0,
                    NULL, 1, :now
                )
                """)
                .param("frameId", originFrameId)
                .param("conversationId", conversationId)
                .param("now", now.toString())
                .update();
        jdbc.sql("""
                INSERT INTO branch_context_head(
                    branch_id, frame_id, version, updated_at
                ) VALUES (:branchId, :frameId, 1, :now)
                """)
                .param("branchId", rootBranchId)
                .param("frameId", originFrameId)
                .param("now", now.toString())
                .update();
    }

    private void inheritTaskStateAtFork(
            String branchId,
            String conversationId,
            String sourceBranchId,
            long sourceEventSequence,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO agent_task_work_state (
                  task_id, branch_id, state_version, phase,
                  steps_json, blockers_json, evidence_refs_json,
                  artifact_refs_json, summary, source_run_id,
                  source_round_id, created_at
                )
                SELECT state.task_id, :branchId, state.state_version,
                       state.phase, state.steps_json, state.blockers_json,
                       state.evidence_refs_json, state.artifact_refs_json,
                       state.summary, state.source_run_id,
                       state.source_round_id, state.created_at
                FROM agent_task_work_state state
                JOIN agent_run run ON run.run_id = state.source_run_id
                JOIN conversation_event event
                  ON event.turn_id = run.turn_id
                 AND event.event_type = 'turn.accepted'
                WHERE state.branch_id = :sourceBranchId
                  AND event.sequence < :sourceEventSequence
                  AND state.state_version = (
                    SELECT MAX(candidate.state_version)
                    FROM agent_task_work_state candidate
                    JOIN agent_run candidate_run
                      ON candidate_run.run_id = candidate.source_run_id
                    JOIN conversation_event candidate_event
                      ON candidate_event.turn_id = candidate_run.turn_id
                     AND candidate_event.event_type = 'turn.accepted'
                    WHERE candidate.task_id = state.task_id
                      AND candidate.branch_id = :sourceBranchId
                      AND candidate_event.sequence < :sourceEventSequence
                  )
                """)
                .param("branchId", branchId)
                .param("sourceBranchId", sourceBranchId)
                .param("sourceEventSequence", sourceEventSequence)
                .update();
        jdbc.sql("""
                INSERT INTO agent_task_state_control (
                  task_id, branch_id, state_version, current_focus,
                  pending_decisions_json, next_actions_json,
                  handoff_note, created_at
                )
                SELECT control.task_id, :branchId, control.state_version,
                       control.current_focus,
                       control.pending_decisions_json,
                       control.next_actions_json,
                       control.handoff_note, control.created_at
                FROM agent_task_state_control control
                JOIN agent_task_work_state copied
                  ON copied.task_id = control.task_id
                 AND copied.state_version = control.state_version
                 AND copied.branch_id = :branchId
                WHERE control.branch_id = :sourceBranchId
                """)
                .param("branchId", branchId)
                .param("sourceBranchId", sourceBranchId)
                .update();
        jdbc.sql("""
                INSERT INTO agent_task_head (
                  task_id, conversation_id, branch_id,
                  definition_version, state_version, phase, version,
                  created_at, updated_at
                )
                SELECT copied.task_id, :conversationId, :branchId,
                       source_head.definition_version,
                       copied.state_version, copied.phase, 1, :now, :now
                FROM agent_task_work_state copied
                JOIN agent_task_head source_head
                  ON source_head.task_id = copied.task_id
                 AND source_head.branch_id = :sourceBranchId
                WHERE copied.branch_id = :branchId
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("sourceBranchId", sourceBranchId)
                .param("now", now.toString())
                .update();
        jdbc.sql("""
                INSERT INTO agent_task_checkpoint (
                  checkpoint_id, task_id, branch_id, state_version,
                  checkpoint_kind, resume_summary,
                  source_run_id, source_round_id, created_at
                )
                SELECT 'taskcp_' || lower(hex(randomblob(16))),
                       copied.task_id, :branchId, copied.state_version,
                       'fork', copied.summary,
                       copied.source_run_id, copied.source_round_id, :now
                FROM agent_task_work_state copied
                WHERE copied.branch_id = :branchId
                """)
                .param("branchId", branchId)
                .param("now", now.toString())
                .update();
    }

    public boolean conversationExists(String conversationId) {
        return jdbc.sql("""
                SELECT COUNT(*) FROM iris_conversation
                WHERE conversation_id = :conversationId
                """)
                .param("conversationId", conversationId)
                .query(Integer.class)
                .single() > 0;
    }

    public boolean branchBelongsToConversation(String branchId, String conversationId) {
        return jdbc.sql("""
                SELECT COUNT(*) FROM conversation_branch
                WHERE branch_id = :branchId AND conversation_id = :conversationId
                """)
                .param("branchId", branchId)
                .param("conversationId", conversationId)
                .query(Integer.class)
                .single() > 0;
    }

    public Optional<BranchAnchor> findBranchAnchor(
            String conversationId,
            String sourceBranchId,
            String anchorMessageId
    ) {
        return jdbc.sql("""
                SELECT t.turn_id, t.phase, e.sequence
                FROM conversation_turn t
                JOIN conversation_event e
                  ON e.turn_id = t.turn_id
                 AND e.event_type = 'turn.accepted'
                WHERE t.conversation_id = :conversationId
                  AND t.branch_id = :sourceBranchId
                  AND t.request_message_id = :anchorMessageId
                """)
                .param("conversationId", conversationId)
                .param("sourceBranchId", sourceBranchId)
                .param("anchorMessageId", anchorMessageId)
                .query((rs, rowNum) -> new BranchAnchor(
                        rs.getString("turn_id"),
                        rs.getString("phase"),
                        rs.getLong("sequence")
                ))
                .optional();
    }

    public boolean hasActiveTurn(
            String conversationId,
            String branchId
    ) {
        return jdbc.sql("""
                SELECT COUNT(*)
                FROM conversation_turn
                WHERE conversation_id = :conversationId
                  AND branch_id = :branchId
                  AND phase IN ('queued', 'active')
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .query(Integer.class)
                .single() > 0;
    }

    public void insertBranch(
            String branchId,
            String conversationId,
            String sourceBranchId,
            String anchorMessageId,
            String sourceTurnId,
            long sourceEventSequence,
            String baseContextFrameId,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO conversation_branch(
                    branch_id, conversation_id, parent_branch_id,
                    status, version, created_at
                ) VALUES (
                    :branchId, :conversationId, :sourceBranchId,
                    'active', 1, :now
                )
                """)
                .param("branchId", branchId)
                .param("conversationId", conversationId)
                .param("sourceBranchId", sourceBranchId)
                .param("now", now.toString())
                .update();
        jdbc.sql("""
                INSERT INTO branch_fork(
                    branch_id, source_branch_id, anchor_message_id,
                    source_turn_id, source_event_sequence,
                    base_context_frame_id, mode, created_at
                ) VALUES (
                    :branchId, :sourceBranchId, :anchorMessageId,
                    :sourceTurnId, :sourceEventSequence,
                    :baseContextFrameId, 'replace_user_message', :now
                )
                """)
                .param("branchId", branchId)
                .param("sourceBranchId", sourceBranchId)
                .param("anchorMessageId", anchorMessageId)
                .param("sourceTurnId", sourceTurnId)
                .param("sourceEventSequence", sourceEventSequence)
                .param("baseContextFrameId", baseContextFrameId)
                .param("now", now.toString())
                .update();
        jdbc.sql("""
                INSERT INTO branch_context_head(
                    branch_id, frame_id, version, updated_at
                ) VALUES (:branchId, :frameId, 1, :now)
                """)
                .param("branchId", branchId)
                .param("frameId", baseContextFrameId)
                .param("now", now.toString())
                .update();
        inheritTaskStateAtFork(
                branchId,
                conversationId,
                sourceBranchId,
                sourceEventSequence,
                now
        );
    }

    public ContextFrame eligibleContextFrame(
            String conversationId,
            String branchId,
            long beforeSequence
    ) {
        return jdbc.sql("""
                WITH RECURSIVE frame_chain(
                    frame_id, parent_frame_id, waterline_sequence
                ) AS (
                    SELECT frame.frame_id, frame.parent_frame_id,
                           frame.waterline_sequence
                    FROM branch_context_head head
                    JOIN context_frame frame
                      ON frame.frame_id = head.frame_id
                    WHERE head.branch_id = :branchId
                      AND frame.conversation_id = :conversationId

                    UNION ALL

                    SELECT parent.frame_id, parent.parent_frame_id,
                           parent.waterline_sequence
                    FROM frame_chain child
                    JOIN context_frame parent
                      ON parent.frame_id = child.parent_frame_id
                )
                SELECT frame_id, waterline_sequence
                FROM frame_chain
                WHERE waterline_sequence < :beforeSequence
                ORDER BY waterline_sequence DESC
                LIMIT 1
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("beforeSequence", beforeSequence)
                .query((rs, rowNum) -> new ContextFrame(
                        rs.getString("frame_id"),
                        rs.getLong("waterline_sequence")
                ))
                .optional()
                .orElseThrow(() -> new IllegalStateException(
                        "Branch context chain has no eligible origin frame"
                ));
    }

    public void insertMessage(
            String messageId,
            String conversationId,
            String branchId,
            String turnId,
            String content,
            String clientRequestId,
            List<String> attachmentRefs,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO message(
                    message_id, conversation_id, branch_id, turn_id, role,
                    content, client_request_id, created_at
                ) VALUES (
                    :messageId, :conversationId, :branchId, :turnId, 'user',
                    :content, :clientRequestId, :now
                )
                """)
                .param("messageId", messageId)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("turnId", turnId)
                .param("content", content)
                .param("clientRequestId", clientRequestId)
                .param("now", now.toString())
                .update();
        for (int index = 0; index < attachmentRefs.size(); index++) {
            jdbc.sql("""
                    INSERT INTO message_attachment(message_id, ordinal, artifact_ref)
                    VALUES (:messageId, :ordinal, :artifactRef)
                    """)
                    .param("messageId", messageId)
                    .param("ordinal", index)
                    .param("artifactRef", attachmentRefs.get(index))
                    .update();
        }
    }

    public void insertTurn(
            String turnId,
            String conversationId,
            String branchId,
            String requestMessageId,
            String rootRunId,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO conversation_turn(
                    turn_id, conversation_id, branch_id, request_message_id,
                    root_run_id, phase, version, started_at, ended_at
                ) VALUES (
                    :turnId, :conversationId, :branchId, :requestMessageId,
                    :rootRunId, 'active', 1, :now, NULL
                )
                """)
                .param("turnId", turnId)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("requestMessageId", requestMessageId)
                .param("rootRunId", rootRunId)
                .param("now", now.toString())
                .update();
    }

    public void insertRootRun(
            String runId,
            String conversationId,
            String branchId,
            String turnId,
            String purpose,
            String snapshotHash,
            String normalizedInputHash,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO agent_run(
                    run_id, conversation_id, branch_id, turn_id, parent_run_id,
                    root_run_id, kind, purpose, phase, version, started_at, ended_at
                ) VALUES (
                    :runId, :conversationId, :branchId, :turnId, NULL,
                    :runId, 'agentic', :purpose, 'running', 1, :now, NULL
                )
                """)
                .param("runId", runId)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("turnId", turnId)
                .param("purpose", purpose)
                .param("now", now.toString())
                .update();
        jdbc.sql("""
                INSERT INTO run_definition_snapshot(
                    run_id, definition_id, definition_version, snapshot_hash,
                    normalized_input_hash, dependency_snapshot_ref,
                    tool_calls_limit, time_limit_ms
                ) VALUES (
                    :runId, 'iris.agentic.default', '1', :snapshotHash,
                    :normalizedInputHash, :contextFrameRef, 30, 600000
                )
                """)
                .param("runId", runId)
                .param("snapshotHash", snapshotHash)
                .param("normalizedInputHash", normalizedInputHash)
                .param("contextFrameRef", contextFrameRef(branchId))
                .update();
    }

    private String contextFrameRef(String branchId) {
        String frameId = jdbc.sql("""
                SELECT frame_id
                FROM branch_context_head
                WHERE branch_id = :branchId
                """)
                .param("branchId", branchId)
                .query(String.class)
                .single();
        return "context-frame:" + frameId;
    }

    public long incrementConversationVersion(String conversationId, Instant now) {
        jdbc.sql("""
                UPDATE iris_conversation
                SET version = version + 1, updated_at = :now
                WHERE conversation_id = :conversationId
                """)
                .param("now", now.toString())
                .param("conversationId", conversationId)
                .update();
        return jdbc.sql("""
                SELECT version FROM iris_conversation
                WHERE conversation_id = :conversationId
                """)
                .param("conversationId", conversationId)
                .query(Long.class)
                .single();
    }

    public Optional<ConversationMetadata> findConversationMetadata(
            String conversationId
    ) {
        return jdbc.sql("""
                SELECT title, version FROM iris_conversation
                WHERE conversation_id = :conversationId
                """)
                .param("conversationId", conversationId)
                .query((rs, rowNum) -> new ConversationMetadata(
                        rs.getString("title"),
                        rs.getLong("version")
                ))
                .optional();
    }

    public long updateConversationTitle(
            String conversationId,
            long expectedVersion,
            String title,
            Instant now
    ) {
        int updated = jdbc.sql("""
                UPDATE iris_conversation
                SET title = :title, version = version + 1, updated_at = :now
                WHERE conversation_id = :conversationId
                  AND version = :expectedVersion
                """)
                .param("title", title)
                .param("now", now.toString())
                .param("conversationId", conversationId)
                .param("expectedVersion", expectedVersion)
                .update();
        if (updated == 0) {
            return -1;
        }
        return expectedVersion + 1;
    }

    public long updateConversationArchived(
            String conversationId,
            long expectedVersion,
            boolean archived,
            Instant now
    ) {
        int updated = jdbc.sql("""
                UPDATE iris_conversation
                SET archived_at = :archivedAt,
                    version = version + 1,
                    updated_at = :now
                WHERE conversation_id = :conversationId
                  AND version = :expectedVersion
                """)
                .param("archivedAt", archived ? now.toString() : null)
                .param("now", now.toString())
                .param("conversationId", conversationId)
                .param("expectedVersion", expectedVersion)
                .update();
        if (updated == 0) {
            return -1;
        }
        return expectedVersion + 1;
    }

    public long nextEventSequence(String conversationId) {
        return jdbc.sql("""
                SELECT COALESCE(MAX(sequence), 0) + 1
                FROM conversation_event
                WHERE conversation_id = :conversationId
                """)
                .param("conversationId", conversationId)
                .query(Long.class)
                .single();
    }

    public void insertEvent(ConversationEvent event) {
        jdbc.sql("""
                INSERT INTO conversation_event(
                    conversation_id, sequence, event_id, event_type, branch_id,
                    turn_id, run_id, parent_run_id, aggregate_kind, aggregate_id,
                    aggregate_version, causation_id, correlation_id, occurred_at, payload_json
                ) VALUES (
                    :conversationId, :sequence, :eventId, :eventType, :branchId,
                    :turnId, :runId, :parentRunId, :aggregateKind, :aggregateId,
                    :aggregateVersion, :causationId, :correlationId, :occurredAt, :payloadJson
                )
                """)
                .param("conversationId", event.conversationId())
                .param("sequence", event.sequence())
                .param("eventId", event.eventId())
                .param("eventType", event.eventType())
                .param("branchId", event.branchId(), Types.VARCHAR)
                .param("turnId", event.turnId(), Types.VARCHAR)
                .param("runId", event.runId(), Types.VARCHAR)
                .param("parentRunId", event.parentRunId(), Types.VARCHAR)
                .param("aggregateKind", event.aggregate().kind())
                .param("aggregateId", event.aggregate().id())
                .param("aggregateVersion", event.aggregate().version())
                .param("causationId", event.causationId(), Types.VARCHAR)
                .param("correlationId", event.correlationId(), Types.VARCHAR)
                .param("occurredAt", event.occurredAt().toString())
                .param("payloadJson", writeJson(event.payload()))
                .update();
    }

    public long latestEventSequence(String conversationId) {
        return jdbc.sql("""
                SELECT COALESCE(MAX(sequence), 0)
                FROM conversation_event
                WHERE conversation_id = :conversationId
                """)
                .param("conversationId", conversationId)
                .query(Long.class)
                .single();
    }

    public OptionalLong resolveEventCursor(String conversationId, String eventId) {
        Optional<Long> sequence = jdbc.sql("""
                SELECT sequence FROM conversation_event
                WHERE conversation_id = :conversationId AND event_id = :eventId
                """)
                .param("conversationId", conversationId)
                .param("eventId", eventId)
                .query(Long.class)
                .optional();
        return sequence.isPresent()
                ? OptionalLong.of(sequence.get())
                : OptionalLong.empty();
    }

    public List<ConversationEvent> findEvents(
            String conversationId,
            long afterSequence,
            long throughSequence
    ) {
        return jdbc.sql("""
                SELECT * FROM conversation_event
                WHERE conversation_id = :conversationId
                  AND sequence > :afterSequence
                  AND sequence <= :throughSequence
                ORDER BY sequence ASC
                """)
                .param("conversationId", conversationId)
                .param("afterSequence", afterSequence)
                .param("throughSequence", throughSequence)
                .query(this::mapEvent)
                .list();
    }

    public Optional<IdempotencyRecord> findIdempotency(
            String subjectId,
            String endpoint,
            String idempotencyKey
    ) {
        return jdbc.sql("""
                SELECT request_hash, http_status, response_json
                FROM idempotency_record
                WHERE subject_id = :subjectId
                  AND endpoint = :endpoint
                  AND idempotency_key = :idempotencyKey
                """)
                .param("subjectId", subjectId)
                .param("endpoint", endpoint)
                .param("idempotencyKey", idempotencyKey)
                .query((rs, rowNum) -> new IdempotencyRecord(
                        rs.getString("request_hash"),
                        rs.getInt("http_status"),
                        rs.getString("response_json")
                ))
                .optional();
    }

    public void insertIdempotency(
            String subjectId,
            String endpoint,
            String idempotencyKey,
            String requestHash,
            int httpStatus,
            String responseJson,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO idempotency_record(
                    subject_id, endpoint, idempotency_key, request_hash,
                    http_status, response_json, created_at
                ) VALUES (
                    :subjectId, :endpoint, :idempotencyKey, :requestHash,
                    :httpStatus, :responseJson, :now
                )
                """)
                .param("subjectId", subjectId)
                .param("endpoint", endpoint)
                .param("idempotencyKey", idempotencyKey)
                .param("requestHash", requestHash)
                .param("httpStatus", httpStatus)
                .param("responseJson", responseJson)
                .param("now", now.toString())
                .update();
    }

    private ConversationEvent mapEvent(ResultSet rs, int rowNum) throws SQLException {
        try {
            JsonNode payload = objectMapper.readTree(rs.getString("payload_json"));
            return new ConversationEvent(
                    1,
                    rs.getString("event_id"),
                    rs.getString("event_type"),
                    rs.getString("conversation_id"),
                    rs.getString("branch_id"),
                    rs.getString("turn_id"),
                    rs.getString("run_id"),
                    rs.getString("parent_run_id"),
                    rs.getLong("sequence"),
                    new ConversationEvent.AggregateRef(
                            rs.getString("aggregate_kind"),
                            rs.getString("aggregate_id"),
                            rs.getLong("aggregate_version")
                    ),
                    rs.getString("causation_id"),
                    rs.getString("correlation_id"),
                    Instant.parse(rs.getString("occurred_at")),
                    payload
            );
        } catch (JsonProcessingException exception) {
            throw new SQLException("Stored event payload is not valid JSON", exception);
        }
    }

    private String writeJson(JsonNode value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("Unable to serialize persisted event", exception);
        }
    }

    public record IdempotencyRecord(
            String requestHash,
            int httpStatus,
            String responseJson
    ) {
    }

    public record ConversationMetadata(String title, long version) {
    }

    public record BranchAnchor(
            String sourceTurnId,
            String sourceTurnPhase,
            long sourceEventSequence
    ) {
    }

    public record ContextFrame(
            String frameId,
            long waterlineSequence
    ) {
    }
}
