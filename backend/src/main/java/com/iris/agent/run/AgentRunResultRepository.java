package com.iris.agent.run;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.core.type.TypeReference;
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

    public List<String> evidenceRefsForRun(String runId, int limit) {
        if (limit < 1 || limit > 64) {
            throw new IllegalArgumentException(
                    "Evidence reference limit must be between 1 and 64"
            );
        }
        return jdbc.sql("""
                SELECT evidence.reference
                FROM tool_evidence evidence
                JOIN tool_execution execution
                  ON execution.execution_id = evidence.execution_id
                JOIN model_tool_call call
                  ON call.tool_call_id = execution.tool_call_id
                JOIN model_attempt attempt
                  ON attempt.attempt_id = call.attempt_id
                JOIN agent_round round
                  ON round.round_id = attempt.round_id
                WHERE round.run_id = :runId
                  AND evidence.reference IS NOT NULL
                  AND trim(evidence.reference) <> ''
                GROUP BY evidence.reference
                ORDER BY MIN(evidence.created_at), evidence.reference
                LIMIT :limit
                """)
                .param("runId", runId)
                .param("limit", limit)
                .query(String.class)
                .list();
    }

    public Optional<RunResult> find(String runId) {
        return jdbc.sql("""
                SELECT run_id, status, summary_text, output_ref,
                       evidence_refs_json, recorded_at
                FROM agent_run_result WHERE run_id = :runId
                """)
                .param("runId", runId)
                .query((rs, rowNum) -> new RunResult(
                        rs.getString("run_id"),
                        rs.getString("status"),
                        rs.getString("summary_text"),
                        rs.getString("output_ref"),
                        readEvidenceRefs(rs.getString("evidence_refs_json")),
                        Instant.parse(rs.getString("recorded_at"))
                ))
                .optional();
    }

    private List<String> readEvidenceRefs(String json) {
        try {
            return List.copyOf(objectMapper.readValue(
                    json,
                    new TypeReference<List<String>>() { }
            ));
        } catch (com.fasterxml.jackson.core.JsonProcessingException exception) {
            throw new IllegalStateException(
                    "Stored Agent result evidence is invalid",
                    exception
            );
        }
    }

    public record RunResult(
            String runId,
            String status,
            String summary,
            String outputRef,
            List<String> evidenceRefs,
            Instant recordedAt
    ) {
        public RunResult {
            evidenceRefs = List.copyOf(evidenceRefs);
        }
    }
}
