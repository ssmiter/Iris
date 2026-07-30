package com.iris.agent.run;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.Optional;

/**
 * Persists the immutable, objectively computed facts available when a Run
 * reaches its terminal boundary. It deliberately does not infer whether the
 * user's real-world objective was fulfilled.
 */
@Repository
public class RunClosureRepository {
    private static final String TASK_NOT_ASSESSED = "not_assessed";

    private final JdbcClient jdbc;

    public RunClosureRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public ClosureFacts inspect(String runId) {
        return jdbc.sql("""
                SELECT
                    (
                        SELECT COUNT(*) FROM agent_round r
                        WHERE r.run_id = :runId
                    ) AS round_count,
                    (
                        SELECT COUNT(*) FROM model_attempt a
                        WHERE a.run_id = :runId
                    ) AS model_attempt_count,
                    (
                        SELECT COUNT(*)
                        FROM model_tool_call c
                        JOIN model_attempt a ON a.attempt_id = c.attempt_id
                        WHERE a.run_id = :runId
                    ) AS tool_call_count,
                    (
                        SELECT COUNT(*) FROM tool_execution e
                        WHERE e.run_id = :runId
                    ) AS tool_execution_count,
                    (
                        SELECT COUNT(*)
                        FROM tool_observation o
                        JOIN tool_execution e
                          ON e.execution_id = o.execution_id
                        WHERE e.run_id = :runId
                    ) AS tool_observation_count,
                    (
                        SELECT COUNT(*) FROM tool_execution e
                        WHERE e.run_id = :runId AND e.phase = 'succeeded'
                    ) AS tool_succeeded_count,
                    (
                        SELECT COUNT(*) FROM tool_execution e
                        WHERE e.run_id = :runId AND e.phase = 'failed'
                    ) AS tool_failed_count,
                    (
                        SELECT COUNT(*) FROM tool_execution e
                        WHERE e.run_id = :runId
                          AND e.phase = 'outcome_unknown'
                    ) AS tool_outcome_unknown_count,
                    (
                        SELECT COUNT(*) FROM tool_execution e
                        WHERE e.run_id = :runId AND e.phase = 'rejected'
                    ) AS tool_rejected_count,
                    (
                        SELECT COUNT(*) FROM tool_execution e
                        WHERE e.run_id = :runId AND e.phase = 'expired'
                    ) AS tool_expired_count,
                    (
                        SELECT COUNT(*)
                        FROM model_tool_call c
                        JOIN model_attempt a ON a.attempt_id = c.attempt_id
                        LEFT JOIN tool_execution e
                          ON e.tool_call_id = c.tool_call_id
                        WHERE a.run_id = :runId
                          AND e.execution_id IS NULL
                    ) AS unmatched_tool_call_count,
                    (
                        SELECT COUNT(*)
                        FROM tool_execution e
                        LEFT JOIN model_tool_call c
                          ON c.tool_call_id = e.tool_call_id
                        WHERE e.run_id = :runId
                          AND c.tool_call_id IS NULL
                    ) AS orphan_tool_execution_count,
                    (
                        SELECT COUNT(*) FROM tool_execution e
                        WHERE e.run_id = :runId
                          AND e.phase NOT IN (
                              'succeeded', 'failed', 'outcome_unknown',
                              'rejected', 'expired'
                          )
                    ) AS non_terminal_execution_count,
                    (
                        SELECT COUNT(*)
                        FROM tool_execution e
                        LEFT JOIN tool_observation o
                          ON o.execution_id = e.execution_id
                        WHERE e.run_id = :runId
                          AND e.phase IN (
                              'succeeded', 'failed', 'outcome_unknown',
                              'rejected', 'expired'
                          )
                          AND o.observation_id IS NULL
                    ) AS missing_observation_count,
                    (
                        SELECT COUNT(*)
                        FROM tool_evidence v
                        JOIN tool_execution e
                          ON e.execution_id = v.execution_id
                        WHERE e.run_id = :runId
                    ) AS evidence_count,
                    (
                        SELECT COUNT(*) FROM artifact f
                        WHERE f.source_run_id = :runId
                    ) AS artifact_count,
                    EXISTS (
                        SELECT 1 FROM render_node_projection n
                        WHERE n.run_id = :runId
                          AND n.node_type = 'answer'
                          AND n.node_status = 'completed'
                          AND json_extract(
                              n.projection_json, '$.role'
                          ) = 'final'
                    ) AS has_final_answer,
                    (
                        SELECT a.stop_reason
                        FROM model_attempt a
                        JOIN agent_round r ON r.round_id = a.round_id
                        WHERE a.run_id = :runId
                          AND a.phase = 'completed'
                        ORDER BY r.round_index DESC,
                                 a.attempt_index DESC
                        LIMIT 1
                    ) AS final_stop_reason
                """)
                .param("runId", runId)
                .query((rs, rowNum) -> new ClosureFacts(
                        rs.getInt("round_count"),
                        rs.getInt("model_attempt_count"),
                        rs.getInt("tool_call_count"),
                        rs.getInt("tool_execution_count"),
                        rs.getInt("tool_observation_count"),
                        rs.getInt("tool_succeeded_count"),
                        rs.getInt("tool_failed_count"),
                        rs.getInt("tool_outcome_unknown_count"),
                        rs.getInt("tool_rejected_count"),
                        rs.getInt("tool_expired_count"),
                        rs.getInt("unmatched_tool_call_count"),
                        rs.getInt("orphan_tool_execution_count"),
                        rs.getInt("non_terminal_execution_count"),
                        rs.getInt("missing_observation_count"),
                        rs.getInt("evidence_count"),
                        rs.getInt("artifact_count"),
                        rs.getInt("has_final_answer") == 1,
                        rs.getString("final_stop_reason")
                ))
                .single();
    }

