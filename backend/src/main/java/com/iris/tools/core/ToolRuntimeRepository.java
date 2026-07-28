package com.iris.tools.core;

import com.iris.tools.core.ToolExecutionViews.RuntimeResult;
import com.iris.tools.core.ToolRegistry.ToolBinding;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.Types;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Repository
public class ToolRuntimeRepository {
    private final JdbcClient jdbc;

    public ToolRuntimeRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public boolean hasCommittedActivity(String runId) {
        return jdbc.sql("""
                SELECT COUNT(*) FROM tool_execution
                WHERE run_id = :runId
                  AND phase IN ('executing', 'verifying')
                """)
                .param("runId", runId)
                .query(Integer.class)
                .single() > 0;
    }

    public int cancelBeforeExecution(String runId, Instant now) {
        jdbc.sql("""
                UPDATE tool_approval_request
                SET status = 'invalidated', decided_at = :now,
                    version = version + 1
                WHERE status = 'waiting'
                  AND execution_id IN (
                      SELECT execution_id FROM tool_execution
                      WHERE run_id = :runId
                        AND phase = 'awaiting_approval'
                  )
                """)
                .param("runId", runId)
                .param("now", now.toString())
                .update();
        return jdbc.sql("""
                UPDATE tool_execution
                SET phase = 'failed', outcome_kind = 'failed',
                    error_code = 'cancelled_before_execution',
                    error_message = '用户已停止当前任务，工具未进入副作用阶段。',
                    version = version + 1, updated_at = :now
                WHERE run_id = :runId
                  AND phase IN ('claimed', 'prepared', 'awaiting_approval')
                """)
                .param("runId", runId)
                .param("now", now.toString())
                .update();
    }

    public Optional<ModelExposure> modelExposure(String toolCallId) {
        return jdbc.sql("""
                SELECT e.exposure_id, e.context_hash,
                       e.capability_lease_hash, e.tool_name, e.manifest_hash
                FROM model_tool_call_exposure link
                JOIN model_capability_exposure e
                  ON e.exposure_id = link.exposure_id
                WHERE link.tool_call_id = :toolCallId
                """)
                .param("toolCallId", toolCallId)
                .query((rs, rowNum) -> new ModelExposure(
                        rs.getString("exposure_id"),
                        rs.getString("context_hash"),
                        rs.getString("capability_lease_hash"),
                        rs.getString("tool_name"),
                        rs.getString("manifest_hash")
                ))
                .optional();
    }

    public Optional<RuntimeResult> findByToolCall(
            String conversationId,
            String toolCallId
    ) {
        return jdbc.sql("""
                SELECT e.*, s.snapshot_hash, s.impact_statement
                FROM tool_execution e
                LEFT JOIN operation_snapshot s ON s.execution_id = e.execution_id
                WHERE e.conversation_id = :conversationId
                  AND e.tool_call_id = :toolCallId
                """)
                .param("conversationId", conversationId)
                .param("toolCallId", toolCallId)
                .query(this::mapResult)
                .optional();
    }

    public Optional<RuntimeResult> findByExecutionId(String executionId) {
        return jdbc.sql("""
                SELECT e.*, s.snapshot_hash, s.impact_statement
                FROM tool_execution e
                LEFT JOIN operation_snapshot s ON s.execution_id = e.execution_id
                WHERE e.execution_id = :executionId
                """)
                .param("executionId", executionId)
                .query(this::mapResult)
                .optional();
    }

    public String inputHash(String executionId) {
        return jdbc.sql("""
                SELECT input_hash FROM tool_execution
                WHERE execution_id = :executionId
                """)
                .param("executionId", executionId)
                .query(String.class)
                .single();
    }

