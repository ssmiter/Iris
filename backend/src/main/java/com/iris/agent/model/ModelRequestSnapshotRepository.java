package com.iris.agent.model;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.Optional;

/**
 * docs/42 §5.2 的请求 header 快照事实表。一个 attempt 一行，只增不改；
 * 「上一快照」按同一 Run 内 (round_index, attempt_index) 顺序定位。
 */
@Repository
public class ModelRequestSnapshotRepository {
    private final JdbcClient jdbc;

    public ModelRequestSnapshotRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public void insert(
            String attemptId,
            String snapshotHash,
            boolean sameAsPrevious,
            String snapshotJson,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO model_request_snapshot(
                    attempt_id, snapshot_hash, same_as_previous,
                    snapshot_json, created_at
                ) VALUES (
                    :attemptId, :snapshotHash, :sameAsPrevious,
                    :snapshotJson, :now
                )
                """)
                .param("attemptId", attemptId)
                .param("snapshotHash", snapshotHash)
                .param("sameAsPrevious", sameAsPrevious ? 1 : 0)
                .param("snapshotJson", snapshotJson)
                .param("now", now.toString())
                .update();
    }

    /** 同一 Run 内、严格早于当前 attempt 的最近一条快照。 */
    public Optional<PreviousSnapshot> previousInRun(String attemptId) {
        return jdbc.sql("""
                SELECT s.snapshot_hash, s.snapshot_json
                FROM model_request_snapshot s
                JOIN model_attempt prev ON prev.attempt_id = s.attempt_id
                JOIN agent_round prev_round
                  ON prev_round.round_id = prev.round_id
                JOIN model_attempt cur ON cur.attempt_id = :attemptId
                JOIN agent_round cur_round
                  ON cur_round.round_id = cur.round_id
                WHERE prev.run_id = cur.run_id
                  AND (
                      prev_round.round_index < cur_round.round_index
                      OR (
                          prev_round.round_index = cur_round.round_index
                          AND prev.attempt_index < cur.attempt_index
                      )
                  )
                ORDER BY prev_round.round_index DESC, prev.attempt_index DESC
                LIMIT 1
                """)
                .param("attemptId", attemptId)
                .query((rs, rowNum) -> new PreviousSnapshot(
                        rs.getString("snapshot_hash"),
                        rs.getString("snapshot_json")
                ))
                .optional();
    }

    public Optional<String> snapshotJson(String attemptId) {
        return jdbc.sql("""
                SELECT snapshot_json FROM model_request_snapshot
                WHERE attempt_id = :attemptId
                """)
                .param("attemptId", attemptId)
                .query(String.class)
                .optional();
    }

    public record PreviousSnapshot(
            String snapshotHash,
            String snapshotJson
    ) {
    }
}
