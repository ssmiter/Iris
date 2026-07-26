package com.iris.agent.run;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Repository
public class RunRoundRepository {
    private final JdbcClient jdbc;

    public RunRoundRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public Optional<RunRow> findRun(String runId) {
        return jdbc.sql("""
                SELECT run_id, conversation_id, branch_id, turn_id,
                       kind, phase, version
                FROM agent_run
                WHERE run_id = :runId
                """)
                .param("runId", runId)
                .query((rs, rowNum) -> new RunRow(
                        rs.getString("run_id"),
                        rs.getString("conversation_id"),
                        rs.getString("branch_id"),
                        rs.getString("turn_id"),
                        rs.getString("kind"),
                        RunPhase.valueOf(
                                rs.getString("phase").toUpperCase()
                        ),
                        rs.getLong("version")
                ))
                .optional();
    }

    public List<RunRow> resumableRuns() {
        return jdbc.sql("""
                SELECT run_id, conversation_id, branch_id, turn_id,
                       kind, phase, version
                FROM agent_run
                WHERE kind = 'agentic' AND phase = 'running'
                ORDER BY started_at
                """)
                .query((rs, rowNum) -> new RunRow(
                        rs.getString("run_id"),
                        rs.getString("conversation_id"),
                        rs.getString("branch_id"),
                        rs.getString("turn_id"),
                        rs.getString("kind"),
                        RunPhase.valueOf(
                                rs.getString("phase").toUpperCase()
                        ),
                        rs.getLong("version")
                ))
                .list();
    }

    public List<RunRow> stopRequestedRuns() {
        return jdbc.sql("""
                SELECT r.run_id, r.conversation_id, r.branch_id, r.turn_id,
                       r.kind, r.phase, r.version
                FROM agent_run r
                JOIN turn_stop_request s ON s.root_run_id = r.run_id
                WHERE r.kind = 'agentic'
                  AND r.phase IN ('accepted', 'running', 'suspended')
                  AND s.phase IN ('requested', 'draining')
                ORDER BY s.requested_at
                """)
                .query((rs, rowNum) -> new RunRow(
                        rs.getString("run_id"),
                        rs.getString("conversation_id"),
                        rs.getString("branch_id"),
                        rs.getString("turn_id"),
                        rs.getString("kind"),
                        RunPhase.valueOf(
                                rs.getString("phase").toUpperCase()
                        ),
                        rs.getLong("version")
                ))
                .list();
    }

    /**
     * 审批已经形成终态、但进程在 Run 被重新唤醒前退出时的恢复集合。
     * 仍有 waiting/executing 等非终态工具事实的 Run 不能自动继续。
     */
    public List<RunRow> recoverableSuspendedRuns() {
        return jdbc.sql("""
                SELECT DISTINCT r.run_id, r.conversation_id, r.branch_id,
                       r.turn_id, r.kind, r.phase, r.version
                FROM agent_run r
                JOIN agent_round ar ON ar.run_id = r.run_id
                WHERE r.kind = 'agentic'
                  AND r.phase = 'suspended'
                  AND ar.phase = 'awaiting_tools'
                  AND NOT EXISTS (
                      SELECT 1
                      FROM tool_execution e
                      WHERE e.round_id = ar.round_id
                        AND e.phase NOT IN (
                            'succeeded', 'failed', 'outcome_unknown',
                            'rejected', 'expired'
                        )
                  )
                ORDER BY r.started_at
                """)
                .query((rs, rowNum) -> new RunRow(
                        rs.getString("run_id"),
                        rs.getString("conversation_id"),
                        rs.getString("branch_id"),
                        rs.getString("turn_id"),
                        rs.getString("kind"),
                        RunPhase.valueOf(
                                rs.getString("phase").toUpperCase()
                        ),
                        rs.getLong("version")
                ))
                .list();
    }

    public Optional<RoundRow> findRound(String roundId) {
        return jdbc.sql("""
                SELECT round_id, run_id, round_index, phase,
                       tool_call_count, version
                FROM agent_round
                WHERE round_id = :roundId
                """)
                .param("roundId", roundId)
                .query((rs, rowNum) -> new RoundRow(
                        rs.getString("round_id"),
                        rs.getString("run_id"),
                        rs.getInt("round_index"),
                        RoundPhase.valueOf(
                                rs.getString("phase").toUpperCase()
                        ),
                        rs.getInt("tool_call_count"),
                        rs.getLong("version")
                ))
                .optional();
    }

    public Optional<RoundRow> latestRound(String runId) {
        List<RoundRow> rows = jdbc.sql("""
                SELECT round_id, run_id, round_index, phase,
                       tool_call_count, version
                FROM agent_round
                WHERE run_id = :runId
                ORDER BY round_index DESC
                LIMIT 1
                """)
                .param("runId", runId)
                .query((rs, rowNum) -> new RoundRow(
                        rs.getString("round_id"),
                        rs.getString("run_id"),
                        rs.getInt("round_index"),
                        RoundPhase.valueOf(
                                rs.getString("phase").toUpperCase()
                        ),
                        rs.getInt("tool_call_count"),
                        rs.getLong("version")
                ))
                .list();
        return rows.stream().findFirst();
    }

