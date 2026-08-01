package com.iris.conversation.infrastructure;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.conversation.domain.ApiProblemException;
import com.iris.conversation.domain.ConversationViews.BranchSummary;
import com.iris.conversation.domain.ConversationViews.ConversationPage;
import com.iris.conversation.domain.ConversationViews.ConversationSummary;
import com.iris.conversation.domain.ConversationViews.ConversationView;
import com.iris.conversation.domain.ConversationViews.FailureView;
import com.iris.conversation.domain.ConversationViews.ForkAnchor;
import com.iris.conversation.domain.ConversationViews.RequestView;
import com.iris.conversation.domain.ConversationViews.RoundStats;
import com.iris.conversation.domain.ConversationViews.RoundView;
import com.iris.conversation.domain.ConversationViews.RunBudget;
import com.iris.conversation.domain.ConversationViews.RunClosureCounts;
import com.iris.conversation.domain.ConversationViews.RunClosureView;
import com.iris.conversation.domain.ConversationViews.RunDefinition;
import com.iris.conversation.domain.ConversationViews.RunView;
import com.iris.conversation.domain.ConversationViews.TurnStats;
import com.iris.conversation.domain.ConversationViews.TurnView;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

@Repository
public class ConversationQueryRepository {
    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;
    private final SupplementRepository supplements;
    private final TurnStopRepository stops;