    public void insert(
            String runId,
            String executionStatus,
            String terminalReason,
            ClosureFacts facts,
            Instant now
    ) {
        int inserted = jdbc.sql("""
                INSERT INTO run_closure_ledger(
                    run_id, execution_status, task_outcome,
                    terminal_reason, final_stop_reason,
                    round_count, model_attempt_count, tool_call_count,
                    tool_execution_count, tool_observation_count,
                    tool_succeeded_count, tool_failed_count,
                    tool_outcome_unknown_count, tool_rejected_count,
                    tool_expired_count, unmatched_tool_call_count,
                    orphan_tool_execution_count,
                    non_terminal_execution_count,
                    missing_observation_count, evidence_count,
                    artifact_count, has_final_answer, recorded_at
                ) VALUES (
                    :runId, :executionStatus, :taskOutcome,
                    :terminalReason, :finalStopReason,
                    :roundCount, :modelAttemptCount, :toolCallCount,
                    :toolExecutionCount, :toolObservationCount,
                    :toolSucceededCount, :toolFailedCount,
                    :toolOutcomeUnknownCount, :toolRejectedCount,
                    :toolExpiredCount, :unmatchedToolCallCount,
                    :orphanToolExecutionCount,
                    :nonTerminalExecutionCount,
                    :missingObservationCount, :evidenceCount,
                    :artifactCount, :hasFinalAnswer, :recordedAt
                )
                """)
                .param("runId", runId)
                .param("executionStatus", executionStatus)
                .param("taskOutcome", TASK_NOT_ASSESSED)
                .param("terminalReason", terminalReason)
                .param("finalStopReason", facts.finalStopReason())
                .param("roundCount", facts.roundCount())
                .param("modelAttemptCount", facts.modelAttemptCount())
                .param("toolCallCount", facts.toolCallCount())
                .param("toolExecutionCount", facts.toolExecutionCount())
                .param("toolObservationCount", facts.toolObservationCount())
                .param("toolSucceededCount", facts.toolSucceededCount())
                .param("toolFailedCount", facts.toolFailedCount())
                .param(
                        "toolOutcomeUnknownCount",
                        facts.toolOutcomeUnknownCount()
                )
                .param("toolRejectedCount", facts.toolRejectedCount())
                .param("toolExpiredCount", facts.toolExpiredCount())
                .param(
                        "unmatchedToolCallCount",
                        facts.unmatchedToolCallCount()
                )
                .param(
                        "orphanToolExecutionCount",
                        facts.orphanToolExecutionCount()
                )
                .param(
                        "nonTerminalExecutionCount",
                        facts.nonTerminalExecutionCount()
                )
                .param(
                        "missingObservationCount",
                        facts.missingObservationCount()
                )
                .param("evidenceCount", facts.evidenceCount())
                .param("artifactCount", facts.artifactCount())
                .param("hasFinalAnswer", facts.hasFinalAnswer() ? 1 : 0)
                .param("recordedAt", now.toString())
                .update();
        if (inserted != 1) {
            throw new IllegalStateException(
                    "Run closure ledger was not persisted"
            );
        }
    }

    public Optional<ClosureLedger> find(String runId) {
        return jdbc.sql("""
                SELECT * FROM run_closure_ledger
                WHERE run_id = :runId
                """)
                .param("runId", runId)
                .query((rs, rowNum) -> new ClosureLedger(
                        rs.getString("run_id"),
                        rs.getString("execution_status"),
                        rs.getString("task_outcome"),
                        rs.getString("terminal_reason"),
                        inspectStoredFacts(rs),
                        Instant.parse(rs.getString("recorded_at"))
                ))
                .optional();
    }

    private ClosureFacts inspectStoredFacts(java.sql.ResultSet rs)
            throws java.sql.SQLException {
        return new ClosureFacts(
                rs.getInt("round_count"),
                rs.getInt("model_attempt_count"),
                rs.getInt("tool_call_count"),
                rs.getInt("tool_execution_count"),
                rs.getInt("tool_observation_count"),
                rs.getInt("tool_succeeded_count"),
                rs.getInt("tool_failed_count"),
                rs.getInt("tool_outcome_unknown_count"),
                rs.getInt("tool_rejected_count"),
                rs.getInt("tool_expired_count"),
                rs.getInt("unmatched_tool_call_count"),
                rs.getInt("orphan_tool_execution_count"),
                rs.getInt("non_terminal_execution_count"),
                rs.getInt("missing_observation_count"),
                rs.getInt("evidence_count"),
                rs.getInt("artifact_count"),
                rs.getInt("has_final_answer") == 1,
                rs.getString("final_stop_reason")
        );
    }

    public record ClosureFacts(
            int roundCount,
            int modelAttemptCount,
            int toolCallCount,
            int toolExecutionCount,
            int toolObservationCount,
            int toolSucceededCount,
            int toolFailedCount,
            int toolOutcomeUnknownCount,
            int toolRejectedCount,
            int toolExpiredCount,
            int unmatchedToolCallCount,
            int orphanToolExecutionCount,
            int nonTerminalExecutionCount,
            int missingObservationCount,
            int evidenceCount,
            int artifactCount,
            boolean hasFinalAnswer,
            String finalStopReason
    ) {
        public int unresolvedProtocolFactCount() {
            return unmatchedToolCallCount
                    + orphanToolExecutionCount
                    + nonTerminalExecutionCount
                    + missingObservationCount;
        }

        public boolean safelyClosed() {
            return hasFinalAnswer && unresolvedProtocolFactCount() == 0;
        }
    }

    public record ClosureLedger(
            String runId,
            String executionStatus,
            String taskOutcome,
            String terminalReason,
            ClosureFacts facts,
            Instant recordedAt
    ) {
    }
}