    public Optional<String> latestAttemptFailure(String roundId) {
        return jdbc.sql("""
                SELECT error_category
                FROM model_attempt
                WHERE round_id = :roundId
                  AND phase IN ('failed', 'interrupted')
                  AND error_category IS NOT NULL
                ORDER BY attempt_index DESC
                LIMIT 1
                """)
                .param("roundId", roundId)
                .query(String.class)
                .optional();
    }

    public RunBudget runBudget(String runId) {
        return jdbc.sql("""
                SELECT d.tool_calls_limit, d.time_limit_ms,
                       COALESCE(SUM(ar.tool_call_count), 0) AS tool_calls_used,
                       CAST(
                           (julianday('now') - julianday(r.started_at))
                           * 86400000 AS INTEGER
                       ) AS elapsed_ms
                FROM agent_run r
                JOIN run_definition_snapshot d ON d.run_id = r.run_id
                LEFT JOIN agent_round ar ON ar.run_id = r.run_id
                WHERE r.run_id = :runId
                GROUP BY d.tool_calls_limit, d.time_limit_ms, r.started_at
                """)
                .param("runId", runId)
                .query((rs, rowNum) -> new RunBudget(
                        rs.getInt("tool_calls_used"),
                        rs.getInt("tool_calls_limit"),
                        rs.getLong("elapsed_ms"),
                        rs.getLong("time_limit_ms")
                ))
                .single();
    }

    public void settleTurn(String turnId, String phase, Instant now) {
        int updated = jdbc.sql("""
                UPDATE conversation_turn
                SET phase = :phase, version = version + 1, ended_at = :now
                WHERE turn_id = :turnId
                  AND phase IN ('queued', 'active')
                """)
                .param("phase", phase)
                .param("now", now.toString())
                .param("turnId", turnId)
                .update();
        if (updated != 1) {
            throw new IllegalStateException(
                    "Turn is already terminal or does not exist"
            );
        }
    }

    public int nextRoundIndex(String runId) {
        return jdbc.sql("""
                SELECT COALESCE(MAX(round_index), -1) + 1
                FROM agent_round
                WHERE run_id = :runId
                """)
                .param("runId", runId)
                .query(Integer.class)
                .single();
    }

    public void insertRound(
            String roundId,
            RunRow run,
            int index,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO agent_round(
                    round_id, conversation_id, branch_id, turn_id, run_id,
                    round_index, phase, answer_node_id, tool_call_count,
                    duration_ms, version, created_at, updated_at
                ) VALUES (
                    :roundId, :conversationId, :branchId, :turnId, :runId,
                    :roundIndex, 'accepted', NULL, 0,
                    0, 1, :now, :now
                )
                """)
                .param("roundId", roundId)
                .param("conversationId", run.conversationId())
                .param("branchId", run.branchId())
                .param("turnId", run.turnId())
                .param("runId", run.runId())
                .param("roundIndex", index)
                .param("now", now.toString())
                .update();
    }

    public boolean transitionRun(
            String runId,
            RunPhase from,
            RunPhase to,
            long expectedVersion,
            Instant now
    ) {
        return jdbc.sql("""
                UPDATE agent_run
                SET phase = :toPhase, version = version + 1,
                    ended_at = :endedAt
                WHERE run_id = :runId
                  AND phase = :fromPhase
                  AND version = :expectedVersion
                """)
                .param("toPhase", to.name().toLowerCase())
                .param(
                        "endedAt",
                        to.terminal() ? now.toString() : null,
                        java.sql.Types.VARCHAR
                )
                .param("runId", runId)
                .param("fromPhase", from.name().toLowerCase())
                .param("expectedVersion", expectedVersion)
                .update() == 1;
    }

    public boolean transitionRound(
            String roundId,
            RoundPhase from,
            RoundPhase to,
            long expectedVersion,
            Instant now
    ) {
        return jdbc.sql("""
                UPDATE agent_round
                SET phase = :toPhase, version = version + 1,
                    updated_at = :now
                WHERE round_id = :roundId
                  AND phase = :fromPhase
                  AND version = :expectedVersion
                """)
                .param("toPhase", to.name().toLowerCase())
                .param("now", now.toString())
                .param("roundId", roundId)
                .param("fromPhase", from.name().toLowerCase())
                .param("expectedVersion", expectedVersion)
                .update() == 1;
    }

    public record RunRow(
            String runId,
            String conversationId,
            String branchId,
            String turnId,
            String kind,
            RunPhase phase,
            long version
    ) {
    }

    public record RoundRow(
            String roundId,
            String runId,
            int index,
            RoundPhase phase,
            int toolCallCount,
            long version
    ) {
    }

    public record RunBudget(
            int toolCallsUsed,
            int toolCallsLimit,
            long elapsedMs,
            long timeLimitMs
    ) {
        public boolean exhausted() {
            return toolCallsUsed >= toolCallsLimit
                    || elapsedMs >= timeLimitMs;
        }
    }
}
