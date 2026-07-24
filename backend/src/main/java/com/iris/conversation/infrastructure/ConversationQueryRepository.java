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
import com.iris.conversation.domain.ConversationViews.RequestView;
import com.iris.conversation.domain.ConversationViews.RoundStats;
import com.iris.conversation.domain.ConversationViews.RoundView;
import com.iris.conversation.domain.ConversationViews.RunBudget;
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

    public ConversationQueryRepository(JdbcClient jdbc, ObjectMapper objectMapper) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
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
            List<String> attachmentRefs = attachments(row.messageId());
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
            List<String> attentionIds = pendingAttentionIds(row.turnId());
            turns.put(row.turnId(), new TurnView(
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
                    null,
                    List.of(),
                    new TurnStats(
                            roundsForTurn(turnRuns, rounds),
                            toolCallsForTurn(turnNodes),
                            Math.max(0, turnRuns.size() - 1),
                            row.startedAt(),
                            row.endedAt()
                    ),
                    row.version()
            ));
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
                Map.of(),
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
                SELECT e.sequence
                FROM conversation_event e
                WHERE e.conversation_id = :conversationId
                  AND e.branch_id = :branchId
                  AND e.event_type = 'turn.accepted'
                  AND e.turn_id = :turnId
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
                WHERE t.conversation_id = :conversationId
                  AND t.branch_id = :branchId
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

    private List<RunView> runs(String turnId) {
        return jdbc.sql("""
                SELECT r.*, d.*
                FROM agent_run r
                JOIN run_definition_snapshot d ON d.run_id = r.run_id
                WHERE r.turn_id = :turnId
                ORDER BY r.started_at, r.run_id
                """)
                .param("turnId", turnId)
                .query((rs, rowNum) -> new RunView(
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
                        null,
                        rs.getLong("version"),
                        Instant.parse(rs.getString("started_at")),
                        rs.getString("ended_at") == null
                                ? null
                                : Instant.parse(rs.getString("ended_at"))
                ))
                .list();
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

    private List<RoundView> rounds(String runId) {
        return jdbc.sql("""
                SELECT * FROM agent_round
                WHERE run_id = :runId
                ORDER BY round_index
                """)
                .param("runId", runId)
                .query((rs, rowNum) -> new RoundView(
                        rs.getString("round_id"),
                        rs.getString("run_id"),
                        rs.getInt("round_index"),
                        rs.getString("phase"),
                        processNodeIds(rs.getString("round_id")),
                        rs.getString("answer_node_id"),
                        new RoundStats(
                                rs.getInt("tool_call_count"),
                                rs.getLong("duration_ms")
                        ),
                        rs.getLong("version")
                ))
                .list();
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
                SELECT b.*,
                    (
                        SELECT t.turn_id FROM conversation_turn t
                        JOIN conversation_event e
                          ON e.turn_id = t.turn_id
                         AND e.event_type = 'turn.accepted'
                        WHERE t.branch_id = b.branch_id
                        ORDER BY e.sequence DESC LIMIT 1
                    ) AS head_turn_id
                FROM conversation_branch b
                WHERE b.conversation_id = :conversationId
                ORDER BY b.created_at, b.branch_id
                """)
                .param("conversationId", conversationId)
                .query((rs, rowNum) -> new BranchSummary(
                        rs.getString("branch_id"),
                        rs.getString("parent_branch_id"),
                        null,
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
                SELECT * FROM compact_boundary
                WHERE conversation_id = :conversationId AND branch_id = :branchId
                ORDER BY created_at, boundary_id
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .query((rs, rowNum) -> {
                    ObjectNode node = objectMapper.createObjectNode();
                    node.put("boundaryId", rs.getString("boundary_id"));
                    node.put("beforeTurnId", rs.getString("before_turn_id"));
                    node.put("trigger", rs.getString("trigger"));
                    node.put("coveredCount", rs.getInt("covered_count"));
                    node.put(
                            "summaryArtifactRef",
                            rs.getString("summary_artifact_ref")
                    );
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
                SELECT COUNT(*) FROM conversation_event
                WHERE conversation_id = :conversationId
                  AND branch_id = :branchId
                  AND event_type = 'turn.accepted'
                  AND sequence < :oldestSequence
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
