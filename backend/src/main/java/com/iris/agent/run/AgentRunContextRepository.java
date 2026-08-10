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

    public List<ActiveRun> activeForBranch(
            String conversationId,
            String branchId,
            String excludingRunId,
            int limit
    ) {
        if (limit < 1 || limit > 32) {
            throw new IllegalArgumentException(
                    "Active Agent Run limit must be between 1 and 32"
            );
        }
        return jdbc.sql("""
                SELECT run.run_id, run.parent_run_id, run.phase,
                       context.context_mode, context.task_text,
                       run.started_at
                FROM agent_run run
                JOIN agent_run_context context
                  ON context.run_id = run.run_id
                WHERE run.conversation_id = :conversationId
                  AND run.branch_id = :branchId
                  AND run.run_id <> :excludingRunId
                  AND run.phase IN ('running', 'suspended')
                  AND context.context_mode <> 'isolated_model'
                ORDER BY run.started_at, run.run_id
                LIMIT :limit
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("excludingRunId", excludingRunId)
                .param("limit", limit)
                .query((rs, rowNum) -> new ActiveRun(
                        rs.getString("run_id"),
                        rs.getString("parent_run_id"),
                        rs.getString("phase"),
                        rs.getString("context_mode"),
                        rs.getString("task_text"),
                        Instant.parse(rs.getString("started_at"))
                ))
                .list();
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

        public boolean externalWritesAllowed() {
            return "isolated_workspace".equals(contextMode);
        }
    }

    public record ActiveRun(
            String runId,
            String parentRunId,
            String phase,
            String contextMode,
            String task,
            Instant startedAt
    ) { }
}