    public void insertClaim(
            String executionId,
            ToolExecutionViews.Invocation invocation,
            ToolContext context,
            ToolBinding binding,
            String inputHash,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO tool_execution(
                    execution_id, tool_call_id, conversation_id, turn_id, run_id,
                    round_id, tool_id, tool_version, tool_name, capability_path,
                    manifest_hash, input_hash, phase, version, created_at, updated_at
                ) VALUES (
                    :executionId, :toolCallId, :conversationId, :turnId, :runId,
                    :roundId, :toolId, :toolVersion, :toolName, :capabilityPath,
                    :manifestHash, :inputHash, 'claimed', 1, :now, :now
                )
                """)
                .param("executionId", executionId)
                .param("toolCallId", invocation.toolCallId())
                .param("conversationId", context.conversationId())
                .param("turnId", context.turnId())
                .param("runId", context.runId())
                .param("roundId", context.roundId(), Types.VARCHAR)
                .param("toolId", binding.manifest().id())
                .param("toolVersion", binding.manifest().version())
                .param("toolName", binding.manifest().name())
                .param("capabilityPath", binding.capabilityPath())
                .param("manifestHash", binding.manifestHash())
                .param("inputHash", inputHash)
                .param("now", now.toString())
                .update();
    }

    public void insertSnapshot(
            String snapshotId,
            String executionId,
            String manifestHash,
            String normalizedInputJson,
            String impactStatement,
            String resourcesJson,
            String snapshotHash,
            Instant expiresAt,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO operation_snapshot(
                    snapshot_id, execution_id, manifest_hash,
                    normalized_input_json, impact_statement, resources_json,
                    snapshot_hash, expires_at, created_at
                ) VALUES (
                    :snapshotId, :executionId, :manifestHash,
                    :input, :impact, :resources,
                    :snapshotHash, :expiresAt, :now
                )
                """)
                .param("snapshotId", snapshotId)
                .param("executionId", executionId)
                .param("manifestHash", manifestHash)
                .param("input", normalizedInputJson)
                .param("impact", impactStatement)
                .param("resources", resourcesJson)
                .param("snapshotHash", snapshotHash)
                .param("expiresAt", expiresAt.toString())
                .param("now", now.toString())
                .update();
    }

    public void markPrepared(
            String executionId,
            String snapshotId,
            Instant now
    ) {
        jdbc.sql("""
                UPDATE tool_execution
                SET snapshot_id = :snapshotId, phase = 'prepared',
                    version = version + 1, updated_at = :now
                WHERE execution_id = :executionId AND phase = 'claimed'
                """)
                .param("snapshotId", snapshotId)
                .param("now", now.toString())
                .param("executionId", executionId)
                .update();
    }

    public void insertApproval(
            String approvalId,
            String executionId,
            String snapshotHash,
            String impact,
            RiskLevel riskLevel,
            Instant expiresAt,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO tool_approval_request(
                    approval_id, execution_id, snapshot_hash, status,
                    impact_statement, risk_level, version, created_at, expires_at
                ) VALUES (
                    :approvalId, :executionId, :snapshotHash, 'waiting',
                    :impact, :riskLevel, 1, :now, :expiresAt
                )
                """)
                .param("approvalId", approvalId)
                .param("executionId", executionId)
                .param("snapshotHash", snapshotHash)
                .param("impact", impact)
                .param("riskLevel", riskLevel.name().toLowerCase())
                .param("now", now.toString())
                .param("expiresAt", expiresAt.toString())
                .update();
        jdbc.sql("""
                UPDATE tool_execution
                SET approval_id = :approvalId, phase = 'awaiting_approval',
                    version = version + 1, updated_at = :now
                WHERE execution_id = :executionId AND phase = 'prepared'
                """)
                .param("approvalId", approvalId)
                .param("now", now.toString())
                .param("executionId", executionId)
                .update();
    }

    public Optional<ApprovalRow> findApproval(String approvalId) {
        return jdbc.sql("""
                SELECT a.*, e.tool_name, e.execution_id, e.conversation_id
                FROM tool_approval_request a
                JOIN tool_execution e ON e.execution_id = a.execution_id
                WHERE a.approval_id = :approvalId
                """)
                .param("approvalId", approvalId)
                .query((rs, rowNum) -> new ApprovalRow(
                        rs.getString("approval_id"),
                        rs.getString("execution_id"),
                        rs.getString("conversation_id"),
                        rs.getString("tool_name"),
                        rs.getString("snapshot_hash"),
                        rs.getString("status"),
                        rs.getString("decision_key"),
                        rs.getLong("version"),
                        Instant.parse(rs.getString("expires_at"))
                ))
                .optional();
    }

    public Optional<ExecutionContextRow> executionContextForApproval(
            String approvalId
    ) {
        return jdbc.sql("""
                SELECT e.conversation_id, e.turn_id, e.run_id, e.round_id,
                       e.tool_call_id
                FROM tool_approval_request a
                JOIN tool_execution e ON e.execution_id = a.execution_id
                WHERE a.approval_id = :approvalId
                """)
                .param("approvalId", approvalId)
                .query((rs, rowNum) -> new ExecutionContextRow(
                        rs.getString("conversation_id"),
                        rs.getString("turn_id"),
                        rs.getString("run_id"),
                        rs.getString("round_id"),
                        rs.getString("tool_call_id")
                ))
                .optional();
    }

    public boolean resolveApproval(
            String approvalId,
            String snapshotHash,
            long expectedVersion,
            String decisionKey,
            String decisionBy,
            boolean approved,
            Instant now
    ) {
        return jdbc.sql("""
                UPDATE tool_approval_request
                SET status = :status, decision_key = :decisionKey,
                    decision_by = :decisionBy, decided_at = :now,
                    version = version + 1
                WHERE approval_id = :approvalId
                  AND snapshot_hash = :snapshotHash
                  AND version = :expectedVersion
                  AND status = 'waiting'
                  AND expires_at > :now
                """)
                .param("status", approved ? "approved" : "rejected")
                .param("decisionKey", decisionKey)
                .param("decisionBy", decisionBy)
                .param("now", now.toString())
                .param("approvalId", approvalId)
                .param("snapshotHash", snapshotHash)
                .param("expectedVersion", expectedVersion)
                .update() == 1;
    }

    public void markRejected(String executionId, Instant now) {
        updatePhase(executionId, "awaiting_approval", "rejected", now);
    }

    public void markExpired(String approvalId, String executionId, Instant now) {
        jdbc.sql("""
                UPDATE tool_approval_request
                SET status = 'expired', decided_at = :now, version = version + 1
                WHERE approval_id = :approvalId AND status = 'waiting'
                """)
                .param("now", now.toString())
                .param("approvalId", approvalId)
                .update();
        updatePhase(executionId, "awaiting_approval", "expired", now);
    }

    public boolean markExecuting(String executionId, Instant now) {
        return jdbc.sql("""
                UPDATE tool_execution
                SET phase = 'executing', version = version + 1, updated_at = :now
                WHERE execution_id = :executionId
                  AND phase IN ('prepared', 'awaiting_approval')
                """)
                .param("now", now.toString())
                .param("executionId", executionId)
                .update() == 1;
    }

    public void markVerifying(String executionId, Instant now) {
        updatePhase(executionId, "executing", "verifying", now);
    }

    public void complete(
            String executionId,
            String phase,
            ToolOutcome.Kind outcomeKind,
            String outputJson,
            String errorCode,
            String errorMessage,
            List<VerificationResult.Evidence> evidence,
            Instant now
    ) {
        jdbc.sql("""
                UPDATE tool_execution
                SET phase = :phase, outcome_kind = :outcomeKind,
                    output_json = :outputJson, error_code = :errorCode,
                    error_message = :errorMessage,
                    version = version + 1, updated_at = :now
                WHERE execution_id = :executionId
                  AND phase IN (
                      'executing', 'verifying', 'claimed',
                      'prepared', 'awaiting_approval'
                  )
                """)
                .param("phase", phase)
                .param("outcomeKind", outcomeKind.name().toLowerCase())
                .param("outputJson", outputJson, Types.VARCHAR)
                .param("errorCode", errorCode, Types.VARCHAR)
                .param("errorMessage", errorMessage, Types.VARCHAR)
                .param("now", now.toString())
                .param("executionId", executionId)
                .update();
        for (int index = 0; index < evidence.size(); index++) {
            VerificationResult.Evidence item = evidence.get(index);
            jdbc.sql("""
                    INSERT INTO tool_evidence(
                        evidence_id, execution_id, ordinal, kind,
                        reference, summary, created_at
                    ) VALUES (
                        :evidenceId, :executionId, :ordinal, :kind,
                        :reference, :summary, :now
                    )
                    """)
                    .param("evidenceId", "evidence_" + java.util.UUID.randomUUID()
                            .toString().replace("-", ""))
                    .param("executionId", executionId)
                    .param("ordinal", index)
                    .param("kind", item.kind())
                    .param("reference", item.reference(), Types.VARCHAR)
                    .param("summary", item.summary())
                    .param("now", now.toString())
                    .update();
        }
    }

    public void storeOutputPayload(
            String executionId,
            String objectRef,
            String mediaType,
            String contentHash,
            long byteCount,
            int characterCount,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO tool_output_payload(
                    execution_id, object_ref, media_type, content_hash,
                    byte_count, character_count, created_at
                ) VALUES (
                    :executionId, :objectRef, :mediaType, :contentHash,
                    :byteCount, :characterCount, :now
                )
                ON CONFLICT(execution_id) DO NOTHING
                """)
                .param("executionId", executionId)
                .param("objectRef", objectRef)
                .param("mediaType", mediaType)
                .param("contentHash", contentHash)
                .param("byteCount", byteCount)
                .param("characterCount", characterCount)
                .param("now", now.toString())
                .update();
    }

    public Optional<OutputPayload> findOutputPayload(
            String conversationId,
            String executionId
    ) {
        return jdbc.sql("""
                SELECT p.execution_id, p.object_ref, p.media_type,
                       p.content_hash, p.byte_count, p.character_count
                FROM tool_output_payload p
                JOIN tool_execution e
                  ON e.execution_id = p.execution_id
                WHERE p.execution_id = :executionId
                  AND e.conversation_id = :conversationId
                """)
                .param("executionId", executionId)
                .param("conversationId", conversationId)
                .query((rs, rowNum) -> new OutputPayload(
                        rs.getString("execution_id"),
                        rs.getString("object_ref"),
                        rs.getString("media_type"),
                        rs.getString("content_hash"),
                        rs.getLong("byte_count"),
                        rs.getInt("character_count")
                ))
                .optional();
    }

    public SnapshotRow snapshot(String executionId) {
        return jdbc.sql("""
                SELECT * FROM operation_snapshot
                WHERE execution_id = :executionId
                """)
                .param("executionId", executionId)
                .query((rs, rowNum) -> new SnapshotRow(
                        rs.getString("snapshot_id"),
                        rs.getString("snapshot_hash"),
                        rs.getString("manifest_hash"),
                        rs.getString("normalized_input_json"),
                        rs.getString("resources_json"),
                        Instant.parse(rs.getString("expires_at"))
                ))
                .single();
    }

    public int reconcileInterrupted(Instant now) {
        int unknown = jdbc.sql("""
                UPDATE tool_execution
                SET phase = 'outcome_unknown',
                    outcome_kind = 'outcome_unknown',
                    error_code = 'process_restarted_during_execution',
                    error_message = '进程在执行或核验期间中断，需要按证据人工核对',
                    version = version + 1,
                    updated_at = :now
                WHERE phase IN ('executing', 'verifying')
                """)
                .param("now", now.toString())
                .update();
        int failedClaims = jdbc.sql("""
                UPDATE tool_execution
                SET phase = 'failed',
                    outcome_kind = 'failed',
                    error_code = 'process_restarted_before_snapshot',
                    error_message = '进程在操作快照提交前中断，请创建新的 toolCall',
                    version = version + 1,
                    updated_at = :now
                WHERE phase = 'claimed'
                """)
                .param("now", now.toString())
                .update();
        int failedPrepared = jdbc.sql("""
                UPDATE tool_execution
                SET phase = 'failed',
                    outcome_kind = 'failed',
                    error_code = 'process_restarted_before_execution',
                    error_message = '进程在只读执行开始前中断，请创建新的 toolCall',
                    version = version + 1,
                    updated_at = :now
                WHERE phase = 'prepared'
                """)
                .param("now", now.toString())
                .update();
        return unknown + failedClaims + failedPrepared;
    }

    private void updatePhase(
            String executionId,
            String expected,
            String phase,
            Instant now
    ) {
        jdbc.sql("""
                UPDATE tool_execution
                SET phase = :phase, version = version + 1, updated_at = :now
                WHERE execution_id = :executionId AND phase = :expected
                """)
                .param("phase", phase)
                .param("now", now.toString())
                .param("executionId", executionId)
                .param("expected", expected)
                .update();
    }

    private RuntimeResult mapResult(java.sql.ResultSet rs, int rowNum)
            throws java.sql.SQLException {
        return new RuntimeResult(
                rs.getString("execution_id"),
                rs.getString("tool_call_id"),
                rs.getString("tool_name"),
                rs.getString("phase"),
                rs.getString("snapshot_id"),
                rs.getString("approval_id"),
                rs.getString("snapshot_hash"),
                rs.getString("impact_statement"),
                rs.getString("outcome_kind"),
                rs.getString("error_code"),
                rs.getString("error_message"),
                rs.getLong("version"),
                Instant.parse(rs.getString("updated_at"))
        );
    }

    public record ApprovalRow(
            String approvalId,
            String executionId,
            String conversationId,
            String toolName,
            String snapshotHash,
            String status,
            String decisionKey,
            long version,
            Instant expiresAt
    ) {
    }

    public record ExecutionContextRow(
            String conversationId,
            String turnId,
            String runId,
            String roundId,
            String toolCallId
    ) {
    }

    public record ModelExposure(
            String exposureId,
            String contextHash,
            String capabilityLeaseHash,
            String toolName,
            String manifestHash
    ) {
    }

    public record SnapshotRow(
            String snapshotId,
            String snapshotHash,
            String manifestHash,
            String normalizedInputJson,
            String resourcesJson,
            Instant expiresAt
    ) {
    }

    public record OutputPayload(
            String executionId,
            String objectRef,
            String mediaType,
            String contentHash,
            long byteCount,
            int characterCount
    ) {
    }
}
