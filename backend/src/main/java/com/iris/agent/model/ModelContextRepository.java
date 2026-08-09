package com.iris.agent.model;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.artifact.ArtifactService;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public class ModelContextRepository {
    private static final String CONTINUATION_INSTRUCTION = """
            上一段回复因单次输出上限而中止。请从中止处继续完成当前任务，不要复述已经完成的内容；可以继续使用必要的工具，完成后正常收尾。
            """.strip();

    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;
    private final ArtifactService artifacts;

    public ModelContextRepository(
            JdbcClient jdbc,
            ObjectMapper objectMapper,
            ArtifactService artifacts
    ) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.artifacts = artifacts;
    }

    public List<ModelInputItem> branchFactsBeforeRound(
            String conversationId,
            String branchId,
            String roundId
    ) {
        List<ModelInputItem> facts = jdbc.sql("""
                WITH RECURSIVE target AS (
                    SELECT ar.created_at AS target_time,
                           ar.run_id AS target_run_id,
                           ar.round_index AS target_round_index,
                           e.sequence AS target_sequence
                    FROM agent_round ar
                    JOIN conversation_event e
                      ON e.turn_id = ar.turn_id
                     AND e.event_type = 'turn.accepted'
                    WHERE ar.round_id = :roundId
                ),
                branch_path(branch_id, cutoff_sequence) AS (
                    SELECT :branchId, NULL
                    UNION ALL
                    SELECT branch.parent_branch_id,
                           fork.source_event_sequence
                    FROM branch_path path
                    JOIN conversation_branch branch
                      ON branch.branch_id = path.branch_id
                    JOIN branch_fork fork
                      ON fork.branch_id = path.branch_id
                    WHERE branch.parent_branch_id IS NOT NULL
                ),
                context_head AS (
                    SELECT frame.frame_id, frame.frame_kind,
                           frame.waterline_sequence
                    FROM target t
                    LEFT JOIN run_definition_snapshot snapshot
                      ON snapshot.run_id = t.target_run_id
                    JOIN branch_context_head head
                      ON head.branch_id = :branchId
                    JOIN context_frame frame
                      ON frame.frame_id = CASE
                           WHEN snapshot.dependency_snapshot_ref
                                LIKE 'context-frame:%'
                           THEN substr(
                                snapshot.dependency_snapshot_ref,
                                length('context-frame:') + 1
                           )
                           ELSE head.frame_id
                         END
                ),
                frame_chain(
                    frame_id, parent_frame_id, frame_kind,
                    waterline_sequence, depth
                ) AS (
                    SELECT frame.frame_id, frame.parent_frame_id,
                           frame.frame_kind, frame.waterline_sequence, 0
                    FROM context_head head
                    JOIN context_frame frame
                      ON frame.frame_id = head.frame_id

                    UNION ALL

                    SELECT parent.frame_id, parent.parent_frame_id,
                           parent.frame_kind, parent.waterline_sequence,
                           child.depth + 1
                    FROM frame_chain child
                    JOIN context_frame parent
                      ON parent.frame_id = child.parent_frame_id
                ),
                summary_candidates AS (
                    SELECT chain.depth, boundary.boundary_id,
                           summary.summary_text,
                           turn.started_at AS boundary_time,
                           CASE
                             WHEN json_extract(
                                      source.payload_json,
                                      '$.summaryMode'
                                  ) = 'incremental'
                             THEN 'incremental'
                             ELSE 'cumulative'
                           END AS summary_mode
                    FROM frame_chain chain
                    JOIN compact_boundary boundary
                      ON boundary.frame_id = chain.frame_id
                    JOIN compact_summary summary
                      ON summary.boundary_id = boundary.boundary_id
                    JOIN conversation_turn turn
                      ON turn.turn_id = boundary.before_turn_id
                    LEFT JOIN compaction_run run
                      ON run.compact_boundary_id = boundary.boundary_id
                     AND run.phase = 'completed'
                    LEFT JOIN compaction_source_snapshot source
                      ON source.run_id = run.run_id
                    JOIN target target
                    WHERE chain.frame_kind = 'compact'
                      AND chain.waterline_sequence <= target.target_sequence
                ),
                summary_scope AS (
                    SELECT MIN(depth) AS legacy_base_depth
                    FROM summary_candidates
                    WHERE summary_mode = 'cumulative'
                ),
                summaries AS (
                    SELECT candidate.*
                    FROM summary_candidates candidate
                    CROSS JOIN summary_scope scope
                    WHERE (
                        scope.legacy_base_depth IS NULL
                        AND candidate.summary_mode = 'incremental'
                    ) OR (
                        scope.legacy_base_depth IS NOT NULL
                        AND (
                            candidate.depth = scope.legacy_base_depth
                            OR (
                                candidate.summary_mode = 'incremental'
                                AND candidate.depth < scope.legacy_base_depth
                            )
                        )
                    )
                ),
                facts AS (
                    SELECT summary.boundary_time AS fact_time,
                           -100 AS fact_order,
                           summary.boundary_id AS fact_id,
                           'history_summary' AS fact_kind,
                           NULL AS source_attempt_id,
                           NULL AS source_provider_profile,
                           NULL AS source_model_id,
                           NULL AS provider_state_key,
                           summary.summary_text AS text_content,
                           NULL AS tool_call_id,
                           NULL AS provider_call_id,
                           NULL AS tool_name,
                           NULL AS json_content,
                           NULL AS outcome_kind,
                           NULL AS execution_id,
                           NULL AS manifest_hash,
                           NULL AS payload_hash
                    FROM summaries summary

                    UNION ALL

                    SELECT m.created_at AS fact_time, 0 AS fact_order,
                           m.message_id AS fact_id, 'user' AS fact_kind,
                           NULL AS source_attempt_id,
                           NULL AS source_provider_profile,
                           NULL AS source_model_id,
                           NULL AS provider_state_key,
                           m.content AS text_content, NULL AS tool_call_id,
                           NULL AS provider_call_id, NULL AS tool_name,
                           NULL AS json_content, NULL AS outcome_kind,
                           NULL AS execution_id, NULL AS manifest_hash,
                           NULL AS payload_hash
                    FROM message m
                    JOIN conversation_event me
                      ON me.turn_id = m.turn_id
                     AND me.event_type = 'turn.accepted'
                    JOIN branch_path path
                      ON path.branch_id = m.branch_id
                    JOIN target t
                    WHERE m.conversation_id = :conversationId
                      AND m.role = 'user'
                      AND (
                          path.cutoff_sequence IS NULL
                          OR me.sequence < path.cutoff_sequence
                      )
                      AND (
                          m.created_at <= t.target_time
                          OR EXISTS (
                              SELECT 1
                              FROM turn_supplement s
                              LEFT JOIN agent_round previous_round
                                ON previous_round.round_id =
                                   s.injected_after_round_id
                              WHERE s.message_id = m.message_id
                                AND s.phase = 'injected'
                                AND (
                                    (
                                        s.injected_after_round_id IS NULL
                                        AND t.target_round_index = 0
                                    )
                                    OR (
                                        previous_round.run_id =
                                            t.target_run_id
                                        AND previous_round.round_index <
                                            t.target_round_index
                                    )
                                )
                          )
                      )
                      AND me.sequence >= (
                          SELECT waterline_sequence FROM context_head
                      )

                    UNION ALL

                    SELECT ma.ended_at AS fact_time,
                           10 + b.block_index AS fact_order,
                           b.block_id AS fact_id, b.block_kind AS fact_kind,
                           ma.attempt_id AS source_attempt_id,
                           ma.provider_profile AS source_provider_profile,
                           ma.model_id AS source_model_id,
                           b.provider_block_id AS provider_state_key,
                           b.text_content, tc.tool_call_id,
                           tc.provider_call_id, tc.tool_name,
                           tc.arguments_json AS json_content,
                           NULL AS outcome_kind,
                           NULL AS execution_id,
                           NULL AS manifest_hash,
                           NULL AS payload_hash
                    FROM model_attempt ma
                    JOIN agent_round ar ON ar.round_id = ma.round_id
                    JOIN conversation_event ae
                      ON ae.turn_id = ma.turn_id
                     AND ae.event_type = 'turn.accepted'
                    JOIN branch_path path
                      ON path.branch_id = ar.branch_id
                    JOIN model_content_block b ON b.attempt_id = ma.attempt_id
                    LEFT JOIN model_tool_call tc ON tc.block_id = b.block_id
                    JOIN target t
                    WHERE ma.conversation_id = :conversationId
                      AND ma.phase = 'completed'
                      AND (
                          path.cutoff_sequence IS NULL
                          OR ae.sequence < path.cutoff_sequence
                      )
                      AND ma.ended_at < t.target_time
                      AND b.block_kind IN (
                          'provider_state', 'text', 'tool_call'
                      )
                      AND (
                          b.block_kind <> 'provider_state'
                          OR ma.stop_reason = 'max_tokens'
                          OR EXISTS (
                              SELECT 1
                              FROM model_tool_call state_call
                              WHERE state_call.attempt_id = ma.attempt_id
                          )
                      )
                      AND ae.sequence >= (
                          SELECT waterline_sequence FROM context_head
                      )

                    UNION ALL

                    SELECT ma.ended_at AS fact_time,
                           900 AS fact_order,
                           'continuation:' || ma.attempt_id AS fact_id,
                           'continuation' AS fact_kind,
                           ma.attempt_id AS source_attempt_id,
                           ma.provider_profile AS source_provider_profile,
                           ma.model_id AS source_model_id,
                           NULL AS provider_state_key,
                           NULL AS text_content,
                           NULL AS tool_call_id,
                           NULL AS provider_call_id,
                           NULL AS tool_name,
                           NULL AS json_content,
                           NULL AS outcome_kind,
                           NULL AS execution_id,
                           NULL AS manifest_hash,
                           NULL AS payload_hash
                    FROM model_attempt ma
                    JOIN agent_round ar ON ar.round_id = ma.round_id
                    JOIN conversation_event ae
                      ON ae.turn_id = ma.turn_id
                     AND ae.event_type = 'turn.accepted'
                    JOIN branch_path path
                      ON path.branch_id = ar.branch_id
                    JOIN target t
                    WHERE ma.conversation_id = :conversationId
                      AND ma.phase = 'completed'
                      AND ma.stop_reason = 'max_tokens'
                      AND (
                          path.cutoff_sequence IS NULL
                          OR ae.sequence < path.cutoff_sequence
                      )
                      AND ma.ended_at < t.target_time
                      AND ae.sequence >= (
                          SELECT waterline_sequence FROM context_head
                      )

                    UNION ALL

                    SELECT o.created_at AS fact_time, 1000 + tc.ordinal AS fact_order,
                           o.observation_id AS fact_id, 'tool_result' AS fact_kind,
                           ma.attempt_id AS source_attempt_id,
                           ma.provider_profile AS source_provider_profile,
                           ma.model_id AS source_model_id,
                           NULL AS provider_state_key,
                           NULL AS text_content, tc.tool_call_id,
                           tc.provider_call_id, tc.tool_name,
                           o.content_json AS json_content,
                           o.outcome_kind, o.execution_id,
                           execution.manifest_hash AS manifest_hash,
                           payload.content_hash AS payload_hash
                    FROM tool_observation o
                    JOIN model_tool_call tc ON tc.tool_call_id = o.tool_call_id
                    JOIN tool_execution execution
                      ON execution.execution_id = o.execution_id
                    LEFT JOIN tool_output_payload payload
                      ON payload.execution_id = o.execution_id
                    JOIN model_attempt ma ON ma.attempt_id = tc.attempt_id
                    JOIN agent_round ar ON ar.round_id = ma.round_id
                    JOIN conversation_event oe
                      ON oe.turn_id = ma.turn_id
                     AND oe.event_type = 'turn.accepted'
                    JOIN branch_path path
                      ON path.branch_id = ar.branch_id
                    JOIN target t
                    WHERE ma.conversation_id = :conversationId
                      AND o.created_at < t.target_time
                      AND (
                          path.cutoff_sequence IS NULL
                          OR oe.sequence < path.cutoff_sequence
                      )
                      AND oe.sequence >= (
                          SELECT waterline_sequence FROM context_head
                      )
                )
                SELECT * FROM facts
                ORDER BY fact_time, fact_order, fact_id
                """)
                .param("roundId", roundId)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .query((rs, rowNum) -> (ModelInputItem) switch (
                        rs.getString("fact_kind")
                ) {
                    case "history_summary" ->
                            new ModelInputItem.HistorySummary(
                                    rs.getString("fact_id"),
                                    rs.getString("text_content")
                            );
                    case "user" -> new ModelInputItem.UserText(
                            rs.getString("fact_id"),
                            rs.getString("text_content")
                    );
                    case "provider_state" ->
                            new ModelInputItem.AssistantProviderState(
                                    rs.getString("source_attempt_id"),
                                    rs.getString("fact_id"),
                                    rs.getString("source_provider_profile"),
                                    rs.getString("source_model_id"),
                                    rs.getString("provider_state_key"),
                                    rs.getString("text_content")
                            );
                    case "text" -> new ModelInputItem.AssistantText(
                            rs.getString("source_attempt_id"),
                            rs.getString("fact_id"),
                            rs.getString("text_content")
                    );
                    case "continuation" ->
                            new ModelInputItem.ContinuationDirective(
                                    rs.getString("source_attempt_id"),
                                    CONTINUATION_INSTRUCTION
                            );
                    case "tool_call" -> new ModelInputItem.AssistantToolCall(
                            rs.getString("source_attempt_id"),
                            rs.getString("tool_call_id"),
                            rs.getString("provider_call_id"),
                            rs.getString("tool_name"),
                            read(rs.getString("json_content"))
                    );
                    case "tool_result" -> new ModelInputItem.ToolResult(
                            rs.getString("source_attempt_id"),
                            rs.getString("fact_id"),
                            rs.getString("tool_call_id"),
                            rs.getString("provider_call_id"),
                            rs.getString("execution_id"),
                            rs.getString("outcome_kind"),
                            rs.getString("manifest_hash"),
                            rs.getString("payload_hash"),
                            read(rs.getString("json_content"))
                    );
                    default -> throw new IllegalStateException(
                            "Unknown model context fact kind"
                    );
                })
                .list();
        return facts.stream()
                .map(item -> item instanceof ModelInputItem.UserText user
                        ? withAttachments(user, conversationId)
                        : item)
                .toList();
    }

    /**
     * Context history for an isolated child Run. It deliberately excludes the
     * branch transcript and replays only the explicit task plus this Run's own
     * completed model/tool protocol facts.
     */
    public List<ModelInputItem> isolatedRunFactsBeforeRound(
            String runId,
            String roundId,
            String task
    ) {
        List<ModelInputItem> items = new java.util.ArrayList<>();
        items.add(new ModelInputItem.UserText(
                "isolated-task:" + runId,
                task
        ));
        items.addAll(jdbc.sql("""
                WITH target AS (
                    SELECT round_index
                    FROM agent_round
                    WHERE round_id = :roundId AND run_id = :runId
                ),
                facts AS (
                    SELECT ar.round_index, 10 + block.block_index AS fact_order,
                           block.block_id AS fact_id,
                           block.block_kind AS fact_kind,
                           attempt.attempt_id,
                           attempt.provider_profile,
                           attempt.model_id,
                           block.provider_block_id,
                           block.text_content,
                           call.tool_call_id,
                           call.provider_call_id,
                           call.tool_name,
                           call.arguments_json AS json_content,
                           NULL AS outcome_kind,
                           NULL AS execution_id,
                           NULL AS manifest_hash,
                           NULL AS payload_hash
                    FROM model_attempt attempt
                    JOIN agent_round ar ON ar.round_id = attempt.round_id
                    JOIN model_content_block block
                      ON block.attempt_id = attempt.attempt_id
                    LEFT JOIN model_tool_call call
                      ON call.block_id = block.block_id
                    JOIN target
                    WHERE ar.run_id = :runId
                      AND ar.round_index < target.round_index
                      AND attempt.phase = 'completed'
                      AND block.block_kind IN (
                          'provider_state', 'text', 'tool_call'
                      )

                    UNION ALL

                    SELECT ar.round_index, 1000 + call.ordinal AS fact_order,
                           observation.observation_id AS fact_id,
                           'tool_result' AS fact_kind,
                           attempt.attempt_id,
                           attempt.provider_profile,
                           attempt.model_id,
                           NULL, NULL,
                           call.tool_call_id,
                           call.provider_call_id,
                           call.tool_name,
                           observation.content_json,
                           observation.outcome_kind,
                           observation.execution_id,
                           execution.manifest_hash,
                           payload.content_hash
                    FROM tool_observation observation
                    JOIN model_tool_call call
                      ON call.tool_call_id = observation.tool_call_id
                    JOIN model_attempt attempt
                      ON attempt.attempt_id = call.attempt_id
                    JOIN agent_round ar ON ar.round_id = attempt.round_id
                    JOIN tool_execution execution
                      ON execution.execution_id = observation.execution_id
                    LEFT JOIN tool_output_payload payload
                      ON payload.execution_id = observation.execution_id
                    JOIN target
                    WHERE ar.run_id = :runId
                      AND ar.round_index < target.round_index
                )
                SELECT * FROM facts
                ORDER BY round_index, fact_order, fact_id
                """)
                .param("runId", runId)
                .param("roundId", roundId)
                .query((rs, rowNum) -> (ModelInputItem) switch (
                        rs.getString("fact_kind")
                ) {
                    case "provider_state" ->
                            new ModelInputItem.AssistantProviderState(
                                    rs.getString("attempt_id"),
                                    rs.getString("fact_id"),
                                    rs.getString("provider_profile"),
                                    rs.getString("model_id"),
                                    rs.getString("provider_block_id"),
                                    rs.getString("text_content")
                            );
                    case "text" -> new ModelInputItem.AssistantText(
                            rs.getString("attempt_id"),
                            rs.getString("fact_id"),
                            rs.getString("text_content")
                    );
                    case "tool_call" -> new ModelInputItem.AssistantToolCall(
                            rs.getString("attempt_id"),
                            rs.getString("tool_call_id"),
                            rs.getString("provider_call_id"),
                            rs.getString("tool_name"),
                            read(rs.getString("json_content"))
                    );
                    case "tool_result" -> new ModelInputItem.ToolResult(
                            rs.getString("attempt_id"),
                            rs.getString("fact_id"),
                            rs.getString("tool_call_id"),
                            rs.getString("provider_call_id"),
                            rs.getString("execution_id"),
                            rs.getString("outcome_kind"),
                            rs.getString("manifest_hash"),
                            rs.getString("payload_hash"),
                            read(rs.getString("json_content"))
                    );
                    default -> throw new IllegalStateException(
                            "Unknown isolated context fact kind"
                    );
                })
                .list());
        return List.copyOf(items);
    }

    private ModelInputItem.UserText withAttachments(
            ModelInputItem.UserText user,
            String conversationId
    ) {
        List<ModelInputItem.AttachmentContext> attachments = jdbc.sql("""
                SELECT artifact_ref
                FROM message_attachment
                WHERE message_id = :messageId
                ORDER BY ordinal
                """)
                .param("messageId", user.messageId())
                .query(String.class)
                .list()
                .stream()
                .map(reference -> artifacts.require(
                        reference,
                        conversationId
                ))
                .map(snapshot -> new ModelInputItem.AttachmentContext(
                        snapshot.reference(),
                        snapshot.name(),
                        snapshot.mediaType(),
                        snapshot.byteCount(),
                        snapshot.contentHash()
                ))
                .toList();
        return new ModelInputItem.UserText(
                user.messageId(),
                user.text(),
                attachments
        );
    }

    /**
     * Returns the user facts that define the currently executing Turn as they
     * were visible to the target Round. These facts are task constraints, not
     * ordinary recency-ranked history.
     */
    public List<String> requiredUserFactIdsBeforeRound(
            String turnId,
            String roundId
    ) {
        return jdbc.sql("""
                WITH target AS (
                    SELECT ar.created_at AS target_time,
                           ar.run_id AS target_run_id,
                           ar.round_index AS target_round_index
                    FROM agent_round ar
                    WHERE ar.round_id = :roundId
                )
                SELECT m.message_id
                FROM message m
                JOIN target t
                WHERE m.turn_id = :turnId
                  AND m.role = 'user'
                  AND (
                      m.created_at <= t.target_time
                      OR EXISTS (
                          SELECT 1
                          FROM turn_supplement s
                          LEFT JOIN agent_round previous_round
                            ON previous_round.round_id =
                               s.injected_after_round_id
                          WHERE s.message_id = m.message_id
                            AND s.phase = 'injected'
                            AND (
                                (
                                    s.injected_after_round_id IS NULL
                                    AND t.target_round_index = 0
                                )
                                OR (
                                    previous_round.run_id =
                                        t.target_run_id
                                    AND previous_round.round_index <
                                        t.target_round_index
                                )
                            )
                      )
                  )
                ORDER BY m.created_at, m.message_id
                """)
                .param("turnId", turnId)
                .param("roundId", roundId)
                .query(String.class)
                .list();
    }

    public List<String> currentTurnObservationIdsBeforeRound(
            String turnId,
            String roundId
    ) {
        return jdbc.sql("""
                SELECT observation.observation_id
                FROM tool_observation observation
                JOIN model_tool_call call
                  ON call.tool_call_id = observation.tool_call_id
                JOIN model_attempt attempt
                  ON attempt.attempt_id = call.attempt_id
                JOIN agent_round source_round
                  ON source_round.round_id = attempt.round_id
                JOIN agent_round target_round
                  ON target_round.round_id = :roundId
                WHERE attempt.turn_id = :turnId
                  AND source_round.created_at < target_round.created_at
                  AND observation.created_at < target_round.created_at
                ORDER BY observation.created_at, observation.observation_id
                """)
                .param("turnId", turnId)
                .param("roundId", roundId)
                .query(String.class)
                .list();
    }

    public List<String> runObservationIdsBeforeRound(
            String runId,
            String roundId
    ) {
        return jdbc.sql("""
                SELECT observation.observation_id
                FROM tool_observation observation
                JOIN model_tool_call call
                  ON call.tool_call_id = observation.tool_call_id
                JOIN model_attempt attempt
                  ON attempt.attempt_id = call.attempt_id
                JOIN agent_round source_round
                  ON source_round.round_id = attempt.round_id
                JOIN agent_round target_round
                  ON target_round.round_id = :roundId
                WHERE source_round.run_id = :runId
                  AND target_round.run_id = :runId
                  AND source_round.round_index < target_round.round_index
                ORDER BY source_round.round_index,
                         observation.created_at,
                         observation.observation_id
                """)
                .param("runId", runId)
                .param("roundId", roundId)
                .query(String.class)
                .list();
    }

    private JsonNode read(String value) {
        try {
            return objectMapper.readTree(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "Persisted model context contains invalid JSON",
                    exception
            );
        }
    }
}
