package com.iris.agent.model;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.util.List;
import java.util.HexFormat;
import java.util.UUID;

/**
 * Records a new view boundary. Canonical messages and model facts are untouched.
 */
@Service
public class CompactionService {
    private final JdbcClient jdbc;
    private final TransactionTemplate transactions;
    private final ModelTokenEstimator tokens;
    private final Clock clock = Clock.systemUTC();

    public CompactionService(
            JdbcClient jdbc,
            TransactionTemplate transactions,
            ModelTokenEstimator tokens
    ) {
        this.jdbc = jdbc;
        this.transactions = transactions;
        this.tokens = tokens;
    }

    public CompactBoundary record(
            CompactPlan plan,
            String trigger,
            String summary
    ) {
        requireSummary(summary);
        if (!"manual".equals(trigger) && !"auto".equals(trigger)) {
            throw new IllegalArgumentException(
                    "Compaction trigger must be manual or auto"
            );
        }
        CompactBoundary result = transactions.execute(status -> recordOnce(
                plan.conversationId(),
                plan.branchId(),
                plan.beforeTurnId(),
                trigger,
                summary.trim(),
                plan.parentFrameId()
        ));
        if (result == null) {
            throw new IllegalStateException(
                    "Compaction transaction returned no result"
            );
        }
        return result;
    }

    /**
     * Chooses the first retained Turn; callers never supply a cutoff.
     * The plan is a hint until record() revalidates the same head and range.
     */
    public CompactPlan planManual(
            String conversationId,
            String branchId
    ) {
        ContextHead head = contextHead(conversationId, branchId);
        List<VisibleTurn> tail = visibleTurnsAfter(
                conversationId,
                branchId,
                head.waterlineSequence()
        );
        if (tail.stream().anyMatch(turn ->
                "queued".equals(turn.phase())
                        || "active".equals(turn.phase()))) {
            throw new IllegalStateException(
                    "Cannot compact a branch with an active Turn"
            );
        }
        int retainedTailTurns = 4;
        int boundaryIndex = tail.size() - retainedTailTurns;
        if (boundaryIndex < 2) {
            throw new IllegalStateException(
                    "Not enough new closed history to compact"
            );
        }
        VisibleTurn boundary = tail.get(boundaryIndex);
        VisibleTurn operationAnchor = tail.get(tail.size() - 1);
        return new CompactPlan(
                conversationId,
                branchId,
                head.frameId(),
                head.waterlineSequence(),
                boundary.turnId(),
                boundary.sequence(),
                operationAnchor.turnId(),
                boundaryIndex,
                retainedTailTurns
        );
    }

