package com.iris.agent.model;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
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
            String conversationId,
            String branchId,
            String beforeTurnId,
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
                conversationId,
                branchId,
                beforeTurnId,
                trigger,
                summary.trim()
        ));
        if (result == null) {
            throw new IllegalStateException(
                    "Compaction transaction returned no result"
            );
        }
        return result;
    }

    private CompactBoundary recordOnce(
            String conversationId,
            String branchId,
            String beforeTurnId,
            String trigger,
            String summary
    ) {
        BoundaryPosition position = jdbc.sql("""
                SELECT e.sequence
                FROM conversation_turn t
                JOIN conversation_event e
                  ON e.turn_id = t.turn_id
                 AND e.event_type = 'turn.accepted'
                WHERE t.conversation_id = :conversationId
                  AND t.branch_id = :branchId
                  AND t.turn_id = :turnId
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("turnId", beforeTurnId)
                .query((rs, rowNum) -> new BoundaryPosition(
                        rs.getLong("sequence")
                ))
                .optional()
                .orElseThrow(() -> new IllegalArgumentException(
                        "Compaction boundary turn is not on the selected branch"
                ));
        int covered = jdbc.sql("""
                SELECT COUNT(*)
                FROM conversation_event
                WHERE conversation_id = :conversationId
                  AND branch_id = :branchId
                  AND event_type = 'turn.accepted'
                  AND sequence < :boundarySequence
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
        String artifactRef = "context-summary:" + boundaryId;
        String now = clock.instant().toString();
        jdbc.sql("""
                INSERT INTO compact_boundary(
                    boundary_id, conversation_id, branch_id, before_turn_id,
                    trigger, covered_count, summary_artifact_ref,
                    version, created_at
                ) VALUES (
                    :boundaryId, :conversationId, :branchId, :beforeTurnId,
                    :trigger, :coveredCount, :artifactRef,
                    1, :now
                )
                """)
                .param("boundaryId", boundaryId)
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
        return new CompactBoundary(
                boundaryId,
                beforeTurnId,
                trigger,
                covered,
                artifactRef,
                summary
        );
    }

    private void assertCoveredRangeClosed(
            String conversationId,
            String branchId,
            long boundarySequence
    ) {
        int openFacts = jdbc.sql("""
                SELECT
                    (
                        SELECT COUNT(*)
                        FROM agent_run r
                        JOIN conversation_event e
                          ON e.turn_id = r.turn_id
                         AND e.event_type = 'turn.accepted'
                        WHERE r.conversation_id = :conversationId
                          AND r.branch_id = :branchId
                          AND e.sequence < :boundarySequence
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
                        WHERE ma.conversation_id = :conversationId
                          AND e.branch_id = :branchId
                          AND e.sequence < :boundarySequence
                          AND ma.phase = 'streaming'
                    )
                    +
                    (
                        SELECT COUNT(*)
                        FROM tool_execution te
                        JOIN conversation_event e
                          ON e.turn_id = te.turn_id
                         AND e.event_type = 'turn.accepted'
                        WHERE te.conversation_id = :conversationId
                          AND e.branch_id = :branchId
                          AND e.sequence < :boundarySequence
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
            String beforeTurnId,
            String trigger,
            int coveredCount,
            String summaryArtifactRef,
            String summary
    ) {
    }

    private record BoundaryPosition(long sequence) {
    }
}
