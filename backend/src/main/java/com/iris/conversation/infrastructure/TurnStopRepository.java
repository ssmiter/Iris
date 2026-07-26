package com.iris.conversation.infrastructure;

import com.iris.conversation.domain.StopCommands.StopView;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.Optional;

@Repository
public class TurnStopRepository {
    private final JdbcClient jdbc;

    public TurnStopRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public void insert(
            String requestId,
            SupplementRepository.TurnContext turn,
            String reason,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO turn_stop_request(
                    stop_request_id, conversation_id, branch_id, turn_id,
                    root_run_id, reason, phase, version,
                    requested_at, completed_at, updated_at
                ) VALUES (
                    :requestId, :conversationId, :branchId, :turnId,
                    :rootRunId, :reason, 'requested', 1,
                    :now, NULL, :now
                )
                """)
                .param("requestId", requestId)
                .param("conversationId", turn.conversationId())
                .param("branchId", turn.branchId())
                .param("turnId", turn.turnId())
                .param("rootRunId", turn.rootRunId())
                .param("reason", reason)
                .param("now", now.toString())
                .update();
    }

    public Optional<StopView> findByTurn(String turnId) {
        return jdbc.sql("""
                SELECT * FROM turn_stop_request WHERE turn_id = :turnId
                """)
                .param("turnId", turnId)
                .query((rs, rowNum) -> new StopView(
                        rs.getString("stop_request_id"),
                        rs.getString("turn_id"),
                        rs.getString("root_run_id"),
                        rs.getString("reason"),
                        rs.getString("phase"),
                        rs.getLong("version"),
                        Instant.parse(rs.getString("requested_at")),
                        rs.getString("completed_at") == null
                                ? null
                                : Instant.parse(rs.getString("completed_at"))
                ))
                .optional();
    }

    public boolean requested(String turnId) {
        return jdbc.sql("""
                SELECT COUNT(*) FROM turn_stop_request
                WHERE turn_id = :turnId AND phase IN ('requested', 'draining')
                """)
                .param("turnId", turnId)
                .query(Integer.class)
                .single() > 0;
    }

    public boolean markDraining(String turnId, Instant now) {
        return jdbc.sql("""
                UPDATE turn_stop_request
                SET phase = 'draining', version = version + 1,
                    updated_at = :now
                WHERE turn_id = :turnId AND phase = 'requested'
                """)
                .param("turnId", turnId)
                .param("now", now.toString())
                .update() == 1;
    }

    public void complete(String turnId, Instant now) {
        jdbc.sql("""
                UPDATE turn_stop_request
                SET phase = 'completed', version = version + 1,
                    completed_at = :now, updated_at = :now
                WHERE turn_id = :turnId
                  AND phase IN ('requested', 'draining')
                """)
                .param("turnId", turnId)
                .param("now", now.toString())
                .update();
    }
}
