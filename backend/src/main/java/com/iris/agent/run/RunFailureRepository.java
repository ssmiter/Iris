package com.iris.agent.run;

import com.iris.conversation.domain.ConversationViews.FailureView;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.Types;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

@Repository
public class RunFailureRepository {
    private final JdbcClient jdbc;

    public RunFailureRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public void insert(
            String runId,
            FailureView failure,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO run_failure(
                    failure_id, run_id, code, category, user_message,
                    trace_id, source, recovery_action,
                    side_effect_outcome, details_ref, created_at
                ) VALUES (
                    :failureId, :runId, :code, :category, :userMessage,
                    :traceId, :source, :recoveryAction,
                    :sideEffectOutcome, :detailsRef, :now
                )
                """)
                .param("failureId", id("failure"))
                .param("runId", runId)
                .param("code", failure.code())
                .param("category", failure.category())
                .param("userMessage", failure.userMessage())
                .param("traceId", failure.traceId())
                .param("source", failure.source())
                .param("recoveryAction", failure.recoveryAction())
                .param(
                        "sideEffectOutcome",
                        failure.sideEffectOutcome()
                )
                .param("detailsRef", failure.detailsRef(), Types.VARCHAR)
                .param("now", now.toString())
                .update();
    }

    public Optional<FailureView> find(String runId) {
        return jdbc.sql("""
                SELECT code, category, user_message, trace_id, source,
                       recovery_action, side_effect_outcome, details_ref
                FROM run_failure
                WHERE run_id = :runId
                """)
                .param("runId", runId)
                .query((rs, rowNum) -> new FailureView(
                        rs.getString("code"),
                        rs.getString("category"),
                        rs.getString("user_message"),
                        rs.getString("trace_id"),
                        rs.getString("source"),
                        rs.getString("recovery_action"),
                        rs.getString("side_effect_outcome"),
                        rs.getString("details_ref")
                ))
                .optional();
    }

    private String id(String prefix) {
        return prefix + "_" + UUID.randomUUID().toString().replace("-", "");
    }
}
