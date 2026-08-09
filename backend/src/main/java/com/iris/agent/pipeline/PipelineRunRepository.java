package com.iris.agent.pipeline;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.agent.run.RunPhase;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/** Durable facts for serial Pipeline scheduling. */
@Repository
public class PipelineRunRepository {
    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;

    public PipelineRunRepository(JdbcClient jdbc, ObjectMapper objectMapper) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
    }

    public void insertChildRun(
            String runId,
            String parentRunId,
            String rootRunId,
            String conversationId,
            String branchId,
            String turnId,
            PipelineDefinitionRegistry.Binding binding,
            JsonNode input,
            String inputHash,
            String triggerKind,
            String triggerRef,
            String requestedBy,
            Instant now
    ) {
        PipelineDefinition definition = binding.definition();
        jdbc.sql("""
                INSERT INTO agent_run(
                    run_id, conversation_id, branch_id, turn_id,
                    parent_run_id, root_run_id, kind, purpose,
                    phase, version, started_at, ended_at
                ) VALUES (
                    :runId, :conversationId, :branchId, :turnId,
                    :parentRunId, :rootRunId, 'pipeline', :purpose,
                    'running', 1, :now, NULL
                )
                """)
                .param("runId", runId)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("turnId", turnId)
                .param("parentRunId", parentRunId)
                .param("rootRunId", rootRunId)
                .param("purpose", definition.description())
                .param("now", now.toString())
                .update();
        jdbc.sql("""
                INSERT INTO run_definition_snapshot(
                    run_id, definition_id, definition_version,
                    snapshot_hash, normalized_input_hash,
                    dependency_snapshot_ref, tool_calls_limit,
                    time_limit_ms
                ) VALUES (
                    :runId, :definitionId, :definitionVersion,
                    :snapshotHash, :inputHash,
                    :dependencyRef, 0, :timeLimitMs
                )
                """)
                .param("runId", runId)
                .param("definitionId", definition.id())
                .param("definitionVersion", definition.version())
                .param("snapshotHash", binding.snapshotHash())
                .param("inputHash", inputHash)
                .param("dependencyRef", "pipeline-definition:"
                        + definition.id() + "@" + definition.version())
                .param("timeLimitMs", definition.timeLimitMs())
                .update();
        jdbc.sql("""
                INSERT INTO run_invocation(
                    run_id, parent_run_id, invoking_step_run_id,
                    trigger_kind, trigger_ref, requested_by, created_at
                ) VALUES (
                    :runId, :parentRunId, NULL,
                    :triggerKind, :triggerRef, :requestedBy, :now
                )
                """)
                .param("runId", runId)
                .param("parentRunId", parentRunId)
                .param("triggerKind", triggerKind)
                .param("triggerRef", triggerRef, java.sql.Types.VARCHAR)
                .param("requestedBy", requestedBy)
                .param("now", now.toString())
                .update();
        jdbc.sql("""
                INSERT INTO pipeline_run_input(
                    run_id, input_json, input_hash,
                    trigger_kind, trigger_ref, delivery_policy, created_at
                ) VALUES (
                    :runId, :input, :inputHash,
                    :triggerKind, :triggerRef, :deliveryPolicy, :now
                )
                """)
                .param("runId", runId)
                .param("input", write(input))
                .param("inputHash", inputHash)
                .param("triggerKind", triggerKind)
                .param("triggerRef", triggerRef, java.sql.Types.VARCHAR)
                .param("deliveryPolicy", definition.deliveryPolicy().name())
                .param("now", now.toString())
                .update();
        for (int index = 0; index < definition.steps().size(); index++) {
            PipelineDefinition.Step step = definition.steps().get(index);
            jdbc.sql("""
                    INSERT INTO pipeline_step_run(
                        step_run_id, pipeline_run_id, step_id, step_index,
                        step_kind, phase, child_run_id, input_json,
                        output_json, failure_code, version,
                        started_at, ended_at, created_at
                    ) VALUES (
                        :stepRunId, :runId, :stepId, :stepIndex,
                        :stepKind, 'accepted', NULL, :input,
                        NULL, NULL, 1, NULL, NULL, :now
                    )
                    """)
                    .param("stepRunId", runId + ":" + step.stepId())
                    .param("runId", runId)
                    .param("stepId", step.stepId())
                    .param("stepIndex", index)
                    .param("stepKind", step.kind())
                    .param("input", write(input))
                    .param("now", now.toString())
                    .update();
        }
    }

    public Optional<PipelineRun> find(String runId) {
        return jdbc.sql("""
                SELECT run.run_id, run.parent_run_id, run.root_run_id,
                       run.conversation_id, run.branch_id, run.turn_id,
                       run.phase, run.version, snapshot.definition_id,
                       snapshot.definition_version,
                       snapshot.snapshot_hash, input.input_json,
                       input.delivery_policy
                FROM agent_run run
                JOIN run_definition_snapshot snapshot
                  ON snapshot.run_id = run.run_id
                JOIN pipeline_run_input input ON input.run_id = run.run_id
                WHERE run.run_id = :runId AND run.kind = 'pipeline'
                """)
                .param("runId", runId)
                .query((rs, rowNum) -> new PipelineRun(
                        rs.getString("run_id"),
                        rs.getString("parent_run_id"),
                        rs.getString("root_run_id"),
                        rs.getString("conversation_id"),
                        rs.getString("branch_id"),
                        rs.getString("turn_id"),
                        RunPhase.valueOf(rs.getString("phase").toUpperCase()),
                        rs.getLong("version"),
                        rs.getString("definition_id"),
                        rs.getString("definition_version"),
                        rs.getString("snapshot_hash"),
                        read(rs.getString("input_json")),
                        PipelineDefinition.DeliveryPolicy.valueOf(
                                rs.getString("delivery_policy")
                        )
                ))
                .optional();
    }

    public Optional<PipelineRun> findByInvocation(
            String parentRunId,
            String triggerKind,
            String triggerRef,
            String definitionId
    ) {
        if (triggerRef == null || triggerRef.isBlank()) {
            return Optional.empty();
        }
        return jdbc.sql("""
                SELECT invocation.run_id
                FROM run_invocation invocation
                JOIN run_definition_snapshot snapshot
                  ON snapshot.run_id = invocation.run_id
                WHERE invocation.parent_run_id = :parentRunId
                  AND invocation.trigger_kind = :triggerKind
                  AND invocation.trigger_ref = :triggerRef
                  AND snapshot.definition_id = :definitionId
                """)
                .param("parentRunId", parentRunId)
                .param("triggerKind", triggerKind)
                .param("triggerRef", triggerRef)
                .param("definitionId", definitionId)
                .query(String.class)
                .optional()
                .flatMap(this::find);
    }

    public List<String> resumableRunIds() {
        return jdbc.sql("""
                SELECT run_id FROM agent_run
                WHERE kind = 'pipeline' AND phase = 'running'
                ORDER BY started_at
                """)
                .query(String.class)
                .list();
    }

    public Optional<StepRun> nextOpenStep(String pipelineRunId) {
        return jdbc.sql("""
                SELECT * FROM pipeline_step_run
                WHERE pipeline_run_id = :runId
                  AND phase NOT IN ('succeeded', 'skipped')
                ORDER BY step_index
                LIMIT 1
                """)
                .param("runId", pipelineRunId)
                .query(this::mapStep)
                .optional();
    }

    public List<StepRun> steps(String pipelineRunId) {
        return jdbc.sql("""
                SELECT * FROM pipeline_step_run
                WHERE pipeline_run_id = :runId
                ORDER BY step_index
                """)
                .param("runId", pipelineRunId)
                .query(this::mapStep)
                .list();
    }

    public List<String> waitingPipelineParents(String childRunId) {
        return jdbc.sql("""
                SELECT pipeline_run_id FROM pipeline_step_run
                WHERE child_run_id = :childRunId
                  AND phase = 'waiting_child'
                """)
                .param("childRunId", childRunId)
                .query(String.class)
                .list();
    }

    public boolean markWaitingChild(
            String stepRunId,
            long expectedVersion,
            String childRunId,
            Instant now
    ) {
        return jdbc.sql("""
                UPDATE pipeline_step_run
                SET phase = 'waiting_child', child_run_id = :childRunId,
                    version = version + 1, started_at = :now
                WHERE step_run_id = :stepRunId
                  AND phase = 'accepted' AND version = :expectedVersion
                """)
                .param("childRunId", childRunId)
                .param("now", now.toString())
                .param("stepRunId", stepRunId)
                .param("expectedVersion", expectedVersion)
                .update() == 1;
    }

    public boolean completeStep(
            String stepRunId,
            long expectedVersion,
            JsonNode output,
            Instant now
    ) {
        return jdbc.sql("""
                UPDATE pipeline_step_run
                SET phase = 'succeeded', output_json = :output,
                    version = version + 1, ended_at = :now
                WHERE step_run_id = :stepRunId
                  AND phase = 'waiting_child'
                  AND version = :expectedVersion
                """)
                .param("output", write(output))
                .param("now", now.toString())
                .param("stepRunId", stepRunId)
                .param("expectedVersion", expectedVersion)
                .update() == 1;
    }

    public boolean completeImmediateStep(
            String stepRunId,
            long expectedVersion,
            JsonNode output,
            Instant now
    ) {
        return jdbc.sql("""
                UPDATE pipeline_step_run
                SET phase = 'succeeded', output_json = :output,
                    version = version + 1,
                    started_at = COALESCE(started_at, :now), ended_at = :now
                WHERE step_run_id = :stepRunId
                  AND phase = 'accepted'
                  AND version = :expectedVersion
                """)
                .param("output", write(output))
                .param("now", now.toString())
                .param("stepRunId", stepRunId)
                .param("expectedVersion", expectedVersion)
                .update() == 1;
    }

    public boolean failStep(
            String stepRunId,
            long expectedVersion,
            String failureCode,
            Instant now
    ) {
        return jdbc.sql("""
                UPDATE pipeline_step_run
                SET phase = 'failed', failure_code = :failureCode,
                    version = version + 1, ended_at = :now
                WHERE step_run_id = :stepRunId
                  AND phase NOT IN ('succeeded', 'failed', 'skipped')
                  AND version = :expectedVersion
                """)
                .param("failureCode", failureCode)
                .param("now", now.toString())
                .param("stepRunId", stepRunId)
                .param("expectedVersion", expectedVersion)
                .update() == 1;
    }

    private StepRun mapStep(java.sql.ResultSet rs, int rowNum)
            throws java.sql.SQLException {
        return new StepRun(
                rs.getString("step_run_id"),
                rs.getString("pipeline_run_id"),
                rs.getString("step_id"),
                rs.getInt("step_index"),
                rs.getString("step_kind"),
                rs.getString("phase"),
                rs.getString("child_run_id"),
                read(rs.getString("input_json")),
                rs.getString("output_json") == null
                        ? null : read(rs.getString("output_json")),
                rs.getString("failure_code"),
                rs.getLong("version")
        );
    }

    private String write(JsonNode value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("Unable to store Pipeline JSON", exception);
        }
    }

    private JsonNode read(String value) {
        try {
            return objectMapper.readTree(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("Stored Pipeline JSON is invalid", exception);
        }
    }

    public record PipelineRun(
            String runId,
            String parentRunId,
            String rootRunId,
            String conversationId,
            String branchId,
            String turnId,
            RunPhase phase,
            long version,
            String definitionId,
            String definitionVersion,
            String snapshotHash,
            JsonNode input,
            PipelineDefinition.DeliveryPolicy deliveryPolicy
    ) { }

    public record StepRun(
            String stepRunId,
            String pipelineRunId,
            String stepId,
            int stepIndex,
            String kind,
            String phase,
            String childRunId,
            JsonNode input,
            JsonNode output,
            String failureCode,
            long version
    ) { }
}
