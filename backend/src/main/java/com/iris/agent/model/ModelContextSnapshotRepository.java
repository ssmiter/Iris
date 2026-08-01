package com.iris.agent.model;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Optional;

@Repository
public class ModelContextSnapshotRepository {
    private final JdbcClient jdbc;

    public ModelContextSnapshotRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public void save(
            ModelContext context,
            String conversationId,
            String branchId,
            String runId,
            String roundId,
            String payloadJson,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO model_context_snapshot(
                    context_hash, capability_lease_hash, conversation_id,
                    branch_id, run_id, round_id, estimated_input_tokens,
                    max_input_tokens, reserved_output_tokens,
                    dropped_fact_count, payload_json, created_at
                ) VALUES (
                    :contextHash, :leaseHash, :conversationId,
                    :branchId, :runId, :roundId, :estimatedTokens,
                    :maxInputTokens, :reservedOutputTokens,
                    :droppedFactCount, :payload, :now
                )
                ON CONFLICT(context_hash) DO NOTHING
                """)
                .param("contextHash", context.contextHash())
                .param("leaseHash", context.capabilityLeaseHash())
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("runId", runId)
                .param("roundId", roundId)
                .param("estimatedTokens", context.estimatedInputTokens())
                .param("maxInputTokens", context.maxInputTokens())
                .param("reservedOutputTokens", context.reservedOutputTokens())
                .param("droppedFactCount", context.droppedFactCount())
                .param("payload", payloadJson)
                .param("now", now.toString())
                .update();
        String stored = jdbc.sql("""
                SELECT payload_json FROM model_context_snapshot
                WHERE context_hash = :contextHash
                """)
                .param("contextHash", context.contextHash())
                .query(String.class)
                .single();
        if (!stored.equals(payloadJson)) {
            throw new IllegalStateException(
                    "Model context hash collision or non-canonical payload"
            );
        }
        ModelPromptPrefix prefix = context.promptPrefix();
        jdbc.sql("""
                INSERT INTO model_context_prefix(
                    context_hash, prompt_definition_id, prompt_version,
                    prompt_hash, tool_schema_hash, prefix_hash, created_at
                ) VALUES (
                    :contextHash, :definitionId, :version,
                    :promptHash, :toolSchemaHash, :prefixHash, :now
                )
                ON CONFLICT(context_hash) DO NOTHING
                """)
                .param("contextHash", context.contextHash())
                .param("definitionId", prefix.promptDefinitionId())
                .param("version", prefix.promptVersion())
                .param("promptHash", prefix.promptHash())
                .param("toolSchemaHash", prefix.toolSchemaHash())
                .param("prefixHash", prefix.prefixHash())
                .param("now", now.toString())
                .update();
        int matchingPrefix = jdbc.sql("""
                SELECT COUNT(*) FROM model_context_prefix
                WHERE context_hash = :contextHash
                  AND prompt_definition_id = :definitionId
                  AND prompt_version = :version
                  AND prompt_hash = :promptHash
                  AND tool_schema_hash = :toolSchemaHash
                  AND prefix_hash = :prefixHash
                """)
                .param("contextHash", context.contextHash())
                .param("definitionId", prefix.promptDefinitionId())
                .param("version", prefix.promptVersion())
                .param("promptHash", prefix.promptHash())
                .param("toolSchemaHash", prefix.toolSchemaHash())
                .param("prefixHash", prefix.prefixHash())
                .query(Integer.class)
                .single();
        if (matchingPrefix != 1) {
            throw new IllegalStateException(
                    "Model context prefix identity does not match snapshot"
            );
        }
        for (int ordinal = 0; ordinal < context.tools().size(); ordinal++) {
            ModelRequest.ToolDefinition tool = context.tools().get(ordinal);
            jdbc.sql("""
                    INSERT INTO model_capability_exposure(
                        exposure_id, context_hash, capability_lease_hash,
                        tool_name, manifest_hash, ordinal, created_at
                    ) VALUES (
                        :exposureId, :contextHash, :leaseHash,
                        :toolName, :manifestHash, :ordinal, :now
                    )
                    ON CONFLICT(context_hash, tool_name) DO NOTHING
                    """)
                    .param(
                            "exposureId",
                            exposureId(
                                    context.contextHash(),
                                    tool.name(),
                                    tool.manifestHash()
                            )
                    )
                    .param("contextHash", context.contextHash())
                    .param("leaseHash", context.capabilityLeaseHash())
                    .param("toolName", tool.name())
                    .param("manifestHash", tool.manifestHash())
                    .param("ordinal", ordinal)
                    .param("now", now.toString())
                    .update();
        }
        int exposureCount = jdbc.sql("""
                SELECT COUNT(*) FROM model_capability_exposure
                WHERE context_hash = :contextHash
                """)
                .param("contextHash", context.contextHash())
                .query(Integer.class)
                .single();
        if (exposureCount != context.tools().size()) {
            throw new IllegalStateException(
                    "Capability exposure set does not match context snapshot"
            );
        }
    }

    public Optional<ContextPressure> latestPressure(String runId) {
        return jdbc.sql("""
                SELECT estimated_input_tokens, max_input_tokens,
                       reserved_output_tokens, dropped_fact_count
                FROM model_context_snapshot snapshot
                JOIN agent_round round
                  ON round.round_id = snapshot.round_id
                WHERE snapshot.run_id = :runId
                ORDER BY round.round_index DESC,
                         snapshot.created_at DESC,
                         snapshot.context_hash DESC
                LIMIT 1
                """)
                .param("runId", runId)
                .query((rs, rowNum) -> new ContextPressure(
                        rs.getInt("estimated_input_tokens"),
                        rs.getInt("max_input_tokens"),
                        rs.getInt("reserved_output_tokens"),
                        rs.getInt("dropped_fact_count")
                ))
                .optional();
    }

    public record ContextPressure(
            int estimatedInputTokens,
            int maxInputTokens,
            int reservedOutputTokens,
            int droppedFactCount
    ) {
        public double inputRatio() {
            int usable = maxInputTokens - reservedOutputTokens;
            return usable <= 0
                    ? 1.0
                    : (double) estimatedInputTokens / usable;
        }
    }

    private String exposureId(
            String contextHash,
            String toolName,
            String manifestHash
    ) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(
                    (contextHash + "\n" + toolName + "\n" + manifestHash)
                            .getBytes(StandardCharsets.UTF_8)
            );
            return "exposure_" + HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 unavailable", exception);
        }
    }
}
