package com.iris.agent.model;

import com.iris.agent.model.ModelContextAssembler.ContextSeed;
import com.iris.agent.model.CapabilityLeasePlanner.LeasePlan;
import com.iris.agent.model.ModelContextWindowPlanner.ContextBudget;
import com.iris.tools.core.ToolRegistry;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * Builds a bounded lease from durable discovery observations.
 */
@Service
public class AgentContextPolicy {
    private static final int RECENT_ACTIVATION_CANDIDATE_LIMIT = 64;
    private static final int MAX_CAPABILITY_SCHEMA_TOKENS = 16_384;
    private static final List<String> RESIDENT_PRIMITIVES = List.of(
            "list_capabilities",
            "read_capability",
            "list_files",
            "search_files",
            "read_file",
            "make_directory",
            "write_file",
            "apply_patch",
            "read_tool_result",
            "query_tool_result"
    );
    private final JdbcClient jdbc;
    private final ToolRegistry tools;
    private final CapabilityLeasePlanner leases;
    private final AgentSystemPrompt systemPrompt;

    public AgentContextPolicy(
            JdbcClient jdbc,
            ToolRegistry tools,
            CapabilityLeasePlanner leases,
            AgentSystemPrompt systemPrompt
    ) {
        this.jdbc = jdbc;
        this.tools = tools;
        this.leases = leases;
        this.systemPrompt = systemPrompt;
    }

    public ContextSeed seedFor(String runId, String currentRoundId) {
        LinkedHashSet<String> candidates = new LinkedHashSet<>();
        addPreviousRunWorkingSet(candidates, runId);
        candidates.addAll(previouslyExposedToolNames(
                runId,
                currentRoundId
        ));
        candidates.addAll(recoveryToolNames(runId, currentRoundId));
        candidates.addAll(previouslyUsedToolNames(runId, currentRoundId));
        candidates.addAll(previouslyDiscoveredToolNames(
                runId,
                currentRoundId
        ));
        for (String path : previouslyInspectedPaths(
                runId,
                currentRoundId
        )) {
            tools.all().stream()
                    .filter(binding ->
                            binding.capabilityPath().equals(path))
                    .findFirst()
                    .ifPresent(binding ->
                            candidates.add(binding.manifest().name()));
        }
        LeasePlan lease = leases.plan(
                RESIDENT_PRIMITIVES,
                new ArrayList<>(candidates),
                MAX_CAPABILITY_SCHEMA_TOKENS
        );
        return new ContextSeed(
                systemPrompt.instruction(),
                lease.toolNames(),
                ContextBudget.defaults(),
                lease.maxSchemaTokens(),
                lease.estimatedSchemaTokens(),
                lease.omittedCandidateCount()
        );
    }

    private void addPreviousRunWorkingSet(
            LinkedHashSet<String> candidates,
            String runId
    ) {
        List<String> used = previouslyUsedToolNames(runId).stream()
                .filter(name -> !RESIDENT_PRIMITIVES.contains(name))
                .toList();
        candidates.addAll(used);
        LinkedHashSet<String> directories = new LinkedHashSet<>();
        for (String name : used) {
            tools.find(name).ifPresent(binding ->
                    directories.add(binding.directoryPath()));
        }
        tools.all().stream()
                .filter(binding ->
                        directories.contains(binding.directoryPath()))
                .sorted(java.util.Comparator.comparing(
                        ToolRegistry.ToolBinding::capabilityPath
                ))
                .forEach(binding ->
                        candidates.add(binding.manifest().name()));
    }

    private List<String> previouslyUsedToolNames(String runId) {
        return jdbc.sql("""
                WITH current_run AS (
                  SELECT conversation_id, branch_id, started_at
                  FROM agent_run
                  WHERE run_id = :runId
                    AND parent_run_id IS NULL
                ),
                previous_run AS (
                  SELECT previous.run_id
                  FROM agent_run previous
                  JOIN current_run current
                    ON current.conversation_id =
                         previous.conversation_id
                   AND current.branch_id = previous.branch_id
                  WHERE previous.parent_run_id IS NULL
                    AND previous.started_at < current.started_at
                  ORDER BY previous.started_at DESC,
                           previous.run_id DESC
                  LIMIT 1
                )
                SELECT call.tool_name
                FROM model_tool_call call
                JOIN model_attempt attempt
                  ON attempt.attempt_id = call.attempt_id
                JOIN previous_run previous
                  ON previous.run_id = attempt.run_id
                GROUP BY call.tool_name
                ORDER BY MIN(attempt.started_at),
                         MIN(call.ordinal)
                LIMIT :limit
                """)
                .param("runId", runId)
                .param("limit", RECENT_ACTIVATION_CANDIDATE_LIMIT)
                .query(String.class)
                .list();
    }

    private List<String> recoveryToolNames(
            String runId,
            String currentRoundId
    ) {
        return jdbc.sql("""
                SELECT DISTINCT 'inspect_workspace_change'
                FROM tool_observation o
                JOIN model_tool_call tc
                  ON tc.tool_call_id = o.tool_call_id
                JOIN model_attempt ma ON ma.attempt_id = tc.attempt_id
                JOIN agent_round source ON source.round_id = ma.round_id
                JOIN agent_round current
                  ON current.round_id = :currentRoundId
                JOIN workspace_checkpoint_set checkpoint
                  ON checkpoint.execution_id = o.execution_id
                WHERE source.run_id = :runId
                  AND current.run_id = :runId
                  AND source.round_index = current.round_index - 1
                  AND o.outcome_kind = 'outcome_unknown'
                """)
                .param("runId", runId)
                .param("currentRoundId", currentRoundId)
                .query(String.class)
                .list();
    }

