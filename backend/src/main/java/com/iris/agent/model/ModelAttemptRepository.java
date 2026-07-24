package com.iris.agent.model;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.agent.model.ModelAttemptResult.ContentBlock;
import com.iris.agent.model.ModelAttemptResult.ToolCall;
import com.iris.agent.run.RoundPhase;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.Types;
import java.time.Instant;
import java.util.Optional;
import java.util.List;

@Repository
public class ModelAttemptRepository {
    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;

    public ModelAttemptRepository(JdbcClient jdbc, ObjectMapper objectMapper) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
    }

    public int nextAttemptIndex(String roundId) {
        return jdbc.sql("""
                SELECT COALESCE(MAX(attempt_index), -1) + 1
                FROM model_attempt
                WHERE round_id = :roundId
                """)
                .param("roundId", roundId)
                .query(Integer.class)
                .single();
    }

    public void insertAttempt(
            String attemptId,
            String conversationId,
            String turnId,
            String runId,
            String roundId,
            int attemptIndex,
            String providerProfile,
            String modelId,
            String contextHash,
            String capabilityLeaseHash,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO model_attempt(
                    attempt_id, conversation_id, turn_id, run_id, round_id,
                    attempt_index, provider_profile, model_id, context_hash,
                    capability_lease_hash, phase, version, started_at
                ) VALUES (
                    :attemptId, :conversationId, :turnId, :runId, :roundId,
                    :attemptIndex, :providerProfile, :modelId, :contextHash,
                    :leaseHash, 'streaming', 1, :now
                )
                """)
                .param("attemptId", attemptId)
                .param("conversationId", conversationId)
                .param("turnId", turnId)
                .param("runId", runId)
                .param("roundId", roundId)
                .param("attemptIndex", attemptIndex)
                .param("providerProfile", providerProfile)
                .param("modelId", modelId)
                .param("contextHash", contextHash)
                .param("leaseHash", capabilityLeaseHash)
                .param("now", now.toString())
                .update();
    }

    public Optional<AttemptRow> findAttempt(String attemptId) {
        return jdbc.sql("""
                SELECT * FROM model_attempt WHERE attempt_id = :attemptId
                """)
                .param("attemptId", attemptId)
                .query((rs, rowNum) -> new AttemptRow(
                        rs.getString("attempt_id"),
                        rs.getString("conversation_id"),
                        rs.getString("turn_id"),
                        rs.getString("run_id"),
                        rs.getString("round_id"),
                        rs.getInt("attempt_index"),
                        rs.getString("provider_profile"),
                        rs.getString("model_id"),
                        rs.getString("phase"),
                        rs.getLong("version")
                ))
                .optional();
    }

    public void insertBlock(
            String attemptId,
            String blockId,
            ContentBlock block,
            String contentHash,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO model_content_block(
                    block_id, attempt_id, block_index, block_kind,
                    provider_block_id, text_content, tool_name,
                    tool_arguments_json, content_hash, created_at
                ) VALUES (
                    :blockId, :attemptId, :blockIndex, :blockKind,
                    :providerBlockId, :textContent, :toolName,
                    :toolArguments, :contentHash, :now
                )
                """)
                .param("blockId", blockId)
                .param("attemptId", attemptId)
                .param("blockIndex", block.index())
                .param("blockKind", block.kind().name().toLowerCase())
                .param("providerBlockId", block.providerBlockId(), Types.VARCHAR)
                .param("textContent", block.text(), Types.VARCHAR)
                .param("toolName", block.toolName(), Types.VARCHAR)
                .param(
                        "toolArguments",
                        block.toolArguments() == null
                                ? null
                                : write(block.toolArguments()),
                        Types.VARCHAR
                )
                .param("contentHash", contentHash)
                .param("now", now.toString())
                .update();
    }

    public void insertToolCall(
            String attemptId,
            String blockId,
            ToolCall call,
            String argumentsHash,
            Instant now
    ) {
        String exposureId = jdbc.sql("""
                SELECT e.exposure_id
                FROM model_attempt ma
                JOIN model_capability_exposure e
                  ON e.context_hash = ma.context_hash
                WHERE ma.attempt_id = :attemptId
                  AND e.tool_name = :toolName
                """)
                .param("attemptId", attemptId)
                .param("toolName", call.name())
                .query(String.class)
                .optional()
                .orElseThrow(() -> new ModelProtocolException(
                        "tool_not_in_capability_lease",
                        "Model requested a tool outside the active capability lease"
                ));
        jdbc.sql("""
                INSERT INTO model_tool_call(
                    tool_call_id, attempt_id, block_id, provider_call_id,
                    tool_name, arguments_json, arguments_hash, ordinal, created_at
                ) VALUES (
                    :toolCallId, :attemptId, :blockId, :providerCallId,
                    :toolName, :arguments, :argumentsHash, :ordinal, :now
                )
                """)
                .param("toolCallId", call.toolCallId())
                .param("attemptId", attemptId)
                .param("blockId", blockId)
                .param("providerCallId", call.providerCallId(), Types.VARCHAR)
                .param("toolName", call.name())
                .param("arguments", write(call.arguments()))
                .param("argumentsHash", argumentsHash)
                .param("ordinal", call.ordinal())
                .param("now", now.toString())
                .update();
        jdbc.sql("""
                INSERT INTO model_tool_call_exposure(
                    tool_call_id, exposure_id
                ) VALUES (:toolCallId, :exposureId)
                """)
                .param("toolCallId", call.toolCallId())
                .param("exposureId", exposureId)
                .update();
    }

    public boolean completeAttempt(
            String attemptId,
            long expectedVersion,
            ModelAttemptResult result,
            Instant now
    ) {
        return jdbc.sql("""
                UPDATE model_attempt
                SET phase = 'completed', stop_reason = :stopReason,
                    input_tokens = :inputTokens, output_tokens = :outputTokens,
                    version = version + 1, ended_at = :now
                WHERE attempt_id = :attemptId
                  AND phase = 'streaming'
                  AND version = :expectedVersion
                """)
                .param("stopReason", result.stopReason())
                .param("inputTokens", result.usage().inputTokens())
                .param("outputTokens", result.usage().outputTokens())
                .param("now", now.toString())
                .param("attemptId", attemptId)
                .param("expectedVersion", expectedVersion)
                .update() == 1;
    }

    public Optional<FinalAnswerSource> finalAnswer(String roundId) {
        Optional<FinalAttempt> attempt = jdbc.sql("""
                SELECT attempt_id
                FROM model_attempt
                WHERE round_id = :roundId AND phase = 'completed'
                ORDER BY attempt_index DESC
                LIMIT 1
                """)
                .param("roundId", roundId)
                .query((rs, rowNum) -> new FinalAttempt(
                        rs.getString("attempt_id")
                ))
                .optional();
        if (attempt.isEmpty()) {
            return Optional.empty();
        }
        List<String> textBlocks = jdbc.sql("""
                SELECT text_content
                FROM model_content_block
                WHERE attempt_id = :attemptId AND block_kind = 'text'
                ORDER BY block_index
                """)
                .param("attemptId", attempt.get().attemptId())
                .query(String.class)
                .list();
        String text = String.join("", textBlocks);
        return Optional.of(new FinalAnswerSource(
                attempt.get().attemptId(),
                null,
                text
        ));
    }

    public void failAttempt(
            String attemptId,
            String category,
            Instant now
    ) {
        jdbc.sql("""
                UPDATE model_attempt
                SET phase = 'failed', error_category = :category,
                    version = version + 1, ended_at = :now
                WHERE attempt_id = :attemptId AND phase = 'streaming'
                """)
                .param("category", category)
                .param("now", now.toString())
                .param("attemptId", attemptId)
                .update();
    }

    public int reconcileInterrupted(Instant now) {
        int attemptsUpdated = jdbc.sql("""
                UPDATE model_attempt
                SET phase = 'interrupted',
                    error_category = 'process_interrupted',
                    version = version + 1,
                    ended_at = :now
                WHERE phase = 'streaming'
                """)
                .param("now", now.toString())
                .update();
        jdbc.sql("""
                UPDATE agent_round
                SET phase = 'failed',
                    version = version + 1,
                    updated_at = :now
                WHERE phase = 'model_streaming'
                """)
                .param("now", now.toString())
                .update();
        return attemptsUpdated;
    }

    public Optional<ObservationSource> observationSource(
            String toolCallId,
            String executionId
    ) {
        return jdbc.sql("""
                SELECT tc.tool_call_id, tc.provider_call_id, tc.tool_name,
                       tc.execution_id AS linked_execution_id,
                       e.execution_id, e.tool_call_id AS execution_tool_call_id,
                       e.phase, e.outcome_kind, e.output_json,
                       e.error_code, e.error_message
                FROM model_tool_call tc
                JOIN tool_execution e ON e.execution_id = :executionId
                WHERE tc.tool_call_id = :toolCallId
                """)
                .param("executionId", executionId)
                .param("toolCallId", toolCallId)
                .query((rs, rowNum) -> new ObservationSource(
                        rs.getString("tool_call_id"),
                        rs.getString("provider_call_id"),
                        rs.getString("tool_name"),
                        rs.getString("linked_execution_id"),
                        rs.getString("execution_id"),
                        rs.getString("execution_tool_call_id"),
                        rs.getString("phase"),
                        rs.getString("outcome_kind"),
                        rs.getString("output_json"),
                        rs.getString("error_code"),
                        rs.getString("error_message")
                ))
                .optional();
    }

    public Optional<ToolObservation> findObservation(String toolCallId) {
        return jdbc.sql("""
                SELECT * FROM tool_observation
                WHERE tool_call_id = :toolCallId
                """)
                .param("toolCallId", toolCallId)
                .query((rs, rowNum) -> new ToolObservation(
                        rs.getString("observation_id"),
                        rs.getString("tool_call_id"),
                        rs.getString("execution_id"),
                        rs.getString("outcome_kind"),
                        readJson(rs.getString("content_json")),
                        rs.getString("content_hash"),
                        Instant.parse(rs.getString("created_at"))
                ))
                .optional();
    }

    public List<RoundToolCall> roundToolCalls(String roundId) {
        return jdbc.sql("""
                SELECT tc.tool_call_id, tc.provider_call_id, tc.tool_name,
                       tc.arguments_json, tc.ordinal, tc.execution_id
                FROM model_tool_call tc
                JOIN model_attempt ma ON ma.attempt_id = tc.attempt_id
                WHERE ma.round_id = :roundId
                ORDER BY ma.attempt_index, tc.ordinal
                """)
                .param("roundId", roundId)
                .query((rs, rowNum) -> new RoundToolCall(
                        rs.getString("tool_call_id"),
                        rs.getString("provider_call_id"),
                        rs.getString("tool_name"),
                        readJson(rs.getString("arguments_json")),
                        rs.getInt("ordinal"),
                        rs.getString("execution_id")
                ))
                .list();
    }

    public List<ProjectionGap> projectionGaps() {
        return jdbc.sql("""
                SELECT ma.round_id, tc.tool_call_id, tc.provider_call_id,
                       tc.tool_name, tc.arguments_json, tc.ordinal,
                       tc.execution_id, e.conversation_id
                FROM model_tool_call tc
                JOIN model_attempt ma ON ma.attempt_id = tc.attempt_id
                JOIN tool_execution e ON e.execution_id = tc.execution_id
                LEFT JOIN tool_render_link tr
                  ON tr.tool_call_id = tc.tool_call_id
                LEFT JOIN render_node_projection rp
                  ON rp.node_id = tr.node_id
                LEFT JOIN approval_attention_link aa
                  ON aa.approval_id = e.approval_id
                LEFT JOIN attention_projection ap
                  ON ap.attention_id = aa.attention_id
                WHERE tr.node_id IS NULL
                   OR (e.approval_id IS NOT NULL AND aa.attention_id IS NULL)
                   OR rp.node_status <> CASE e.phase
                       WHEN 'claimed' THEN 'queued'
                       WHEN 'prepared' THEN 'queued'
                       WHEN 'awaiting_approval' THEN 'verifying'
                       WHEN 'executing' THEN 'running'
                       WHEN 'verifying' THEN 'verifying'
                       WHEN 'succeeded' THEN 'succeeded'
                       WHEN 'outcome_unknown' THEN 'outcome_unknown'
                       ELSE 'failed'
                   END
                   OR (
                       e.approval_id IS NOT NULL
                       AND ap.status <> CASE e.phase
                           WHEN 'awaiting_approval' THEN 'waiting'
                           WHEN 'expired' THEN 'expired'
                           ELSE 'resolved'
                       END
                   )
                ORDER BY e.created_at
                """)
                .query((rs, rowNum) -> new ProjectionGap(
                        rs.getString("round_id"),
                        rs.getString("conversation_id"),
                        new RoundToolCall(
                                rs.getString("tool_call_id"),
                                rs.getString("provider_call_id"),
                                rs.getString("tool_name"),
                                readJson(rs.getString("arguments_json")),
                                rs.getInt("ordinal"),
                                rs.getString("execution_id")
                        )
                ))
                .list();
    }

    public void linkExecutionAndInsertObservation(
            ToolObservation observation
    ) {
        int linked = jdbc.sql("""
                UPDATE model_tool_call
                SET execution_id = :executionId
                WHERE tool_call_id = :toolCallId
                  AND (execution_id IS NULL OR execution_id = :executionId)
                """)
                .param("executionId", observation.executionId())
                .param("toolCallId", observation.toolCallId())
                .update();
        if (linked != 1) {
            throw new IllegalStateException(
                    "ToolCall 已关联到另一条 execution"
            );
        }
        jdbc.sql("""
                INSERT INTO tool_observation(
                    observation_id, tool_call_id, execution_id,
                    outcome_kind, content_json, content_hash, created_at
                ) VALUES (
                    :observationId, :toolCallId, :executionId,
                    :outcomeKind, :contentJson, :contentHash, :createdAt
                )
                """)
                .param("observationId", observation.observationId())
                .param("toolCallId", observation.toolCallId())
                .param("executionId", observation.executionId())
                .param("outcomeKind", observation.outcomeKind())
                .param("contentJson", write(observation.content()))
                .param("contentHash", observation.contentHash())
                .param("createdAt", observation.createdAt().toString())
                .update();
    }

    public boolean transitionRound(
            String roundId,
            RoundPhase from,
            RoundPhase to,
            long expectedVersion,
            Instant now
    ) {
        return jdbc.sql("""
                UPDATE agent_round
                SET phase = :toPhase,
                    tool_call_count = CASE
                        WHEN :toPhase = 'awaiting_tools' THEN (
                            SELECT COUNT(*) FROM model_tool_call tc
                            JOIN model_attempt ma ON ma.attempt_id = tc.attempt_id
                            WHERE ma.round_id = :roundId
                        )
                        ELSE tool_call_count
                    END,
                    version = version + 1,
                    updated_at = :now
                WHERE round_id = :roundId
                  AND phase = :fromPhase
                  AND version = :expectedVersion
                """)
                .param("toPhase", to.name().toLowerCase())
                .param("roundId", roundId)
                .param("now", now.toString())
                .param("fromPhase", from.name().toLowerCase())
                .param("expectedVersion", expectedVersion)
                .update() == 1;
    }

    private String write(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "模型事实无法序列化",
                    exception
            );
        }
    }

    private com.fasterxml.jackson.databind.JsonNode readJson(String value) {
        try {
            return objectMapper.readTree(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "ToolObservation 不是合法 JSON",
                    exception
            );
        }
    }

    public record AttemptRow(
            String attemptId,
            String conversationId,
            String turnId,
            String runId,
            String roundId,
            int attemptIndex,
            String providerProfile,
            String modelId,
            String phase,
            long version
    ) {
    }

    public record ObservationSource(
            String toolCallId,
            String providerCallId,
            String toolName,
            String linkedExecutionId,
            String executionId,
            String executionToolCallId,
            String phase,
            String outcomeKind,
            String outputJson,
            String errorCode,
            String errorMessage
    ) {
    }

    public record RoundToolCall(
            String toolCallId,
            String providerCallId,
            String toolName,
            com.fasterxml.jackson.databind.JsonNode arguments,
            int ordinal,
            String executionId
    ) {
    }

    public record FinalAnswerSource(
            String attemptId,
            String providerMessageId,
            String text
    ) {
    }

    public record ProjectionGap(
            String roundId,
            String conversationId,
            RoundToolCall call
    ) {
    }

    private record FinalAttempt(String attemptId) {
    }
}
