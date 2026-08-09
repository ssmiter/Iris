package com.iris.agent.run;

import com.iris.agent.pipeline.PipelineDefinition.ChildAgentStep;
import com.iris.agent.pipeline.PipelineDefinition.ModelTransformStep;
import com.iris.agent.pipeline.PipelineRunRepository.PipelineRun;
import com.iris.tools.core.ResidentToolSurface;
import com.iris.conversation.application.RunEventEmitter;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.UUID;

/** Creates the durable Agentic child; execution remains in AgenticRunCoordinator. */
@Service
public class ChildAgentRunService {
    private static final int MAX_NESTING_DEPTH = 1;

    private final JdbcClient jdbc;
    private final AgentRunContextRepository contexts;
    private final TransactionTemplate transactions;
    private final RunEventEmitter events;
    private final Clock clock = Clock.systemUTC();

    public ChildAgentRunService(
            JdbcClient jdbc,
            AgentRunContextRepository contexts,
            TransactionTemplate transactions,
            RunEventEmitter events
    ) {
        this.jdbc = jdbc;
        this.contexts = contexts;
        this.transactions = transactions;
        this.events = events;
    }

    public String create(
            PipelineRun pipeline,
            String invokingStepRunId,
            ChildAgentStep step,
            String task
    ) {
        return createInternal(
                pipeline,
                invokingStepRunId,
                step,
                task,
                "isolated",
                false
        );
    }

    private String createInternal(
            PipelineRun pipeline,
            String invokingStepRunId,
            ChildAgentStep step,
            String task,
            String contextMode,
            boolean allowEmptyToolSurface
    ) {
        String normalizedTask = task == null ? "" : task.trim();
        if (normalizedTask.isBlank() || normalizedTask.length() > 50_000) {
            throw new IllegalArgumentException(
                    "Child Agent task must contain 1 to 50000 characters"
            );
        }
        int parentDepth = parentDepth(pipeline.parentRunId());
        int childDepth = parentDepth + 1;
        if (childDepth > MAX_NESTING_DEPTH) {
            throw new IllegalStateException(
                    "Child Agent nesting depth exceeded"
            );
        }
        List<String> allowedTools = allowedTools(
                step.allowedTools(),
                allowEmptyToolSurface
        );
        String runId = id("run");
        Instant now = clock.instant();
        transactions.executeWithoutResult(status -> {
            jdbc.sql("""
                    INSERT INTO agent_run(
                        run_id, conversation_id, branch_id, turn_id,
                        parent_run_id, root_run_id, kind, purpose,
                        phase, version, started_at, ended_at
                    ) VALUES (
                        :runId, :conversationId, :branchId, :turnId,
                        :parentRunId, :rootRunId, 'agentic', :purpose,
                        'running', 1, :now, NULL
                    )
                    """)
                    .param("runId", runId)
                    .param("conversationId", pipeline.conversationId())
                    .param("branchId", pipeline.branchId())
                    .param("turnId", pipeline.turnId())
                    .param("parentRunId", pipeline.runId())
                    .param("rootRunId", pipeline.rootRunId())
                    .param("purpose", normalizedTask)
                    .param("now", now.toString())
                    .update();
            String definitionHash = hash(
                    "iris.agent.child@1\n"
                            + step.resultContract() + "\n"
                            + String.join("\n", allowedTools)
            );
            jdbc.sql("""
                    INSERT INTO run_definition_snapshot(
                        run_id, definition_id, definition_version,
                        snapshot_hash, normalized_input_hash,
                        dependency_snapshot_ref, tool_calls_limit,
                        time_limit_ms
                    ) VALUES (
                        :runId, 'iris.agent.child', '1',
                        :snapshotHash, :inputHash,
                        :sourceRef, :toolLimit, :timeLimit
                    )
                    """)
                    .param("runId", runId)
                    .param("snapshotHash", definitionHash)
                    .param("inputHash", hash(normalizedTask))
                    .param("sourceRef", "run:" + pipeline.parentRunId())
                    .param("toolLimit", step.toolCallsLimit())
                    .param("timeLimit", step.timeLimitMs())
                    .update();
            jdbc.sql("""
                    INSERT INTO run_invocation(
                        run_id, parent_run_id, invoking_step_run_id,
                        trigger_kind, trigger_ref, requested_by, created_at
                    ) VALUES (
                        :runId, :parentRunId, :stepRunId,
                        'pipeline_step', :stepRunId, 'pipeline', :now
                    )
                    """)
                    .param("runId", runId)
                    .param("parentRunId", pipeline.runId())
                    .param("stepRunId", invokingStepRunId)
                    .param("now", now.toString())
                    .update();
            contexts.insert(
                    runId,
                    contextMode,
                    normalizedTask,
                    step.resultContract(),
                    allowedTools,
                    childDepth,
                    "run:" + pipeline.parentRunId(),
                    now
            );
        });
        events.runStarted(runId);
        return runId;
    }

    public String createModelTransform(
            PipelineRun pipeline,
            String invokingStepRunId,
            ModelTransformStep step,
            String source
    ) {
        if (source.isBlank() || source.length() > 40_000) {
            throw new IllegalArgumentException(
                    "Model transform source must contain 1 to 40000 characters"
            );
        }
        String task = step.instruction()
                + "\n\n【待处理原文】\n" + source;
        return createInternal(
                pipeline,
                invokingStepRunId,
                new ChildAgentStep(
                        step.stepId(),
                        step.sourceInputPointer(),
                        step.resultContract(),
                        List.of(),
                        1,
                        step.timeLimitMs()
                ),
                task,
                "isolated_model",
                true
        );
    }

    private int parentDepth(String parentRunId) {
        if (parentRunId == null) {
            return 0;
        }
        return contexts.find(parentRunId)
                .map(AgentRunContextRepository.RunContext::nestingDepth)
                .orElse(0);
    }

    private List<String> allowedTools(
            List<String> requested,
            boolean allowEmpty
    ) {
        if (allowEmpty && (requested == null || requested.isEmpty())) {
            return List.of();
        }
        LinkedHashSet<String> allowed = new LinkedHashSet<>(
                requested == null || requested.isEmpty()
                        ? ResidentToolSurface.childOrderedNames()
                        : requested
        );
        allowed.retainAll(ResidentToolSurface.childOrderedNames());
        if (allowed.isEmpty()) {
            throw new IllegalArgumentException(
                    "Child Agent tool surface is empty"
            );
        }
        return ResidentToolSurface.childOrderedNames().stream()
                .filter(allowed::contains)
                .toList();
    }

    private String hash(String value) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(
                            value.getBytes(StandardCharsets.UTF_8)
                    )
            );
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
    }

    private String id(String prefix) {
        return prefix + "_" + UUID.randomUUID().toString().replace("-", "");
    }
}