    private List<VisibleTurn> visibleTurnsAfter(
            String conversationId,
            String branchId,
            long waterline
    ) {
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
                )
                SELECT turn.turn_id, turn.phase, event.sequence
                FROM conversation_turn turn
                JOIN conversation_event event
                  ON event.turn_id = turn.turn_id
                 AND event.event_type = 'turn.accepted'
                JOIN branch_path path
                  ON path.branch_id = turn.branch_id
                WHERE turn.conversation_id = :conversationId
                  AND event.sequence >= :waterline
                  AND (
                    path.cutoff_sequence IS NULL
                    OR event.sequence < path.cutoff_sequence
                  )
                ORDER BY event.sequence
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("waterline", waterline)
                .query((rs, rowNum) -> new VisibleTurn(
                        rs.getString("turn_id"),
                        rs.getString("phase"),
                        rs.getLong("sequence")
                ))
                .list();
    }

    private CompactBoundary recordOnce(
            String conversationId,
            String branchId,
            String beforeTurnId,
            String trigger,
            String summary,
            String expectedParentFrameId
    ) {
        BoundaryPosition position = jdbc.sql("""
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
                )
                SELECT e.sequence
                FROM conversation_turn t
                JOIN conversation_event e
                  ON e.turn_id = t.turn_id
                 AND e.event_type = 'turn.accepted'
                JOIN branch_path path ON path.branch_id = t.branch_id
                WHERE t.conversation_id = :conversationId
                  AND t.turn_id = :turnId
                  AND (
                    path.cutoff_sequence IS NULL
                    OR e.sequence < path.cutoff_sequence
                  )
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("turnId", beforeTurnId)
                .query((rs, rowNum) -> new BoundaryPosition(
                        rs.getLong("sequence")
                ))
                .optional()
                .orElseThrow(() -> new IllegalArgumentException(
                        "Compaction boundary turn is not visible on the selected branch"
                ));
        ContextHead previousHead = contextHead(
                conversationId,
                branchId
        );
        if (expectedParentFrameId != null
                && !expectedParentFrameId.equals(previousHead.frameId())) {
            throw new IllegalStateException(
                    "Compaction source Frame is stale"
            );
        }
        if (position.sequence() <= previousHead.waterlineSequence()) {
            throw new IllegalArgumentException(
                    "Compaction waterline must move forward"
            );
        }
        int covered = jdbc.sql("""
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
                )
                SELECT COUNT(*)
                FROM conversation_event e
                JOIN branch_path path ON path.branch_id = e.branch_id
                WHERE e.conversation_id = :conversationId
                  AND e.event_type = 'turn.accepted'
                  AND e.sequence < :boundarySequence
                  AND (
                    path.cutoff_sequence IS NULL
                    OR e.sequence < path.cutoff_sequence
                  )
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("boundarySequence", position.sequence())
                .query(Integer.class)
                .single();
        if (covered == 0) {
            throw new IllegalArgumentException(
                    "Compaction boundary does not cover any earlier turn"
            );
        }
        assertCoveredRangeClosed(
                conversationId,
                branchId,
                position.sequence()
        );
        Integer alreadyExists = jdbc.sql("""
                SELECT COUNT(*) FROM compact_boundary
                WHERE conversation_id = :conversationId
                  AND branch_id = :branchId
                  AND before_turn_id = :beforeTurnId
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("beforeTurnId", beforeTurnId)
                .query(Integer.class)
                .single();
        if (alreadyExists > 0) {
            throw new IllegalStateException(
                    "This compaction position already has a boundary"
            );
        }

        String boundaryId = id("compact");
        String frameId = id("frame");
        String artifactRef = "context-summary:" + boundaryId;
        String now = clock.instant().toString();
        jdbc.sql("""
                INSERT INTO context_frame(
                    frame_id, conversation_id, owner_branch_id,
                    parent_frame_id, frame_kind, waterline_sequence,
                    before_turn_id, version, created_at
                ) VALUES (
                    :frameId, :conversationId, :branchId,
                    :parentFrameId, 'compact', :waterlineSequence,
                    :beforeTurnId, 1, :now
                )
                """)
                .param("frameId", frameId)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("parentFrameId", previousHead.frameId())
                .param("waterlineSequence", position.sequence())
                .param("beforeTurnId", beforeTurnId)
                .param("now", now)
                .update();
        jdbc.sql("""
                INSERT INTO compact_boundary(
                    boundary_id, frame_id, conversation_id,
                    branch_id, before_turn_id,
                    trigger, covered_count, summary_artifact_ref,
                    version, created_at
                ) VALUES (
                    :boundaryId, :frameId, :conversationId,
                    :branchId, :beforeTurnId,
                    :trigger, :coveredCount, :artifactRef,
                    1, :now
                )
                """)
                .param("boundaryId", boundaryId)
                .param("frameId", frameId)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("beforeTurnId", beforeTurnId)
                .param("trigger", trigger)
                .param("coveredCount", covered)
                .param("artifactRef", artifactRef)
                .param("now", now)
                .update();
        jdbc.sql("""
                INSERT INTO compact_summary(
                    summary_artifact_ref, boundary_id, summary_text,
                    content_hash, estimated_tokens, created_at
                ) VALUES (
                    :artifactRef, :boundaryId, :summary,
                    :contentHash, :estimatedTokens, :now
                )
                """)
                .param("artifactRef", artifactRef)
                .param("boundaryId", boundaryId)
                .param("summary", summary)
                .param("contentHash", hash(summary))
                .param("estimatedTokens", tokens.estimateText(summary))
                .param("now", now)
                .update();
        int headAdvanced = jdbc.sql("""
                UPDATE branch_context_head
                SET frame_id = :frameId,
                    version = version + 1,
                    updated_at = :now
                WHERE branch_id = :branchId
                  AND frame_id = :previousFrameId
                """)
                .param("frameId", frameId)
                .param("now", now)
                .param("branchId", branchId)
                .param("previousFrameId", previousHead.frameId())
                .update();
        if (headAdvanced != 1) {
            throw new IllegalStateException(
                    "Compaction context head changed concurrently"
            );
        }
        return new CompactBoundary(
                boundaryId,
                frameId,
                previousHead.frameId(),
                beforeTurnId,
                trigger,
                covered,
                artifactRef,
                summary,
                position.sequence(),
                previousHead.waterlineSequence()
        );
    }

    private ContextHead contextHead(
            String conversationId,
            String branchId
    ) {
        return jdbc.sql("""
                SELECT frame.frame_id, frame.waterline_sequence
                FROM branch_context_head head
                JOIN context_frame frame ON frame.frame_id = head.frame_id
                JOIN conversation_branch branch
                  ON branch.branch_id = head.branch_id
                WHERE head.branch_id = :branchId
                  AND branch.conversation_id = :conversationId
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .query((rs, rowNum) -> new ContextHead(
                        rs.getString("frame_id"),
                        rs.getLong("waterline_sequence")
                ))
                .optional()
                .orElseThrow(() -> new IllegalArgumentException(
                        "Selected branch has no context head"
                ));
    }

    private void assertCoveredRangeClosed(
            String conversationId,
            String branchId,
            long boundarySequence
    ) {
        int openFacts = jdbc.sql("""
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
                )
                SELECT
                    (
                        SELECT COUNT(*)
                        FROM agent_run r
                        JOIN conversation_event e
                          ON e.turn_id = r.turn_id
                         AND e.event_type = 'turn.accepted'
                        JOIN branch_path path
                          ON path.branch_id = r.branch_id
                        WHERE r.conversation_id = :conversationId
                          AND e.sequence < :boundarySequence
                          AND (
                            path.cutoff_sequence IS NULL
                            OR e.sequence < path.cutoff_sequence
                          )
                          AND r.phase NOT IN (
                              'succeeded', 'failed', 'cancelled',
                              'outcome_unknown'
                          )
                    )
                    +
                    (
                        SELECT COUNT(*)
                        FROM model_attempt ma
                        JOIN conversation_event e
                          ON e.turn_id = ma.turn_id
                         AND e.event_type = 'turn.accepted'
                        JOIN agent_round ar
                          ON ar.round_id = ma.round_id
                        JOIN branch_path path
                          ON path.branch_id = ar.branch_id
                        WHERE ma.conversation_id = :conversationId
                          AND e.sequence < :boundarySequence
                          AND (
                            path.cutoff_sequence IS NULL
                            OR e.sequence < path.cutoff_sequence
                          )
                          AND ma.phase = 'streaming'
                    )
                    +
                    (
                        SELECT COUNT(*)
                        FROM tool_execution te
                        JOIN conversation_event e
                          ON e.turn_id = te.turn_id
                         AND e.event_type = 'turn.accepted'
                        JOIN branch_path path
                          ON path.branch_id = e.branch_id
                        WHERE te.conversation_id = :conversationId
                          AND e.sequence < :boundarySequence
                          AND (
                            path.cutoff_sequence IS NULL
                            OR e.sequence < path.cutoff_sequence
                          )
                          AND te.phase NOT IN (
                              'succeeded', 'failed', 'rejected',
                              'expired', 'outcome_unknown'
                          )
                    ) AS open_fact_count
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("boundarySequence", boundarySequence)
                .query(Integer.class)
                .single();
        if (openFacts != 0) {
            throw new IllegalStateException(
                    "Compaction cutoff would cross unfinished model or tool facts"
            );
        }
    }

    private void requireSummary(String summary) {
        if (summary == null || summary.isBlank()) {
            throw new IllegalArgumentException(
                    "Compaction summary cannot be blank"
            );
        }
        if (summary.length() > 100_000) {
            throw new IllegalArgumentException(
                    "Compaction summary is too large"
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

    private String id(String prefix) {
        return prefix + "_" + UUID.randomUUID().toString().replace("-", "");
    }

    public record CompactBoundary(
            String boundaryId,
            String frameId,
            String parentFrameId,
            String beforeTurnId,
            String trigger,
            int coveredCount,
            String summaryArtifactRef,
            String summary,
            long waterlineSequence,
            long previousWaterlineSequence
    ) {
    }

    private record BoundaryPosition(long sequence) {
    }

    private record ContextHead(
            String frameId,
            long waterlineSequence
    ) {
    }

    private record VisibleTurn(
            String turnId,
            String phase,
            long sequence
    ) {
    }

    public record CompactPlan(
            String conversationId,
            String branchId,
            String parentFrameId,
            long sourceStartSequence,
            String beforeTurnId,
            long waterlineSequence,
            String operationAnchorTurnId,
            int sourceTurnCount,
            int retainedTailTurnCount
    ) {
    }
}
