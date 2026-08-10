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
    private static final int MAX_TASK_ACTIVITIES = 8;
    private static final int MAX_ACTIVITY_PURPOSE_CHARS = 240;
    private static final int MAX_ACTIVITY_SUMMARY_CHARS = 480;
    private static final int MAX_ACTIVITY_EVIDENCE_REFS = 8;
    private static final Pattern EVIDENCE_REF = Pattern.compile(
            "^evidence://(evidence_[a-f0-9]{32})$"
    );
    private static final Pattern ARTIFACT_REF = Pattern.compile(
            "^artifact://(artifact_[a-f0-9]{32})@([1-9][0-9]*)$"
    );

    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;
    private final TransactionTemplate transactions;
    private final TaskEventEmitter events;
    private final Clock clock = Clock.systemUTC();

    public TaskLedgerService(
            JdbcClient jdbc,
            ObjectMapper objectMapper,
            TransactionTemplate transactions,
            TaskEventEmitter events
    ) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.transactions = transactions;
        this.events = events;
    }

    public TaskSnapshot create(
            ToolContext context,
            String objective,
            ArrayNode constraints,
            ArrayNode completionCriteria,
            ArrayNode steps,
            String summary,
            String currentFocus,
            ArrayNode pendingDecisions,
            ArrayNode nextActions,
            String handoffNote
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
            insertControlState(
                    taskId,
                    1,
                    scope.branchId(),
                    currentFocus,
                    pendingDecisions,
                    nextActions,
                    handoffNote,
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
            insertCheckpoint(
                    taskId,
                    scope.branchId(),
                    1,
                    "accepted",
                    summary,
                    context,
                    now
            );
            linkRun(
                    context.runId(),
                    taskId,
                    scope.branchId(),
                    "creator",
                    1,
                    now
            );
        });
        TaskSnapshot created = require(taskId, context);
        events.updated(created, toJson(created), context.runId());
        return created;
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
            String summary,
            String currentFocus,
            ArrayNode pendingDecisions,
            ArrayNode nextActions,
            String handoffNote,
            String requestedCheckpointKind,
            String resumeSummary
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
            insertControlState(
                    taskId,
                    nextVersion,
                    before.branchId(),
                    currentFocus,
                    pendingDecisions,
                    nextActions,
                    handoffNote,
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
            String checkpointKind = checkpointKind(
                    phase,
                    requestedCheckpointKind
            );
            if (checkpointKind != null) {
                insertCheckpoint(
                        taskId,
                        before.branchId(),
                        nextVersion,
                        checkpointKind,
                        resumeSummary.isBlank() ? summary : resumeSummary,
                        context,
                        now
                );
            }
            linkRun(
                    context.runId(),
                    taskId,
                    before.branchId(),
                    "contributor",
                    nextVersion,
                    now
            );
        });
        TaskSnapshot updated = require(taskId, context);
        events.updated(updated, toJson(updated), context.runId());
        return updated;
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

    public List<TaskSnapshot> list(
            String conversationId,
            String branchId,
            String phase,
            int limit
    ) {
        int safeLimit = Math.max(1, Math.min(limit, 100));
        String normalizedPhase = phase == null ? "" : phase.trim();
        List<String> ids = normalizedPhase.isBlank()
                ? jdbc.sql("""
                        SELECT task_id
                        FROM agent_task_head
                        WHERE conversation_id = :conversationId
                          AND branch_id = :branchId
                        ORDER BY updated_at DESC, task_id DESC
                        LIMIT :limit
                        """)
                        .param("conversationId", conversationId)
                        .param("branchId", branchId)
                        .param("limit", safeLimit)
                        .query(String.class)
                        .list()
                : jdbc.sql("""
                        SELECT task_id
                        FROM agent_task_head
                        WHERE conversation_id = :conversationId
                          AND branch_id = :branchId
                          AND phase = :phase
                        ORDER BY updated_at DESC, task_id DESC
                        LIMIT :limit
                        """)
                        .param("conversationId", conversationId)
                        .param("branchId", branchId)
                        .param("phase", normalizedPhase)
                        .param("limit", safeLimit)
                        .query(String.class)
                        .list();
        return ids.stream()
                .map(id -> find(id, conversationId, branchId).orElseThrow())
                .toList();
    }

    public Optional<TaskSnapshot> findView(
            String taskId,
            String conversationId,
            String branchId
    ) {
        return find(taskId, conversationId, branchId);
    }

    /**
     * Records that a Run received this task as active control-plane context.
     * This is idempotent and does not advance the task head.
     */
    public void linkContextRun(String runId, TaskSnapshot task) {
        linkRelatedRun(
                runId,
                task,
                "context"
        );
    }

    public void linkRelatedRun(
            String runId,
            TaskSnapshot task,
            String relation
    ) {
        linkRelatedRun(runId, task, relation, task.stateVersion());
    }

    public void linkRelatedRun(
            String runId,
            TaskSnapshot task,
            String relation,
            int linkedStateVersion
    ) {
        linkRun(
                runId,
                task.taskId(),
                task.branchId(),
                relation,
                linkedStateVersion,
                clock.instant()
        );
    }

    /**
     * Reprojects tasks related to a Run without mutating their immutable head.
     * Used for user-visible background work pulses at start and terminal.
     */
    public void publishRelatedRunChange(String runId) {
        jdbc.sql("""
                SELECT DISTINCT head.task_id, head.conversation_id,
                                head.branch_id
                FROM agent_run_task_link link
                JOIN agent_task_head head
                  ON head.task_id = link.task_id
                 AND head.branch_id = link.branch_id
                WHERE link.run_id = :runId
                  AND link.relation IN ('delegate', 'pipeline', 'state_agent')
                """)
                .param("runId", runId)
                .query((rs, row) -> new TaskScope(
                        rs.getString("task_id"),
                        rs.getString("conversation_id"),
                        rs.getString("branch_id")
                ))
                .list()
                .forEach(scope -> find(
                                scope.taskId(),
                                scope.conversationId(),
                                scope.branchId()
                        )
                        .ifPresent(task -> events.updated(
                                task,
                                toJson(task),
                                runId
                        )));
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
        result.put("conversationId", snapshot.conversationId());
        result.put("branchId", snapshot.branchId());
        result.put("definitionVersion", snapshot.definitionVersion());
        result.put("stateVersion", snapshot.stateVersion());
        result.put("version", snapshot.version());
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
        result.put("currentFocus", snapshot.currentFocus());
        result.set(
                "pendingDecisions",
                snapshot.pendingDecisions().deepCopy()
        );
        result.set("nextActions", snapshot.nextActions().deepCopy());
        result.put("handoffNote", snapshot.handoffNote());
        if (snapshot.latestCheckpoint() != null) {
            result.set(
                    "latestCheckpoint",
                    checkpointJson(snapshot.latestCheckpoint())
            );
        }
        result.set("activities", activityJson(snapshot));
        result.put("updatedAt", snapshot.updatedAt().toString());
        return result;
    }

    public ObjectNode toHandoffJson(TaskSnapshot snapshot) {
        ObjectNode result = toJson(snapshot);
        ArrayNode relatedRuns = result.putArray("relatedRuns");
        jdbc.sql("""
                SELECT link.run_id, link.relation,
                       link.linked_state_version,
                       run.kind, run.purpose, run.phase,
                       link.updated_at
                FROM agent_run_task_link link
                JOIN agent_run run ON run.run_id = link.run_id
                WHERE link.task_id = :taskId
                  AND link.branch_id = :branchId
                ORDER BY link.updated_at DESC, link.run_id DESC
                LIMIT 12
                """)
                .param("taskId", snapshot.taskId())
                .param("branchId", snapshot.branchId())
                .query((rs, row) -> {
                    ObjectNode run = objectMapper.createObjectNode();
                    run.put("runId", rs.getString("run_id"));
                    run.put("relation", rs.getString("relation"));
                    run.put(
                            "linkedStateVersion",
                            rs.getInt("linked_state_version")
                    );
                    run.put("kind", rs.getString("kind"));
                    run.put("purpose", rs.getString("purpose"));
                    run.put("phase", rs.getString("phase"));
                    run.put("updatedAt", rs.getString("updated_at"));
                    return run;
                })
                .list()
                .forEach(relatedRuns::add);
        return result;
    }

    private ArrayNode activityJson(TaskSnapshot snapshot) {
        ArrayNode activities = objectMapper.createArrayNode();
        jdbc.sql("""
                SELECT link.run_id, link.relation,
                       link.linked_state_version,
                       run.kind, run.purpose, run.phase, run.version,
                       COALESCE(result.recorded_at, run.ended_at,
                                link.updated_at) activity_updated_at,
                       result.status result_status,
                       result.summary_text, result.output_ref,
                       result.evidence_refs_json,
                       failure.code failure_code,
                       failure.user_message failure_message,
                       failure.recovery_action,
                       failure.side_effect_outcome
                FROM agent_run_task_link link
                JOIN agent_run run ON run.run_id = link.run_id
                LEFT JOIN agent_run_result result
                  ON result.run_id = run.run_id
                LEFT JOIN run_failure failure
                  ON failure.failure_id = (
                    SELECT candidate.failure_id
                    FROM run_failure candidate
                    WHERE candidate.run_id = run.run_id
                    ORDER BY candidate.created_at DESC,
                             candidate.failure_id DESC
                    LIMIT 1
                  )
                WHERE link.task_id = :taskId
                  AND link.branch_id = :branchId
                  AND link.relation IN (
                    'delegate', 'pipeline', 'state_agent'
                  )
                ORDER BY activity_updated_at DESC, link.run_id DESC
                LIMIT :limit
                """)
                .param("taskId", snapshot.taskId())
                .param("branchId", snapshot.branchId())
                .param("limit", MAX_TASK_ACTIVITIES)
                .query((rs, row) -> {
                    ObjectNode activity = objectMapper.createObjectNode();
                    activity.put("runId", rs.getString("run_id"));
                    activity.put("relation", rs.getString("relation"));
                    activity.put(
                            "linkedStateVersion",
                            rs.getInt("linked_state_version")
                    );
                    activity.put("kind", rs.getString("kind"));
                    activity.put(
                            "purpose",
                            bounded(
                                    rs.getString("purpose"),
                                    MAX_ACTIVITY_PURPOSE_CHARS
                            )
                    );
                    activity.put("phase", rs.getString("phase"));
                    activity.put("runVersion", rs.getInt("version"));
                    activity.put(
                            "updatedAt",
                            rs.getString("activity_updated_at")
                    );
                    String resultStatus = rs.getString("result_status");
                    if (resultStatus != null) {
                        activity.put("resultStatus", resultStatus);
                    }
                    String summary = rs.getString("summary_text");
                    if (summary != null && !summary.isBlank()) {
                        activity.put(
                                "summary",
                                bounded(summary, MAX_ACTIVITY_SUMMARY_CHARS)
                        );
                    }
                    String outputRef = rs.getString("output_ref");
                    if (outputRef != null && !outputRef.isBlank()) {
                        activity.put("outputRef", outputRef);
                    }
                    String evidenceJson = rs.getString(
                            "evidence_refs_json"
                    );
                    if (evidenceJson != null) {
                        ArrayNode references = activity.putArray(
                                "evidenceRefs"
                        );
                        ArrayNode stored = array(evidenceJson);
                        for (int index = 0;
                                index < Math.min(
                                        stored.size(),
                                        MAX_ACTIVITY_EVIDENCE_REFS
                                ); index++) {
                            references.add(stored.get(index).asText());
                        }
                    }
                    String failureCode = rs.getString("failure_code");
                    if (failureCode != null) {
                        ObjectNode failure = activity.putObject("failure");
                        failure.put("code", failureCode);
                        failure.put(
                                "message",
                                bounded(
                                        rs.getString("failure_message"),
                                        MAX_ACTIVITY_SUMMARY_CHARS
                                )
                        );
                        failure.put(
                                "recoveryAction",
                                bounded(
                                        rs.getString("recovery_action"),
                                        MAX_ACTIVITY_SUMMARY_CHARS
                                )
                        );
                        failure.put(
                                "sideEffectOutcome",
                                rs.getString("side_effect_outcome")
                        );
                    }
                    return activity;
                })
                .list()
                .forEach(activities::add);
        return activities;
    }

    private String bounded(String value, int maxChars) {
        if (value == null) {
            return "";
        }
        String normalized = value.trim();
        return normalized.length() <= maxChars
                ? normalized
                : normalized.substring(0, maxChars) + "…";
    }

    private Optional<TaskSnapshot> find(
            String taskId,
            String conversationId,
            String branchId
    ) {
        return jdbc.sql("""
                SELECT h.task_id, h.conversation_id, h.definition_version,
                       h.state_version, h.version, h.phase, h.updated_at,
                       d.objective,
                       d.constraints_json, d.completion_criteria_json,
                       s.steps_json, s.blockers_json, s.evidence_refs_json,
                       s.artifact_refs_json, s.summary,
                       COALESCE(control.current_focus, '') current_focus,
                       COALESCE(control.pending_decisions_json, '[]')
                         pending_decisions_json,
                       COALESCE(control.next_actions_json, '[]')
                         next_actions_json,
                       COALESCE(control.handoff_note, '') handoff_note,
                       checkpoint.checkpoint_id,
                       checkpoint.state_version checkpoint_state_version,
                       checkpoint.checkpoint_kind,
                       checkpoint.resume_summary,
                       checkpoint.source_run_id checkpoint_source_run_id,
                       checkpoint.created_at checkpoint_created_at
                FROM agent_task_head h
                JOIN agent_task_definition d
                  ON d.task_id = h.task_id
                 AND d.definition_version = h.definition_version
                JOIN agent_task_work_state s
                  ON s.task_id = h.task_id
                 AND s.branch_id = h.branch_id
                 AND s.state_version = h.state_version
                LEFT JOIN agent_task_state_control control
                  ON control.task_id = s.task_id
                 AND control.branch_id = s.branch_id
                 AND control.state_version = s.state_version
                LEFT JOIN agent_task_checkpoint checkpoint
                  ON checkpoint.checkpoint_id = (
                    SELECT candidate.checkpoint_id
                    FROM agent_task_checkpoint candidate
                    WHERE candidate.task_id = h.task_id
                      AND candidate.branch_id = h.branch_id
                    ORDER BY candidate.created_at DESC,
                             candidate.checkpoint_id DESC
                    LIMIT 1
                  )
                WHERE h.task_id = :taskId
                  AND h.conversation_id = :conversationId
                  AND h.branch_id = :branchId
                """)
                .param("taskId", taskId)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .query((rs, row) -> new TaskSnapshot(
                        rs.getString("task_id"),
                        rs.getString("conversation_id"),
                        branchId,
                        rs.getInt("definition_version"),
                        rs.getInt("state_version"),
                        rs.getInt("version"),
                        rs.getString("phase"),
                        rs.getString("objective"),
                        array(rs.getString("constraints_json")),
                        array(rs.getString("completion_criteria_json")),
                        array(rs.getString("steps_json")),
                        array(rs.getString("blockers_json")),
                        array(rs.getString("evidence_refs_json")),
                        array(rs.getString("artifact_refs_json")),
                        rs.getString("summary"),
                        rs.getString("current_focus"),
                        array(rs.getString("pending_decisions_json")),
                        array(rs.getString("next_actions_json")),
                        rs.getString("handoff_note"),
                        rs.getString("checkpoint_id") == null
                                ? null
                                : new TaskCheckpoint(
                                        rs.getString("checkpoint_id"),
                                        rs.getInt("checkpoint_state_version"),
                                        rs.getString("checkpoint_kind"),
                                        rs.getString("resume_summary"),
                                        rs.getString("checkpoint_source_run_id"),
                                        Instant.parse(rs.getString(
                                                "checkpoint_created_at"
                                        ))
                                ),
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

    private void insertControlState(
            String taskId,
            int stateVersion,
            String branchId,
            String currentFocus,
            ArrayNode pendingDecisions,
            ArrayNode nextActions,
            String handoffNote,
            Instant createdAt
    ) {
        jdbc.sql("""
                INSERT INTO agent_task_state_control (
                  task_id, branch_id, state_version, current_focus,
                  pending_decisions_json, next_actions_json,
                  handoff_note, created_at
                ) VALUES (
                  :taskId, :branchId, :stateVersion, :currentFocus,
                  :pendingDecisions, :nextActions,
                  :handoffNote, :createdAt
                )
                """)
                .param("taskId", taskId)
                .param("branchId", branchId)
                .param("stateVersion", stateVersion)
                .param("currentFocus", currentFocus)
                .param("pendingDecisions", write(pendingDecisions))
                .param("nextActions", write(nextActions))
                .param("handoffNote", handoffNote)
                .param("createdAt", createdAt.toString())
                .update();
    }

    private void insertCheckpoint(
            String taskId,
            String branchId,
            int stateVersion,
            String checkpointKind,
            String resumeSummary,
            ToolContext context,
            Instant createdAt
    ) {
        String checkpointId = "taskcp_" + UUID.randomUUID()
                .toString().replace("-", "");
        jdbc.sql("""
                INSERT INTO agent_task_checkpoint (
                  checkpoint_id, task_id, branch_id, state_version,
                  checkpoint_kind, resume_summary,
                  source_run_id, source_round_id, created_at
                ) VALUES (
                  :checkpointId, :taskId, :branchId, :stateVersion,
                  :checkpointKind, :resumeSummary,
                  :runId, :roundId, :createdAt
                )
                """)
                .param("checkpointId", checkpointId)
                .param("taskId", taskId)
                .param("branchId", branchId)
                .param("stateVersion", stateVersion)
                .param("checkpointKind", checkpointKind)
                .param("resumeSummary", resumeSummary)
                .param("runId", context.runId())
                .param("roundId", context.roundId())
                .param("createdAt", createdAt.toString())
                .update();
    }

    private void linkRun(
            String runId,
            String taskId,
            String branchId,
            String relation,
            int stateVersion,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO agent_run_task_link (
                  run_id, task_id, branch_id, relation,
                  linked_state_version, created_at, updated_at
                ) VALUES (
                  :runId, :taskId, :branchId, :relation,
                  :stateVersion, :now, :now
                )
                ON CONFLICT(run_id, task_id, relation) DO UPDATE SET
                  linked_state_version = excluded.linked_state_version,
                  updated_at = excluded.updated_at
                WHERE agent_run_task_link.linked_state_version
                      <> excluded.linked_state_version
                """)
                .param("runId", runId)
                .param("taskId", taskId)
                .param("branchId", branchId)
                .param("relation", relation)
                .param("stateVersion", stateVersion)
                .param("now", now.toString())
                .update();
    }

    private String checkpointKind(
            String phase,
            String requestedCheckpointKind
    ) {
        if ("blocked".equals(phase)
                || "paused".equals(phase)
                || "completed".equals(phase)
                || "cancelled".equals(phase)) {
            return phase;
        }
        if (requestedCheckpointKind == null
                || requestedCheckpointKind.isBlank()
                || "none".equals(requestedCheckpointKind)) {
            return null;
        }
        return requestedCheckpointKind;
    }

    private ObjectNode checkpointJson(TaskCheckpoint checkpoint) {
        ObjectNode result = objectMapper.createObjectNode();
        result.put("checkpointId", checkpoint.checkpointId());
        result.put("stateVersion", checkpoint.stateVersion());
        result.put("kind", checkpoint.kind());
        result.put("resumeSummary", checkpoint.resumeSummary());
        result.put("sourceRunId", checkpoint.sourceRunId());
        result.put("createdAt", checkpoint.createdAt().toString());
        return result;
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

    private record TaskScope(
            String taskId,
            String conversationId,
            String branchId
    ) {
    }

    public record TaskSnapshot(
            String taskId,
            String conversationId,
            String branchId,
            int definitionVersion,
            int stateVersion,
            int version,
            String phase,
            String objective,
            ArrayNode constraints,
            ArrayNode completionCriteria,
            ArrayNode steps,
            ArrayNode blockers,
            ArrayNode evidenceRefs,
            ArrayNode artifactRefs,
            String summary,
            String currentFocus,
            ArrayNode pendingDecisions,
            ArrayNode nextActions,
            String handoffNote,
            TaskCheckpoint latestCheckpoint,
            Instant updatedAt
    ) {
    }

    public record TaskCheckpoint(
            String checkpointId,
            int stateVersion,
            String kind,
            String resumeSummary,
            String sourceRunId,
            Instant createdAt
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