    public ConversationQueryRepository(
            JdbcClient jdbc,
            ObjectMapper objectMapper,
            SupplementRepository supplements,
            TurnStopRepository stops
    ) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.supplements = supplements;
        this.stops = stops;
    }

    public ConversationSummary summary(String conversationId) {
        return jdbc.sql("""
                SELECT
                    c.conversation_id,
                    c.title,
                    c.updated_at,
                    c.version,
                    (
                        SELECT COUNT(*) FROM conversation_turn t
                        WHERE t.conversation_id = c.conversation_id
                          AND t.phase IN ('queued', 'active')
                    ) AS active_turn_count,
                    (
                        SELECT COUNT(*) FROM attention_projection a
                        WHERE a.conversation_id = c.conversation_id
                          AND a.status = 'waiting'
                    ) AS pending_attention_count,
                    (
                        SELECT m.content FROM message m
                        WHERE m.conversation_id = c.conversation_id
                        ORDER BY m.created_at DESC, m.message_id DESC
                        LIMIT 1
                    ) AS last_visible_text
                FROM iris_conversation c
                WHERE c.conversation_id = :conversationId
                """)
                .param("conversationId", conversationId)
                .query((rs, rowNum) -> new ConversationSummary(
                        rs.getString("conversation_id"),
                        rs.getString("title"),
                        Instant.parse(rs.getString("updated_at")),
                        rs.getInt("active_turn_count"),
                        rs.getInt("pending_attention_count"),
                        rs.getString("last_visible_text"),
                        rs.getLong("version")
                ))
                .optional()
                .orElseThrow(() -> new ApiProblemException(
                        HttpStatus.NOT_FOUND,
                        "conversation_not_found",
                        "not_found",
                        "找不到这个对话。"
                ));
    }

    public ConversationPage list(String cursor, int limit) {
        CursorPosition position = cursor == null
                ? null
                : resolveConversationCursor(cursor);
        String cursorClause = position == null
                ? ""
                : """
                  AND (
                    c.updated_at < :cursorUpdatedAt
                    OR (c.updated_at = :cursorUpdatedAt AND c.conversation_id < :cursorId)
                  )
                  """;
        JdbcClient.StatementSpec statement = jdbc.sql("""
                SELECT
                    c.conversation_id,
                    c.title,
                    c.updated_at,
                    c.version,
                    (
                        SELECT COUNT(*) FROM conversation_turn t
                        WHERE t.conversation_id = c.conversation_id
                          AND t.phase IN ('queued', 'active')
                    ) AS active_turn_count,
                    (
                        SELECT COUNT(*) FROM attention_projection a
                        WHERE a.conversation_id = c.conversation_id
                          AND a.status = 'waiting'
                    ) AS pending_attention_count,
                    (
                        SELECT m.content FROM message m
                        WHERE m.conversation_id = c.conversation_id
                        ORDER BY m.created_at DESC, m.message_id DESC
                        LIMIT 1
                    ) AS last_visible_text
                FROM iris_conversation c
                WHERE 1 = 1
                """ + cursorClause + """
                ORDER BY c.updated_at DESC, c.conversation_id DESC
                LIMIT :limit
                """);
        if (position != null) {
            statement = statement
                    .param("cursorUpdatedAt", position.updatedAt())
                    .param("cursorId", position.conversationId());
        }
        List<ConversationSummary> rows = statement
                .param("limit", limit + 1)
                .query((rs, rowNum) -> new ConversationSummary(
                        rs.getString("conversation_id"),
                        rs.getString("title"),
                        Instant.parse(rs.getString("updated_at")),
                        rs.getInt("active_turn_count"),
                        rs.getInt("pending_attention_count"),
                        rs.getString("last_visible_text"),
                        rs.getLong("version")
                ))
                .list();
        boolean hasMore = rows.size() > limit;
        List<ConversationSummary> items = hasMore
                ? List.copyOf(rows.subList(0, limit))
                : List.copyOf(rows);
        String nextCursor = hasMore && !items.isEmpty()
                ? items.get(items.size() - 1).conversationId()
                : null;
        return new ConversationPage(items, nextCursor);
    }

    public ConversationView view(
            String conversationId,
            String requestedBranchId,
            String beforeTurnId,
            int limit
    ) {
        ConversationHeader header = conversationHeader(conversationId);
        String branchId = requestedBranchId == null || requestedBranchId.isBlank()
                ? header.rootBranchId()
                : requestedBranchId;
        requireBranch(conversationId, branchId);
        Long beforeSequence = beforeTurnId == null
                ? null
                : resolveTurnSequence(conversationId, branchId, beforeTurnId);

        List<TurnRow> rows = turnRows(conversationId, branchId, beforeSequence, limit);
        Collections.reverse(rows);

        Map<String, TurnView> turns = new LinkedHashMap<>();
        Map<String, RunView> runs = new LinkedHashMap<>();
        Map<String, RoundView> rounds = new LinkedHashMap<>();
        Map<String, JsonNode> renderNodes = new LinkedHashMap<>();
        List<String> turnOrder = new ArrayList<>();

        for (TurnRow row : rows) {
            turnOrder.add(row.turnId());
            List<RunView> turnRuns = runs(row.turnId());
            turnRuns.forEach(run -> {
                runs.put(run.runId(), run);
                rounds(run.runId()).forEach(round ->
                        rounds.put(round.roundId(), round)
                );
            });
            List<JsonNode> turnNodes = renderNodes(row.turnId());
            turnNodes.forEach(node ->
                    renderNodes.put(node.path("nodeId").asText(), node)
            );
            turns.put(row.turnId(), buildTurnView(row));
        }

        List<JsonNode> compactBoundaries =
                compactBoundaries(conversationId, branchId);
        Map<String, JsonNode> attentions =
                attentions(conversationId, branchId);
        List<String> pendingAttentionIds = attentions.entrySet()
                .stream()
                .filter(entry -> "waiting".equals(
                        entry.getValue().path("status").asText()
                ))
                .map(Map.Entry::getKey)
                .toList();
        long oldestSequence = rows.isEmpty()
                ? Long.MAX_VALUE
                : rows.get(0).eventSequence();

        return new ConversationView(
                conversationId,
                header.title(),
                branchId,
                turnOrder,
                turns,
                runs,
                rounds,
                renderNodes,
                branches(conversationId),
                compactBoundaries,
                compactions(conversationId, branchId),
                attentions,
                pendingAttentionIds,
                header.version(),
                1,
                latestEventId(conversationId),
                hasEarlierTurns(conversationId, branchId, oldestSequence)
        );
    }

    private CursorPosition resolveConversationCursor(String conversationId) {
        return jdbc.sql("""
                SELECT conversation_id, updated_at
                FROM iris_conversation
                WHERE conversation_id = :conversationId
                """)
                .param("conversationId", conversationId)
                .query((rs, rowNum) -> new CursorPosition(
                        rs.getString("conversation_id"),
                        rs.getString("updated_at")
                ))
                .optional()
                .orElseThrow(() -> new ApiProblemException(
                        HttpStatus.GONE,
                        "page_cursor_unavailable",
                        "precondition",
                        "这个会话分页游标已经不可用。"
                ));
    }

    private ConversationHeader conversationHeader(String conversationId) {
        return jdbc.sql("""
                SELECT conversation_id, root_branch_id, title, version
                FROM iris_conversation
                WHERE conversation_id = :conversationId
                """)
                .param("conversationId", conversationId)
                .query((rs, rowNum) -> new ConversationHeader(
                        rs.getString("conversation_id"),
                        rs.getString("root_branch_id"),
                        rs.getString("title"),
                        rs.getLong("version")
                ))
                .optional()
                .orElseThrow(() -> new ApiProblemException(
                        HttpStatus.NOT_FOUND,
                        "conversation_not_found",
                        "not_found",
                        "找不到这个对话。"
                ));
    }

    private void requireBranch(String conversationId, String branchId) {
        int count = jdbc.sql("""
                SELECT COUNT(*) FROM conversation_branch
                WHERE conversation_id = :conversationId AND branch_id = :branchId
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .query(Integer.class)
                .single();
        if (count == 0) {
            throw new ApiProblemException(
                    HttpStatus.NOT_FOUND,
                    "branch_not_found",
                    "not_found",
                    "找不到这个分支。"
            );
        }
    }

    private long resolveTurnSequence(
            String conversationId,
            String branchId,
            String turnId
    ) {
        return jdbc.sql("""
                WITH RECURSIVE branch_path(
                    branch_id, cutoff_sequence
                ) AS (
                    SELECT :branchId, NULL
                    UNION ALL
                    SELECT cb.parent_branch_id, bf.source_event_sequence
                    FROM branch_path path
                    JOIN conversation_branch cb
                      ON cb.branch_id = path.branch_id
                    JOIN branch_fork bf
                      ON bf.branch_id = path.branch_id
                    WHERE cb.parent_branch_id IS NOT NULL
                )
                SELECT e.sequence
                FROM conversation_event e
                JOIN branch_path path ON path.branch_id = e.branch_id
                WHERE e.conversation_id = :conversationId
                  AND e.event_type = 'turn.accepted'
                  AND e.turn_id = :turnId
                  AND (
                    path.cutoff_sequence IS NULL
                    OR e.sequence < path.cutoff_sequence
                  )
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("turnId", turnId)
                .query(Long.class)
                .optional()
                .orElseThrow(() -> new ApiProblemException(
                        HttpStatus.NOT_FOUND,
                        "turn_not_found",
                        "not_found",
                        "分页锚点不属于当前分支。"
                ));
    }

    private List<TurnRow> turnRows(
            String conversationId,
            String branchId,
            Long beforeSequence,
            int limit
    ) {
        String beforeClause = beforeSequence == null
                ? ""
                : " AND e.sequence < :beforeSequence ";
        JdbcClient.StatementSpec statement = jdbc.sql("""
                WITH RECURSIVE branch_path(
                    branch_id, cutoff_sequence
                ) AS (
                    SELECT :branchId, NULL
                    UNION ALL
                    SELECT cb.parent_branch_id, bf.source_event_sequence
                    FROM branch_path path
                    JOIN conversation_branch cb
                      ON cb.branch_id = path.branch_id
                    JOIN branch_fork bf
                      ON bf.branch_id = path.branch_id
                    WHERE cb.parent_branch_id IS NOT NULL
                )
                SELECT
                    t.turn_id, t.branch_id, t.request_message_id, t.root_run_id,
                    t.phase, t.version, t.started_at, t.ended_at,
                    m.content, e.sequence
                FROM conversation_turn t
                JOIN message m ON m.message_id = t.request_message_id
                JOIN conversation_event e
                  ON e.conversation_id = t.conversation_id
                 AND e.turn_id = t.turn_id
                 AND e.event_type = 'turn.accepted'
                JOIN branch_path path ON path.branch_id = t.branch_id
                WHERE t.conversation_id = :conversationId
                  AND (
                    path.cutoff_sequence IS NULL
                    OR e.sequence < path.cutoff_sequence
                  )
                """ + beforeClause + """
                ORDER BY e.sequence DESC
                LIMIT :limit
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("limit", limit);
        if (beforeSequence != null) {
            statement = statement.param("beforeSequence", beforeSequence);
        }
        return statement.query((rs, rowNum) -> new TurnRow(
                rs.getString("turn_id"),
                rs.getString("branch_id"),
                rs.getString("request_message_id"),
                rs.getString("root_run_id"),
                rs.getString("phase"),
                rs.getLong("version"),
                Instant.parse(rs.getString("started_at")),
                rs.getString("ended_at") == null
                        ? null
                        : Instant.parse(rs.getString("ended_at")),
                rs.getString("content"),
                rs.getLong("sequence")
        )).list();
    }

    private List<String> attachments(String messageId) {
        return jdbc.sql("""
                SELECT artifact_ref FROM message_attachment
                WHERE message_id = :messageId
                ORDER BY ordinal
                """)
                .param("messageId", messageId)
                .query(String.class)
                .list();
    }

    public TurnView turnView(String turnId) {
        TurnRow row = jdbc.sql("""
                SELECT
                    t.turn_id, t.branch_id, t.request_message_id, t.root_run_id,
                    t.phase, t.version, t.started_at, t.ended_at,
                    m.content, CAST(0 AS BIGINT) AS sequence
                FROM conversation_turn t
                JOIN message m ON m.message_id = t.request_message_id
                WHERE t.turn_id = :turnId
                """)
                .param("turnId", turnId)
                .query((rs, rowNum) -> new TurnRow(
                        rs.getString("turn_id"),
                        rs.getString("branch_id"),
                        rs.getString("request_message_id"),
                        rs.getString("root_run_id"),
                        rs.getString("phase"),
                        rs.getLong("version"),
                        Instant.parse(rs.getString("started_at")),
                        rs.getString("ended_at") == null
                                ? null
                                : Instant.parse(rs.getString("ended_at")),
                        rs.getString("content"),
                        rs.getLong("sequence")
                ))
                .optional()
                .orElseThrow(() -> new IllegalStateException("找不到 Turn"));
        return buildTurnView(row);
    }

    private TurnView buildTurnView(TurnRow row) {
        List<String> attachmentRefs = attachments(row.messageId());
        List<RunView> turnRuns = runs(row.turnId());
        Map<String, RoundView> roundsById = new LinkedHashMap<>();
        turnRuns.forEach(run -> rounds(run.runId()).forEach(round ->
                roundsById.put(round.roundId(), round)
        ));
        List<JsonNode> turnNodes = renderNodes(row.turnId());
        List<String> attentionIds = pendingAttentionIds(row.turnId());
        FailureView failure = turnRuns.stream()
                .filter(run -> run.runId().equals(row.rootRunId()))
                .findFirst()
                .map(RunView::failure)
                .orElse(null);
        return new TurnView(
                row.turnId(),
                row.branchId(),
                row.messageId(),
                new RequestView(row.content(), attachmentRefs),
                row.phase(),
                turnRuns.stream().map(RunView::runId).toList(),
                row.rootRunId(),
                turnNodes.stream()
                        .map(node -> node.path("nodeId").asText())
                        .toList(),
                attentionIds,
                stops.findByTurn(row.turnId()).orElse(null),
                failure,
                supplements.viewsForTurn(row.turnId()).stream()
                        .map(view -> (Object) view)
                        .toList(),
                new TurnStats(
                        roundsForTurn(turnRuns, roundsById),
                        toolCallsForTurn(turnNodes),
                        Math.max(0, turnRuns.size() - 1),
                        row.startedAt(),
                        row.endedAt()
                ),
                row.version()
        );
    }

    public RunView runView(String runId) {
        return jdbc.sql("""
                SELECT r.*, d.*,
                       c.run_id AS closure_run_id,
                       c.execution_status AS closure_execution_status,
                       c.task_outcome AS closure_task_outcome,
                       c.terminal_reason AS closure_terminal_reason,
                       c.final_stop_reason AS closure_final_stop_reason,
                       c.round_count AS closure_round_count,
                       c.model_attempt_count AS closure_model_attempt_count,
                       c.tool_call_count AS closure_tool_call_count,
                       c.tool_execution_count AS closure_tool_execution_count,
                       c.tool_observation_count AS closure_tool_observation_count,
                       c.tool_succeeded_count AS closure_tool_succeeded_count,
                       c.tool_failed_count AS closure_tool_failed_count,
                       c.tool_outcome_unknown_count
                           AS closure_tool_outcome_unknown_count,
                       c.tool_rejected_count AS closure_tool_rejected_count,
                       c.tool_expired_count AS closure_tool_expired_count,
                       (
                           c.unmatched_tool_call_count
                           + c.orphan_tool_execution_count
                           + c.non_terminal_execution_count
                           + c.missing_observation_count
                       ) AS closure_unresolved_protocol_facts,
                       c.evidence_count AS closure_evidence_count,
                       c.artifact_count AS closure_artifact_count,
                       c.has_final_answer AS closure_has_final_answer,
                       c.recorded_at AS closure_recorded_at,
                       f.code AS failure_code,
                       f.category AS failure_category,
                       f.user_message AS failure_user_message,
                       f.trace_id AS failure_trace_id,
                       f.source AS failure_source,
                       f.recovery_action AS failure_recovery_action,
                       f.side_effect_outcome AS failure_side_effect_outcome,
                       f.details_ref AS failure_details_ref
                FROM agent_run r
                JOIN run_definition_snapshot d ON d.run_id = r.run_id
                LEFT JOIN run_closure_ledger c ON c.run_id = r.run_id
                LEFT JOIN run_failure f ON f.run_id = r.run_id
                WHERE r.run_id = :runId
                """)
                .param("runId", runId)
                .query((rs, rowNum) -> mapRunView(rs))
                .optional()
                .orElseThrow(() -> new IllegalStateException("找不到 Run"));
    }

    private List<RunView> runs(String turnId) {
        return jdbc.sql("""
                SELECT r.*, d.*,
                       c.run_id AS closure_run_id,
                       c.execution_status AS closure_execution_status,
                       c.task_outcome AS closure_task_outcome,
                       c.terminal_reason AS closure_terminal_reason,
                       c.final_stop_reason AS closure_final_stop_reason,
                       c.round_count AS closure_round_count,
                       c.model_attempt_count AS closure_model_attempt_count,
                       c.tool_call_count AS closure_tool_call_count,
                       c.tool_execution_count AS closure_tool_execution_count,
                       c.tool_observation_count AS closure_tool_observation_count,
                       c.tool_succeeded_count AS closure_tool_succeeded_count,
                       c.tool_failed_count AS closure_tool_failed_count,
                       c.tool_outcome_unknown_count
                           AS closure_tool_outcome_unknown_count,
                       c.tool_rejected_count AS closure_tool_rejected_count,
                       c.tool_expired_count AS closure_tool_expired_count,
                       (
                           c.unmatched_tool_call_count
                           + c.orphan_tool_execution_count
                           + c.non_terminal_execution_count
                           + c.missing_observation_count
                       ) AS closure_unresolved_protocol_facts,
                       c.evidence_count AS closure_evidence_count,
                       c.artifact_count AS closure_artifact_count,
                       c.has_final_answer AS closure_has_final_answer,
                       c.recorded_at AS closure_recorded_at,
                       f.code AS failure_code,
                       f.category AS failure_category,
                       f.user_message AS failure_user_message,
                       f.trace_id AS failure_trace_id,
                       f.source AS failure_source,
                       f.recovery_action AS failure_recovery_action,
                       f.side_effect_outcome AS failure_side_effect_outcome,
                       f.details_ref AS failure_details_ref
                FROM agent_run r
                JOIN run_definition_snapshot d ON d.run_id = r.run_id
                LEFT JOIN run_closure_ledger c ON c.run_id = r.run_id
                LEFT JOIN run_failure f ON f.run_id = r.run_id
                WHERE r.turn_id = :turnId
                ORDER BY r.started_at, r.run_id
                """)
                .param("turnId", turnId)
                .query((rs, rowNum) -> mapRunView(rs))
                .list();
    }

    private RunView mapRunView(java.sql.ResultSet rs)
            throws java.sql.SQLException {
        return new RunView(
                rs.getString("run_id"),
                rs.getString("turn_id"),
                rs.getString("parent_run_id"),
                rs.getString("root_run_id"),
                null,
                rs.getString("kind"),
                new RunDefinition(
                        rs.getString("definition_id"),
                        rs.getString("definition_version"),
                        rs.getString("snapshot_hash"),
                        rs.getString("normalized_input_hash"),
                        rs.getString("dependency_snapshot_ref")
                ),
                rs.getString("purpose"),
                rs.getString("phase"),
                mapRunClosure(rs),
                List.of(),
                roundIds(rs.getString("run_id")),
                childRunIds(rs.getString("run_id")),
                new RunBudget(
                        0,
                        rs.getInt("tool_calls_limit"),
                        0,
                        rs.getLong("time_limit_ms")
                ),
                null,
                List.of(),
                mapFailure(rs),
                rs.getLong("version"),
                Instant.parse(rs.getString("started_at")),
                rs.getString("ended_at") == null
                        ? null
                        : Instant.parse(rs.getString("ended_at"))
        );
    }

    private RunClosureView mapRunClosure(java.sql.ResultSet rs)
            throws java.sql.SQLException {
        if (rs.getString("closure_run_id") == null) {
            return null;
        }
        return new RunClosureView(
                rs.getString("closure_execution_status"),
                rs.getString("closure_task_outcome"),
                rs.getString("closure_terminal_reason"),
                rs.getString("closure_final_stop_reason"),
                new RunClosureCounts(
                        rs.getInt("closure_round_count"),
                        rs.getInt("closure_model_attempt_count"),
                        rs.getInt("closure_tool_call_count"),
                        rs.getInt("closure_tool_execution_count"),
                        rs.getInt("closure_tool_observation_count"),
                        rs.getInt("closure_tool_succeeded_count"),
                        rs.getInt("closure_tool_failed_count"),
                        rs.getInt(
                                "closure_tool_outcome_unknown_count"
                        ),
                        rs.getInt("closure_tool_rejected_count"),
                        rs.getInt("closure_tool_expired_count"),
                        rs.getInt(
                                "closure_unresolved_protocol_facts"
                        ),
                        rs.getInt("closure_evidence_count"),
                        rs.getInt("closure_artifact_count")
                ),
                rs.getInt("closure_has_final_answer") == 1,
                Instant.parse(rs.getString("closure_recorded_at"))
        );
    }

    private FailureView mapFailure(java.sql.ResultSet rs)
            throws java.sql.SQLException {
        String code = rs.getString("failure_code");
        if (code == null) {
            return null;
        }
        return new FailureView(
                code,
                rs.getString("failure_category"),
                rs.getString("failure_user_message"),
                rs.getString("failure_trace_id"),
                rs.getString("failure_source"),
                rs.getString("failure_recovery_action"),
                rs.getString("failure_side_effect_outcome"),
                rs.getString("failure_details_ref")
        );
    }

    private List<String> roundIds(String runId) {
        return jdbc.sql("""
                SELECT round_id FROM agent_round
                WHERE run_id = :runId
                ORDER BY round_index
                """)
                .param("runId", runId)
                .query(String.class)
                .list();
    }

    private List<String> childRunIds(String runId) {
        return jdbc.sql("""
                SELECT run_id FROM agent_run
                WHERE parent_run_id = :runId
                ORDER BY started_at, run_id
                """)
                .param("runId", runId)
                .query(String.class)
                .list();
    }

    public RoundView roundView(String roundId) {
        return jdbc.sql("""
                SELECT * FROM agent_round
                WHERE round_id = :roundId
                """)
                .param("roundId", roundId)
                .query((rs, rowNum) -> mapRoundView(rs))
                .optional()
                .orElseThrow(() -> new IllegalStateException("找不到 Round"));
    }

    private List<RoundView> rounds(String runId) {
        return jdbc.sql("""
                SELECT * FROM agent_round
                WHERE run_id = :runId
                ORDER BY round_index
                """)
                .param("runId", runId)
                .query((rs, rowNum) -> mapRoundView(rs))
                .list();
    }

    private RoundView mapRoundView(java.sql.ResultSet rs)
            throws java.sql.SQLException {
        return new RoundView(
                rs.getString("round_id"),
                rs.getString("run_id"),
                rs.getInt("round_index"),
                visibleRoundPhase(rs.getString("phase")),
                processNodeIds(rs.getString("round_id")),
                rs.getString("answer_node_id"),
                new RoundStats(
                        rs.getInt("tool_call_count"),
                        rs.getLong("duration_ms")
                ),
                rs.getLong("version")
        );
    }

    /**
     * Round 的内部相位比投影词汇丰富；对外统一折叠为
     * active / settled / failed（docs/08 §10.3）。
     */
    public static String visibleRoundPhase(String phase) {
        return switch (phase) {
            case "completed" -> "settled";
            case "stopped" -> "stopped";
            case "failed" -> "failed";
            default -> "active";
        };
    }

    private List<String> processNodeIds(String roundId) {
        return jdbc.sql("""
                SELECT node_id FROM render_node_projection
                WHERE round_id = :roundId AND node_type <> 'answer'
                ORDER BY ordinal
                """)
                .param("roundId", roundId)
                .query(String.class)
                .list();
    }

    private List<JsonNode> renderNodes(String turnId) {
        return jdbc.sql("""
                SELECT projection_json FROM render_node_projection
                WHERE turn_id = :turnId
                ORDER BY ordinal, node_id
                """)
                .param("turnId", turnId)
                .query(String.class)
                .list()
                .stream()
                .map(this::readJson)
                .toList();
    }

    private List<String> pendingAttentionIds(String turnId) {
        return jdbc.sql("""
                SELECT attention_id FROM attention_projection
                WHERE turn_id = :turnId AND status = 'waiting'
                ORDER BY created_at
                """)
                .param("turnId", turnId)
                .query(String.class)
                .list();
    }

    private List<BranchSummary> branches(String conversationId) {
        return jdbc.sql("""
                SELECT b.*, bf.mode, bf.anchor_message_id,
                       bf.source_turn_id, bf.source_event_sequence,
                       bf.base_context_frame_id,
                       base_frame.waterline_sequence AS base_waterline_sequence,
                    (
                        SELECT t.turn_id FROM conversation_turn t
                        JOIN conversation_event e
                          ON e.turn_id = t.turn_id
                         AND e.event_type = 'turn.accepted'
                        WHERE t.branch_id = b.branch_id
                        ORDER BY e.sequence DESC LIMIT 1
                    ) AS head_turn_id
                FROM conversation_branch b
                LEFT JOIN branch_fork bf ON bf.branch_id = b.branch_id
                LEFT JOIN context_frame base_frame
                  ON base_frame.frame_id = bf.base_context_frame_id
                WHERE b.conversation_id = :conversationId
                ORDER BY b.created_at, b.branch_id
                """)
                .param("conversationId", conversationId)
                .query((rs, rowNum) -> new BranchSummary(
                        rs.getString("branch_id"),
                        rs.getString("parent_branch_id"),
                        rs.getString("mode") == null
                                ? null
                                : new ForkAnchor(
                                        rs.getString("mode"),
                                        rs.getString("anchor_message_id"),
                                        rs.getString("source_turn_id"),
                                        rs.getLong("source_event_sequence"),
                                        rs.getString("base_context_frame_id"),
                                        rs.getLong("base_waterline_sequence")
                                ),
                        rs.getString("head_turn_id"),
                        rs.getString("status"),
                        rs.getLong("version")
                ))
                .list();
    }

    private List<JsonNode> compactBoundaries(
            String conversationId,
            String branchId
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

                    UNION ALL

                    SELECT parent.frame_id, parent.parent_frame_id,
                           parent.waterline_sequence
                    FROM frame_chain child
                    JOIN context_frame parent
                      ON parent.frame_id = child.parent_frame_id
                )
                SELECT cb.*, cs.summary_text,
                       chain.waterline_sequence AS sequence,
                       chain.parent_frame_id
                FROM compact_boundary cb
                JOIN compact_summary cs ON cs.boundary_id = cb.boundary_id
                JOIN frame_chain chain ON chain.frame_id = cb.frame_id
                WHERE cb.conversation_id = :conversationId
                ORDER BY chain.waterline_sequence, cb.boundary_id
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .query((rs, rowNum) -> {
                    ObjectNode node = objectMapper.createObjectNode();
                    node.put("boundaryId", rs.getString("boundary_id"));
                    node.put("contextFrameId", rs.getString("frame_id"));
                    node.put(
                            "parentContextFrameId",
                            rs.getString("parent_frame_id")
                    );
                    node.put("branchId", rs.getString("branch_id"));
                    node.put("beforeTurnId", rs.getString("before_turn_id"));
                    node.put("waterlineSequence", rs.getLong("sequence"));
                    node.put(
                            "inherited",
                            !branchId.equals(rs.getString("branch_id"))
                    );
                    node.put("trigger", rs.getString("trigger"));
                    node.put("coveredCount", rs.getInt("covered_count"));
                    node.put(
                            "summaryArtifactRef",
                            rs.getString("summary_artifact_ref")
                    );
                    node.put("summary", rs.getString("summary_text"));
                    node.put("version", rs.getLong("version"));
                    return (JsonNode) node;
                })
                .list();
    }

    private Map<String, JsonNode> attentions(
            String conversationId,
            String branchId
    ) {
        Map<String, JsonNode> result = new LinkedHashMap<>();
        jdbc.sql("""
                SELECT attention_id, projection_json
                FROM attention_projection
                WHERE conversation_id = :conversationId AND branch_id = :branchId
                ORDER BY created_at, attention_id
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .query((rs, rowNum) -> Map.entry(
                        rs.getString("attention_id"),
                        readJson(rs.getString("projection_json"))
                ))
                .list()
                .forEach(entry -> result.put(entry.getKey(), entry.getValue()));
        return result;
    }

    private Map<String, JsonNode> compactions(
            String conversationId,
            String branchId
    ) {
        Map<String, JsonNode> result = new LinkedHashMap<>();
        jdbc.sql("""
                SELECT run.*, source.fact_count,
                       source.estimated_tokens,
                       CASE
                         WHEN agent.purpose = 'compact_context_auto'
                         THEN 'auto'
                         ELSE 'manual'
                       END AS trigger
                FROM compaction_run run
                JOIN compaction_source_snapshot source
                  ON source.snapshot_id = run.source_snapshot_id
                JOIN agent_run agent ON agent.run_id = run.run_id
                WHERE run.conversation_id = :conversationId
                  AND run.branch_id = :branchId
                ORDER BY run.requested_at, run.run_id
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .query((rs, rowNum) -> {
                    ObjectNode node = objectMapper.createObjectNode();
                    node.put("runId", rs.getString("run_id"));
                    node.put(
                            "conversationId",
                            rs.getString("conversation_id")
                    );
                    node.put("branchId", rs.getString("branch_id"));
                    node.put("phase", rs.getString("phase"));
                    node.put("trigger", rs.getString("trigger"));
                    node.put(
                            "parentContextFrameId",
                            rs.getString("parent_frame_id")
                    );
                    node.put(
                            "sourceStartSequence",
                            rs.getLong("source_start_sequence")
                    );
                    node.put(
                            "waterlineSequence",
                            rs.getLong("waterline_sequence")
                    );
                    node.put(
                            "beforeTurnId",
                            rs.getString("before_turn_id")
                    );
                    node.put(
                            "sourceSnapshotId",
                            rs.getString("source_snapshot_id")
                    );
                    node.put("sourceFactCount", rs.getInt("fact_count"));
                    node.put(
                            "estimatedInputTokens",
                            rs.getInt("estimated_tokens")
                    );
                    putNullable(
                            node,
                            "compactBoundaryId",
                            rs.getString("compact_boundary_id")
                    );
                    String failure = rs.getString("failure_json");
                    if (failure == null) {
                        node.putNull("failure");
                    } else {
                        node.set("failure", readJson(failure));
                    }
                    node.put("version", rs.getLong("version"));
                    node.put(
                            "requestedAt",
                            rs.getString("requested_at")
                    );
                    putNullable(node, "endedAt", rs.getString("ended_at"));
                    return Map.entry(
                            rs.getString("run_id"),
                            (JsonNode) node
                    );
                })
                .list()
                .forEach(entry -> result.put(entry.getKey(), entry.getValue()));
        return result;
    }

    private void putNullable(
            ObjectNode node,
            String field,
            String value
    ) {
        if (value == null) {
            node.putNull(field);
        } else {
            node.put(field, value);
        }
    }

    private String latestEventId(String conversationId) {
        return jdbc.sql("""
                SELECT event_id FROM conversation_event
                WHERE conversation_id = :conversationId
                ORDER BY sequence DESC LIMIT 1
                """)
                .param("conversationId", conversationId)
                .query(String.class)
                .optional()
                .orElse(null);
    }

    private boolean hasEarlierTurns(
            String conversationId,
            String branchId,
            long oldestSequence
    ) {
        if (oldestSequence == Long.MAX_VALUE) {
            return false;
        }
        return jdbc.sql("""
                WITH RECURSIVE branch_path(
                    branch_id, cutoff_sequence
                ) AS (
                    SELECT :branchId, NULL
                    UNION ALL
                    SELECT cb.parent_branch_id, bf.source_event_sequence
                    FROM branch_path path
                    JOIN conversation_branch cb
                      ON cb.branch_id = path.branch_id
                    JOIN branch_fork bf
                      ON bf.branch_id = path.branch_id
                    WHERE cb.parent_branch_id IS NOT NULL
                )
                SELECT COUNT(*)
                FROM conversation_event e
                JOIN branch_path path ON path.branch_id = e.branch_id
                WHERE e.conversation_id = :conversationId
                  AND e.event_type = 'turn.accepted'
                  AND e.sequence < :oldestSequence
                  AND (
                    path.cutoff_sequence IS NULL
                    OR e.sequence < path.cutoff_sequence
                  )
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("oldestSequence", oldestSequence)
                .query(Integer.class)
                .single() > 0;
    }

    private int roundsForTurn(
            List<RunView> runs,
            Map<String, RoundView> roundsById
    ) {
        return runs.stream()
                .mapToInt(run -> (int) run.roundIds().stream()
                        .filter(roundsById::containsKey)
                        .count())
                .sum();
    }

    private int toolCallsForTurn(List<JsonNode> nodes) {
        return (int) nodes.stream()
                .filter(node -> "tool".equals(node.path("type").asText()))
                .count();
    }

    private JsonNode readJson(String json) {
        try {
            return objectMapper.readTree(json);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "Stored projection is not valid JSON",
                    exception
            );
        }
    }

    private record CursorPosition(String conversationId, String updatedAt) {
    }

    private record ConversationHeader(
            String conversationId,
            String rootBranchId,
            String title,
            long version
    ) {
    }

    private record TurnRow(
            String turnId,
            String branchId,
            String messageId,
            String rootRunId,
            String phase,
            long version,
            Instant startedAt,
            Instant endedAt,
            String content,
            long eventSequence
    ) {
    }
}
