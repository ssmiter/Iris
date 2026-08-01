package com.iris.task;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolRuntimeException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Versioned control-plane memory for long-running user tasks.
 *
 * Task definitions and work-state revisions are immutable. The head is the
 * only mutable projection and always advances with an optimistic precondition.
 */
@Service
public class TaskLedgerService {
    private static final int MAX_CONTEXT_TASKS = 1;
    private static final Pattern EVIDENCE_REF = Pattern.compile(
            "^evidence://(evidence_[a-f0-9]{32})$"
    );
    private static final Pattern ARTIFACT_REF = Pattern.compile(
            "^artifact://(artifact_[a-f0-9]{32})@([1-9][0-9]*)$"
    );

    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;
    private final TransactionTemplate transactions;
    private final Clock clock = Clock.systemUTC();

    public TaskLedgerService(
            JdbcClient jdbc,
            ObjectMapper objectMapper,
            TransactionTemplate transactions
    ) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.transactions = transactions;
    }

    public TaskSnapshot create(
            ToolContext context,
            String objective,
            ArrayNode constraints,
            ArrayNode completionCriteria,
            ArrayNode steps,
            String summary
    ) {
        Scope scope = scope(context.runId());
        String taskId = "task_" + UUID.randomUUID()
                .toString().replace("-", "");
        Instant now = clock.instant();
        transactions.executeWithoutResult(status -> {
            jdbc.sql("""
                    INSERT INTO agent_task_definition (
                      task_id, definition_version, conversation_id, branch_id,
                      objective, constraints_json, completion_criteria_json,
                      source_message_id, source_run_id, created_at
                    ) VALUES (
                      :taskId, 1, :conversationId, :branchId,
                      :objective, :constraints, :criteria,
                      :messageId, :runId, :createdAt
                    )
                    """)
                    .param("taskId", taskId)
                    .param("conversationId", scope.conversationId())
                    .param("branchId", scope.branchId())
                    .param("objective", objective)
                    .param("constraints", write(constraints))
                    .param("criteria", write(completionCriteria))
                    .param("messageId", scope.requestMessageId())
                    .param("runId", context.runId())
                    .param("createdAt", now.toString())
                    .update();
            insertState(
                    taskId,
                    1,
                    "active",
                    steps,
                    objectMapper.createArrayNode(),
                    objectMapper.createArrayNode(),
                    objectMapper.createArrayNode(),
                    summary,
                    context,
                    now
            );
            jdbc.sql("""
                    INSERT INTO agent_task_head (
                      task_id, conversation_id, branch_id,
                      definition_version, state_version, phase, version,
                      created_at, updated_at
                    ) VALUES (
                      :taskId, :conversationId, :branchId,
                      1, 1, 'active', 1, :createdAt, :createdAt
                    )
                    """)
                    .param("taskId", taskId)
                    .param("conversationId", scope.conversationId())
                    .param("branchId", scope.branchId())
                    .param("createdAt", now.toString())
                    .update();
        });
        return require(taskId, context);
    }

    public TaskSnapshot update(
            ToolContext context,
            String taskId,
            int expectedStateVersion,
            String phase,
            ArrayNode steps,
            ArrayNode blockers,
            ArrayNode evidenceRefs,
            ArrayNode artifactRefs,
            String summary
    ) {
        TaskSnapshot before = require(taskId, context);
        if (before.stateVersion() != expectedStateVersion) {
            throw stale(before.stateVersion());
        }
        int nextVersion = expectedStateVersion + 1;
        Instant now = clock.instant();
        transactions.executeWithoutResult(status -> {
            int current = jdbc.sql("""
                    SELECT state_version
                    FROM agent_task_head
                    WHERE task_id = :taskId
                      AND branch_id = :branchId
                    """)
                    .param("taskId", taskId)
                    .param("branchId", before.branchId())
                    .query(Integer.class)
                    .single();
            if (current != expectedStateVersion) {
                throw stale(current);
            }
            insertState(
                    taskId,
                    nextVersion,
                    phase,
                    steps,
                    blockers,
                    evidenceRefs,
                    artifactRefs,
                    summary,
                    context,
                    now
            );
            int updated = jdbc.sql("""
                    UPDATE agent_task_head
                    SET state_version = :nextVersion,
                        phase = :phase,
                        version = version + 1,
                        updated_at = :updatedAt
                    WHERE task_id = :taskId
                      AND branch_id = :branchId
                      AND state_version = :expectedVersion
                    """)
                    .param("nextVersion", nextVersion)
                    .param("phase", phase)
                    .param("updatedAt", now.toString())
                    .param("taskId", taskId)
                    .param("branchId", before.branchId())
                    .param("expectedVersion", expectedStateVersion)
                    .update();
            if (updated != 1) {
                throw stale(expectedStateVersion);
            }
        });
        return require(taskId, context);
    }

    public void requireCompletionReferences(
            ToolContext context,
            ArrayNode evidenceRefs,
            ArrayNode artifactRefs
    ) {
        Scope scope = scope(context.runId());
        for (JsonNode value : evidenceRefs) {
            String reference = value.asText();
            Matcher match = EVIDENCE_REF.matcher(reference);
            if (!match.matches() || !evidenceExists(
                    match.group(1),
                    scope
            )) {
                throw ToolRuntimeException.beforeCommit(
                        "task_evidence_ref_invalid",
                        "任务证据不存在、未确认成功或不属于当前对话分支："
                                + reference
                );
            }
        }
        for (JsonNode value : artifactRefs) {
            String reference = value.asText();
            Matcher match = ARTIFACT_REF.matcher(reference);
            if (!match.matches() || !artifactExists(
                    match.group(1),
                    Integer.parseInt(match.group(2)),
                    scope
            )) {
                throw ToolRuntimeException.beforeCommit(
                        "task_artifact_ref_invalid",
                        "任务 Artifact 不存在或不属于当前对话分支："
                                + reference
                );
            }
        }
    }

    public TaskSnapshot require(String taskId, ToolContext context) {
        Scope scope = scope(context.runId());
        return find(taskId, scope.conversationId(), scope.branchId())
                .orElseThrow(() -> new ToolRuntimeException(
                        "task_state_not_found",
                        "当前对话分支中找不到任务 " + taskId
                ));
    }

    public TaskSnapshot latest(ToolContext context) {
        Scope scope = scope(context.runId());
        String taskId = jdbc.sql("""
                SELECT task_id
                FROM agent_task_head
                WHERE conversation_id = :conversationId
                  AND branch_id = :branchId
                ORDER BY updated_at DESC, task_id DESC
                LIMIT 1
                """)
                .param("conversationId", scope.conversationId())
                .param("branchId", scope.branchId())
                .query(String.class)
                .optional()
                .orElseThrow(() -> new ToolRuntimeException(
                        "task_state_not_found",
                        "当前对话分支还没有任务工作状态"
                ));
        return require(taskId, context);
    }

    public List<TaskSnapshot> activeForContext(
            String conversationId,
            String branchId
    ) {
        List<String> ids = jdbc.sql("""
                SELECT task_id
                FROM agent_task_head
                WHERE conversation_id = :conversationId
                  AND branch_id = :branchId
                  AND phase IN ('active', 'blocked', 'paused')
                ORDER BY updated_at DESC, task_id DESC
                LIMIT :limit
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("limit", MAX_CONTEXT_TASKS)
                .query(String.class)
                .list();
        return ids.stream()
                .map(id -> find(id, conversationId, branchId).orElseThrow())
                .toList();
    }

    /**
     * Returns only an active head whose current state was written by this Run.
     * Older branch tasks must not turn an unrelated short conversation into a
     * readiness loop.
     */
    public Optional<FinalizationGap> finalizationGap(String runId) {
        return jdbc.sql("""
                SELECT head.task_id, head.state_version,
                       state.steps_json, state.blockers_json
                FROM agent_task_head head
                JOIN agent_task_work_state state
                  ON state.task_id = head.task_id
                 AND state.branch_id = head.branch_id
                 AND state.state_version = head.state_version
                JOIN agent_run run
                  ON run.run_id = :runId
                 AND run.conversation_id = head.conversation_id
                 AND run.branch_id = head.branch_id
                WHERE head.phase = 'active'
                  AND state.source_run_id = :runId
                ORDER BY head.updated_at DESC, head.task_id DESC
                LIMIT 1
                """)
                .param("runId", runId)
                .query((rs, row) -> {
                    ArrayNode steps = array(rs.getString("steps_json"));
                    int unfinished = 0;
                    for (JsonNode step : steps) {
                        String status = step.path("status").asText();
                        if (!"completed".equals(status)
                                && !"skipped".equals(status)) {
                            unfinished++;
                        }
                    }
                    return new FinalizationGap(
                            rs.getString("task_id"),
                            rs.getInt("state_version"),
                            unfinished,
                            array(rs.getString("blockers_json")).size()
                    );
                })
                .optional();
    }

    public ObjectNode toJson(TaskSnapshot snapshot) {
        ObjectNode result = objectMapper.createObjectNode();
        result.put("taskId", snapshot.taskId());
        result.put("branchId", snapshot.branchId());
        result.put("definitionVersion", snapshot.definitionVersion());
        result.put("stateVersion", snapshot.stateVersion());
        result.put("phase", snapshot.phase());
        result.put("objective", snapshot.objective());
        result.set("constraints", snapshot.constraints().deepCopy());
        result.set(
                "completionCriteria",
                snapshot.completionCriteria().deepCopy()
        );
        result.set("steps", snapshot.steps().deepCopy());
        result.set("blockers", snapshot.blockers().deepCopy());
        result.set("evidenceRefs", snapshot.evidenceRefs().deepCopy());
        result.set("artifactRefs", snapshot.artifactRefs().deepCopy());
        result.put("summary", snapshot.summary());
        result.put("updatedAt", snapshot.updatedAt().toString());
        return result;
    }

    private Optional<TaskSnapshot> find(
            String taskId,
            String conversationId,
            String branchId
    ) {
        return jdbc.sql("""
                SELECT h.task_id, h.definition_version, h.state_version,
                       h.phase, h.updated_at, d.objective,
                       d.constraints_json, d.completion_criteria_json,
                       s.steps_json, s.blockers_json, s.evidence_refs_json,
                       s.artifact_refs_json, s.summary
                FROM agent_task_head h
                JOIN agent_task_definition d
                  ON d.task_id = h.task_id
                 AND d.definition_version = h.definition_version
                JOIN agent_task_work_state s
                  ON s.task_id = h.task_id
                 AND s.branch_id = h.branch_id
                 AND s.state_version = h.state_version
                WHERE h.task_id = :taskId
                  AND h.conversation_id = :conversationId
                  AND h.branch_id = :branchId
                """)
                .param("taskId", taskId)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .query((rs, row) -> new TaskSnapshot(
                        rs.getString("task_id"),
                        branchId,
                        rs.getInt("definition_version"),
                        rs.getInt("state_version"),
                        rs.getString("phase"),
                        rs.getString("objective"),
                        array(rs.getString("constraints_json")),
                        array(rs.getString("completion_criteria_json")),
                        array(rs.getString("steps_json")),
                        array(rs.getString("blockers_json")),
                        array(rs.getString("evidence_refs_json")),
                        array(rs.getString("artifact_refs_json")),
                        rs.getString("summary"),
                        Instant.parse(rs.getString("updated_at"))
                ))
                .optional();
    }

    private Scope scope(String runId) {
        return jdbc.sql("""
                SELECT r.conversation_id, r.branch_id, t.request_message_id
                FROM agent_run r
                JOIN conversation_turn t ON t.turn_id = r.turn_id
                WHERE r.run_id = :runId
                """)
                .param("runId", runId)
                .query((rs, row) -> new Scope(
                        rs.getString("conversation_id"),
                        rs.getString("branch_id"),
                        rs.getString("request_message_id")
                ))
                .optional()
                .orElseThrow(() -> new ToolRuntimeException(
                        "task_scope_unavailable",
                        "无法确定当前任务所属的对话与分支"
                ));
    }

    private boolean evidenceExists(String evidenceId, Scope scope) {
        return jdbc.sql("""
                SELECT COUNT(*)
                FROM tool_evidence evidence
                JOIN tool_execution execution
                  ON execution.execution_id = evidence.execution_id
                JOIN agent_run run ON run.run_id = execution.run_id
                WHERE evidence.evidence_id = :evidenceId
                  AND execution.conversation_id = :conversationId
                  AND run.branch_id = :branchId
                  AND execution.phase = 'succeeded'
                  AND execution.outcome_kind = 'succeeded'
                """)
                .param("evidenceId", evidenceId)
                .param("conversationId", scope.conversationId())
                .param("branchId", scope.branchId())
                .query(Integer.class)
                .single() == 1;
    }

    private boolean artifactExists(
            String artifactId,
            int version,
            Scope scope
    ) {
        return jdbc.sql("""
                SELECT (
                    SELECT COUNT(*)
                    FROM artifact generated
                    JOIN artifact_version version
                      ON version.artifact_id = generated.artifact_id
                    WHERE generated.artifact_id = :artifactId
                      AND version.artifact_version = :version
                      AND generated.conversation_id = :conversationId
                      AND generated.branch_id = :branchId
                ) + (
                    SELECT COUNT(*)
                    FROM user_artifact uploaded
                    JOIN user_artifact_version version
                      ON version.artifact_id = uploaded.artifact_id
                    WHERE uploaded.artifact_id = :artifactId
                      AND version.artifact_version = :version
                      AND uploaded.conversation_id = :conversationId
                      AND uploaded.branch_id = :branchId
                )
                """)
                .param("artifactId", artifactId)
                .param("version", version)
                .param("conversationId", scope.conversationId())
                .param("branchId", scope.branchId())
                .query(Integer.class)
                .single() == 1;
    }

    private void insertState(
            String taskId,
            int stateVersion,
            String phase,
            ArrayNode steps,
            ArrayNode blockers,
            ArrayNode evidenceRefs,
            ArrayNode artifactRefs,
            String summary,
            ToolContext context,
            Instant createdAt
    ) {
        jdbc.sql("""
                INSERT INTO agent_task_work_state (
                  task_id, branch_id, state_version, phase,
                  steps_json, blockers_json,
                  evidence_refs_json, artifact_refs_json, summary,
                  source_run_id, source_round_id, created_at
                ) VALUES (
                  :taskId, :branchId, :stateVersion, :phase,
                  :steps, :blockers,
                  :evidenceRefs, :artifactRefs, :summary,
                  :runId, :roundId, :createdAt
                )
                """)
                .param("taskId", taskId)
                .param("branchId", scope(context.runId()).branchId())
                .param("stateVersion", stateVersion)
                .param("phase", phase)
                .param("steps", write(steps))
                .param("blockers", write(blockers))
                .param("evidenceRefs", write(evidenceRefs))
                .param("artifactRefs", write(artifactRefs))
                .param("summary", summary)
                .param("runId", context.runId())
                .param("roundId", context.roundId())
                .param("createdAt", createdAt.toString())
                .update();
    }

    private ArrayNode array(String value) {
        try {
            JsonNode parsed = objectMapper.readTree(value);
            if (parsed instanceof ArrayNode array) {
                return array;
            }
            throw new IllegalStateException(
                    "Persisted task state is not an array"
            );
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "Persisted task state contains invalid JSON",
                    exception
            );
        }
    }

    private String write(JsonNode value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalArgumentException(
                    "Task state cannot be serialized",
                    exception
            );
        }
    }

    private ToolRuntimeException stale(int currentVersion) {
        return ToolRuntimeException.beforeCommit(
                "task_state_version_conflict",
                "任务状态已更新到版本 " + currentVersion
                        + "；请重新读取后再提交"
        );
    }

    private record Scope(
            String conversationId,
            String branchId,
            String requestMessageId
    ) {
    }

    public record TaskSnapshot(
            String taskId,
            String branchId,
            int definitionVersion,
            int stateVersion,
            String phase,
            String objective,
            ArrayNode constraints,
            ArrayNode completionCriteria,
            ArrayNode steps,
            ArrayNode blockers,
            ArrayNode evidenceRefs,
            ArrayNode artifactRefs,
            String summary,
            Instant updatedAt
    ) {
    }

    public record FinalizationGap(
            String taskId,
            int stateVersion,
            int unfinishedStepCount,
            int blockerCount
    ) {
    }
}
