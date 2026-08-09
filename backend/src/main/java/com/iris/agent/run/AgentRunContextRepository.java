package com.iris.agent.run;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/** Durable, explicit context boundary for a non-root Agentic Run. */
@Repository
public class AgentRunContextRepository {
    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;

    public AgentRunContextRepository(
            JdbcClient jdbc,
            ObjectMapper objectMapper
    ) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
    }

    public void insert(
            String runId,
            String task,
            String resultContract,
            List<String> allowedTools,
            int nestingDepth,
            String sourceContextRef,
            Instant now
    ) {
        insert(
                runId,
                "isolated",
                task,
                resultContract,
                allowedTools,
                nestingDepth,
                sourceContextRef,
                now
        );
    }

    public void insert(
            String runId,
            String contextMode,
            String task,
            String resultContract,
            List<String> allowedTools,
            int nestingDepth,
            String sourceContextRef,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO agent_run_context(
                    run_id, context_mode, task_text, result_contract,
                    allowed_tool_names_json, nesting_depth,
                    source_context_ref, created_at
                ) VALUES (
                    :runId, :contextMode, :task, :resultContract,
                    :allowedTools, :nestingDepth,
                    :sourceContextRef, :now
                )
                """)
                .param("runId", runId)
                .param("contextMode", contextMode)
                .param("task", task)
                .param("resultContract", resultContract)
                .param("allowedTools", write(allowedTools))
                .param("nestingDepth", nestingDepth)
                .param("sourceContextRef", sourceContextRef,
                        java.sql.Types.VARCHAR)
                .param("now", now.toString())
                .update();
    }

    public Optional<RunContext> find(String runId) {
        return jdbc.sql("""
                SELECT run_id, context_mode, task_text, result_contract,
                       allowed_tool_names_json, nesting_depth,
                       source_context_ref
                FROM agent_run_context
                WHERE run_id = :runId
                """)
                .param("runId", runId)
                .query((rs, rowNum) -> new RunContext(
                        rs.getString("run_id"),
                        rs.getString("context_mode"),
                        rs.getString("task_text"),
                        rs.getString("result_contract"),
                        readList(rs.getString("allowed_tool_names_json")),
                        rs.getInt("nesting_depth"),
                        rs.getString("source_context_ref")
                ))
                .optional();
    }

    private String write(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("Unable to store Run context", exception);
        }
    }

    private List<String> readList(String json) {
        try {
            return List.copyOf(objectMapper.readValue(
                    json,
                    new TypeReference<List<String>>() { }
            ));
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("Stored Run tool surface is invalid", exception);
        }
    }

    public record RunContext(
            String runId,
            String contextMode,
            String task,
            String resultContract,
            List<String> allowedTools,
            int nestingDepth,
            String sourceContextRef
    ) {
        public RunContext {
            allowedTools = List.copyOf(allowedTools);
        }

        public boolean isolated() {
            return contextMode.startsWith("isolated");
        }

        public boolean modelTransform() {
            return "isolated_model".equals(contextMode);
        }
    }
}
