package com.iris.agent.run;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/** Bounded handoff result of an isolated Agentic Run. */
@Repository
public class AgentRunResultRepository {
    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;

    public AgentRunResultRepository(JdbcClient jdbc, ObjectMapper objectMapper) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
    }

    public String latestAssistantText(String runId) {
        List<String> blocks = jdbc.sql("""
                WITH latest AS (
                    SELECT attempt.attempt_id
                    FROM model_attempt attempt
                    JOIN agent_round round
                      ON round.round_id = attempt.round_id
                    WHERE round.run_id = :runId
                      AND attempt.phase = 'completed'
                    ORDER BY round.round_index DESC,
                             attempt.attempt_index DESC
                    LIMIT 1
                )
                SELECT block.text_content
                FROM model_content_block block
                JOIN latest ON latest.attempt_id = block.attempt_id
                WHERE block.block_kind = 'text'
                  AND block.text_content IS NOT NULL
                ORDER BY block.block_index
                """)
                .param("runId", runId)
                .query(String.class)
                .list();
        return String.join("", blocks).trim();
    }

    public void save(
            String runId,
            String status,
            String summary,
            String outputRef,
            List<String> evidenceRefs,
            Instant now
    ) {
        ArrayNode evidence = objectMapper.valueToTree(evidenceRefs);
        jdbc.sql("""
                INSERT INTO agent_run_result(
                    run_id, status, summary_text, output_ref,
                    evidence_refs_json, recorded_at
                ) VALUES (
                    :runId, :status, :summary, :outputRef,
                    :evidenceRefs, :now
                )
                ON CONFLICT(run_id) DO NOTHING
                """)
                .param("runId", runId)
                .param("status", status)
                .param("summary", summary)
                .param("outputRef", outputRef, java.sql.Types.VARCHAR)
                .param("evidenceRefs", evidence.toString())
                .param("now", now.toString())
                .update();
    }

    public Optional<RunResult> find(String runId) {
        return jdbc.sql("""
                SELECT run_id, status, summary_text, output_ref, recorded_at
                FROM agent_run_result WHERE run_id = :runId
                """)
                .param("runId", runId)
                .query((rs, rowNum) -> new RunResult(
                        rs.getString("run_id"),
                        rs.getString("status"),
                        rs.getString("summary_text"),
                        rs.getString("output_ref"),
                        Instant.parse(rs.getString("recorded_at"))
                ))
                .optional();
    }

    public record RunResult(
            String runId,
            String status,
            String summary,
            String outputRef,
            Instant recordedAt
    ) { }
}