    private List<String> previouslyExposedToolNames(
            String runId,
            String currentRoundId
    ) {
        return jdbc.sql("""
                SELECT exposure.tool_name
                FROM model_capability_exposure exposure
                JOIN model_attempt attempt
                  ON attempt.context_hash = exposure.context_hash
                JOIN agent_round source
                  ON source.round_id = attempt.round_id
                JOIN agent_round current
                  ON current.round_id = :currentRoundId
                WHERE source.run_id = :runId
                  AND current.run_id = :runId
                  AND source.round_index < current.round_index
                GROUP BY exposure.tool_name
                ORDER BY MIN(source.round_index),
                         MIN(exposure.ordinal)
                LIMIT :limit
                """)
                .param("runId", runId)
                .param("currentRoundId", currentRoundId)
                .param("limit", RECENT_ACTIVATION_CANDIDATE_LIMIT)
                .query(String.class)
                .list();
    }

    private List<String> previouslyUsedToolNames(
            String runId,
            String currentRoundId
    ) {
        return jdbc.sql("""
                SELECT tc.tool_name
                FROM model_tool_call tc
                JOIN model_attempt ma ON ma.attempt_id = tc.attempt_id
                JOIN agent_round source ON source.round_id = ma.round_id
                JOIN agent_round current
                  ON current.round_id = :currentRoundId
                WHERE source.run_id = :runId
                  AND current.run_id = :runId
                  AND source.round_index < current.round_index
                GROUP BY tc.tool_name
                ORDER BY MIN(source.round_index), MIN(tc.ordinal)
                LIMIT :limit
                """)
                .param("runId", runId)
                .param("currentRoundId", currentRoundId)
                .param("limit", RECENT_ACTIVATION_CANDIDATE_LIMIT)
                .query(String.class)
                .list();
    }

    private List<String> previouslyDiscoveredToolNames(
            String runId,
            String currentRoundId
    ) {
        return jdbc.sql("""
                WITH discovered AS (
                  SELECT
                    json_extract(candidate.value, '$.name') AS tool_name,
                    source.round_index AS round_index,
                    CAST(candidate.key AS INTEGER) AS ordinal
                  FROM tool_observation o
                  JOIN model_tool_call tc
                    ON tc.tool_call_id = o.tool_call_id
                  JOIN model_attempt ma ON ma.attempt_id = tc.attempt_id
                  JOIN agent_round source ON source.round_id = ma.round_id
                  JOIN agent_round current
                    ON current.round_id = :currentRoundId
                  JOIN json_each(
                    CASE tc.tool_name
                      WHEN 'search_files' THEN json_extract(
                        o.content_json,
                        '$.output.matches'
                      )
                      WHEN 'list_capabilities' THEN json_extract(
                        o.content_json,
                        '$.output.items'
                      )
                    END
                  ) AS candidate
                  WHERE source.run_id = :runId
                    AND current.run_id = :runId
                    AND source.round_index < current.round_index
                    AND o.outcome_kind = 'succeeded'
                    AND json_extract(
                      candidate.value,
                      '$.availability'
                    ) = 'available'
                    AND (
                      tc.tool_name = 'list_capabilities'
                      OR (
                        tc.tool_name = 'search_files'
                        AND json_extract(
                          tc.arguments_json,
                          '$.namespace'
                        ) = 'capabilities'
                        AND json_extract(
                          candidate.value,
                          '$.kind'
                        ) = 'capability'
                      )
                    )
                )
                SELECT tool_name
                FROM discovered
                GROUP BY tool_name
                ORDER BY MIN(round_index), MIN(ordinal)
                LIMIT :limit
                """)
                .param("runId", runId)
                .param("currentRoundId", currentRoundId)
                .param("limit", RECENT_ACTIVATION_CANDIDATE_LIMIT)
                .query(String.class)
                .list();
    }

    private List<String> previouslyInspectedPaths(
            String runId,
            String currentRoundId
    ) {
        return jdbc.sql("""
                SELECT json_extract(tc.arguments_json, '$.path') AS path
                FROM model_tool_call tc
                JOIN model_attempt ma ON ma.attempt_id = tc.attempt_id
                JOIN agent_round source ON source.round_id = ma.round_id
                JOIN agent_round current
                  ON current.round_id = :currentRoundId
                JOIN tool_observation o ON o.tool_call_id = tc.tool_call_id
                WHERE source.run_id = :runId
                  AND current.run_id = :runId
                  AND source.round_index < current.round_index
                  AND tc.tool_name = 'read_capability'
                  AND o.outcome_kind = 'succeeded'
                GROUP BY path
                ORDER BY MIN(source.round_index), MIN(o.created_at)
                LIMIT :limit
                """)
                .param("runId", runId)
                .param("currentRoundId", currentRoundId)
                .param("limit", RECENT_ACTIVATION_CANDIDATE_LIMIT)
                .query(String.class)
                .list();
    }
}
