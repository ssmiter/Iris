package com.iris.agent.run;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.ModelAttemptRepository.RoundToolCall;
import com.iris.agent.run.RunRoundRepository.RoundRow;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.tools.core.ToolExecutionViews.RuntimeResult;
import com.iris.conversation.application.ConversationEventAppender;
import com.iris.conversation.application.ConversationEventAppender.EventDraft;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Instant;
import java.util.UUID;

@Service
public class ToolProjectionService {
    private final JdbcClient jdbc;
    private final RunRoundRepository runs;
    private final TransactionTemplate transactions;
    private final ObjectMapper objectMapper;
    private final ConversationEventAppender events;
    private final Clock clock = Clock.systemUTC();

    public ToolProjectionService(
            JdbcClient jdbc,
            RunRoundRepository runs,
            TransactionTemplate transactions,
            ObjectMapper objectMapper,
            ConversationEventAppender events
    ) {
        this.jdbc = jdbc;
        this.runs = runs;
        this.transactions = transactions;
        this.objectMapper = objectMapper;
        this.events = events;
    }

    public void project(
            String roundId,
            RoundToolCall call,
            RuntimeResult result
    ) {
        ProjectionEmission emission = transactions.execute(status -> {
            RoundRow round = runs.findRound(roundId).orElseThrow();
            RunRow run = runs.findRun(round.runId()).orElseThrow();
            projectTool(run, round, call, result);
            if (result.approvalId() != null) {
                projectAttention(run, round, result);
            }
            return new ProjectionEmission(
                    run,
                    projectionForTool(call.toolCallId()),
                    result.approvalId() == null
                            ? null
                            : projectionForApproval(result.approvalId())
            );
        });
        if (emission == null) {
            throw new IllegalStateException(
                    "Tool projection transaction returned no result"
            );
        }
        emitRenderNode(emission.run(), emission.toolNode());
        if (emission.attentionNode() != null) {
            emitAttention(emission.run(), emission.attentionNode());
        }
    }

    private ObjectNode projectionForTool(String toolCallId) {
        return projectionByNodeId(jdbc.sql("""
                SELECT node_id FROM tool_render_link
                WHERE tool_call_id = :toolCallId
                """)
                .param("toolCallId", toolCallId)
                .query(String.class)
                .single());
    }

    private ObjectNode projectionForApproval(String approvalId) {
        return projectionByNodeId(jdbc.sql("""
                SELECT node_id FROM approval_attention_link
                WHERE approval_id = :approvalId
                """)
                .param("approvalId", approvalId)
                .query(String.class)
                .single());
    }

    private ObjectNode projectionByNodeId(String nodeId) {
        String json = jdbc.sql("""
                SELECT projection_json FROM render_node_projection
                WHERE node_id = :nodeId
                """)
                .param("nodeId", nodeId)
                .query(String.class)
                .single();
        try {
            return (ObjectNode) objectMapper.readTree(json);
        } catch (com.fasterxml.jackson.core.JsonProcessingException exception) {
            throw new IllegalStateException(
                    "Stored render projection is invalid JSON",
                    exception
            );
        }
    }

    private void emitRenderNode(RunRow run, ObjectNode node) {
        ObjectNode payload = objectMapper.createObjectNode();
        payload.set("node", node);
        events.append(new EventDraft(
                node.path("version").asLong() == 1
                        ? "render_node.added"
                        : "render_node.updated",
                run.conversationId(),
                run.branchId(),
                run.turnId(),
                run.runId(),
                "render_node",
                node.path("nodeId").asText(),
                node.path("version").asLong(),
                null,
                run.runId(),
                payload
        ));
    }

    private void emitAttention(RunRow run, ObjectNode node) {
        ObjectNode payload = objectMapper.createObjectNode();
        payload.set("attention", node);
        payload.set("node", node);
        events.append(new EventDraft(
                node.path("version").asLong() == 1
                        ? "attention.requested"
                        : "attention.updated",
                run.conversationId(),
                run.branchId(),
                run.turnId(),
                run.runId(),
                "attention",
                node.path("attentionId").asText(),
                node.path("version").asLong(),
                null,
                run.runId(),
                payload
        ));
    }

    private void projectTool(
            RunRow run,
            RoundRow round,
            RoundToolCall call,
            RuntimeResult result
    ) {
        String existingNodeId = jdbc.sql("""
                SELECT node_id FROM tool_render_link
                WHERE tool_call_id = :toolCallId
                """)
                .param("toolCallId", call.toolCallId())
                .query(String.class)
                .optional()
                .orElse(null);
        Instant now = clock.instant();
        String nodeId = existingNodeId == null ? id("node") : existingNodeId;
        ExistingNode existing = existingNodeId == null
                ? null
                : existingNode(existingNodeId);
        int ordinal = existing == null
                ? nextOrdinal(run.turnId())
                : existing.ordinal();
        int version = existing == null ? 1 : existing.version() + 1;
        String createdAt = existing == null
                ? now.toString()
                : existing.createdAt();

        ObjectNode projection = base(
                nodeId,
                run,
                round,
                ordinal,
                version,
                createdAt,
                now
        );
        projection.put("type", "tool");
        projection.put("status", visibleToolStatus(result.phase()));
        projection.put("toolCallId", call.toolCallId());
        projection.put("toolExecutionId", result.executionId());
        projection.put("toolName", call.toolName());
        projection.put("summary", toolSummary(result));
        if ("succeeded".equals(result.phase())) {
            projection.put(
                    "resultRef",
                    "tool-result://" + result.executionId()
            );
        }
        if (result.message() != null && !result.message().isBlank()) {
            projection.put("evidenceSummary", result.message());
        }

        if (existing == null) {
            insertNode(
                    nodeId,
                    run,
                    round,
                    "tool",
                    visibleToolStatus(result.phase()),
                    ordinal,
                    version,
                    projection,
                    now
            );
            jdbc.sql("""
                    INSERT INTO tool_render_link(tool_call_id, node_id)
                    VALUES (:toolCallId, :nodeId)
                    """)
                    .param("toolCallId", call.toolCallId())
                    .param("nodeId", nodeId)
                    .update();
        } else {
            updateNode(
                    nodeId,
                    visibleToolStatus(result.phase()),
                    version,
                    projection,
                    now
            );
        }
    }

    private void projectAttention(
            RunRow run,
            RoundRow round,
            RuntimeResult result
    ) {
        AttentionLink link = jdbc.sql("""
                SELECT attention_id, node_id
                FROM approval_attention_link
                WHERE approval_id = :approvalId
                """)
                .param("approvalId", result.approvalId())
                .query((rs, rowNum) -> new AttentionLink(
                        rs.getString("attention_id"),
                        rs.getString("node_id")
                ))
                .optional()
                .orElse(null);
        Instant now = clock.instant();
        String attentionId = link == null ? id("attention") : link.attentionId();
        String nodeId = link == null ? id("node") : link.nodeId();
        ExistingNode existing = link == null ? null : existingNode(nodeId);
        int ordinal = existing == null
                ? nextOrdinal(run.turnId())
                : existing.ordinal();
        int version = existing == null ? 1 : existing.version() + 1;
        String createdAt = existing == null
                ? now.toString()
                : existing.createdAt();
        String status = visibleAttentionStatus(result.phase());
        ApprovalProjection approval = jdbc.sql("""
                SELECT version, status, risk_level, expires_at
                FROM tool_approval_request
                WHERE approval_id = :approvalId
                """)
                .param("approvalId", result.approvalId())
                .query((rs, rowNum) -> new ApprovalProjection(
                        rs.getLong("version"),
                        rs.getString("status"),
                        rs.getString("risk_level"),
                        rs.getString("expires_at")
                ))
                .single();

        ObjectNode projection = base(
                nodeId,
                run,
                round,
                ordinal,
                version,
                createdAt,
                now
        );
        projection.put("type", "attention");
        projection.put("status", status);
        projection.put("attentionId", attentionId);
        projection.put("subtype", "approval");
        projection.put(
                "impact",
                result.impactStatement() == null
                        ? "This action changes external state."
                        : result.impactStatement()
        );
        ObjectNode approvalView = projection.putObject("approval");
        approvalView.put("approvalId", result.approvalId());
        approvalView.put("toolExecutionId", result.executionId());
        approvalView.put("toolCallId", result.toolCallId());
        approvalView.put("toolName", result.toolName());
        approvalView.put("operationSnapshotHash", result.snapshotHash());
        approvalView.put("riskLevel", approval.riskLevel());
        approvalView.put(
                "impactStatement",
                result.impactStatement() == null
                        ? "This action changes external state."
                        : result.impactStatement()
        );
        approvalView.put("status", approval.status());
        approvalView.put("version", approval.version());
        approvalView.put("expiresAt", approval.expiresAt());
        ArrayNode actions = projection.putArray("actions");
        if ("waiting".equals(status)) {
            action(actions, "approve", "批准", "primary");
            action(actions, "reject", "拒绝", "secondary");
        }

        if (existing == null) {
            insertNode(
                    nodeId,
                    run,
                    round,
                    "attention",
                    status,
                    ordinal,
                    version,
                    projection,
                    now
            );
            jdbc.sql("""
                    INSERT INTO attention_projection(
                        attention_id, conversation_id, branch_id, turn_id,
                        run_id, status, projection_json, version,
                        created_at, updated_at
                    ) VALUES (
                        :attentionId, :conversationId, :branchId, :turnId,
                        :runId, :status, :projection, 1,
                        :now, :now
                    )
                    """)
                    .param("attentionId", attentionId)
                    .param("conversationId", run.conversationId())
                    .param("branchId", run.branchId())
                    .param("turnId", run.turnId())
                    .param("runId", run.runId())
                    .param("status", status)
                    .param("projection", projection.toString())
                    .param("now", now.toString())
                    .update();
            jdbc.sql("""
                    INSERT INTO approval_attention_link(
                        approval_id, attention_id, node_id
                    ) VALUES (:approvalId, :attentionId, :nodeId)
                    """)
                    .param("approvalId", result.approvalId())
                    .param("attentionId", attentionId)
                    .param("nodeId", nodeId)
                    .update();
        } else {
            updateNode(nodeId, status, version, projection, now);
            jdbc.sql("""
                    UPDATE attention_projection
                    SET status = :status, projection_json = :projection,
                        version = version + 1, updated_at = :now
                    WHERE attention_id = :attentionId
                    """)
                    .param("status", status)
                    .param("projection", projection.toString())
                    .param("now", now.toString())
                    .param("attentionId", attentionId)
                    .update();
        }
    }

    private ObjectNode base(
            String nodeId,
            RunRow run,
            RoundRow round,
            int ordinal,
            int version,
            String createdAt,
            Instant now
    ) {
        ObjectNode node = objectMapper.createObjectNode();
        node.put("nodeId", nodeId);
        node.put("turnId", run.turnId());
        node.put("runId", run.runId());
        node.put("roundId", round.roundId());
        node.putNull("pipelineStepRunId");
        node.putNull("groupId");
        node.put("ordinal", ordinal);
        node.put("rendererKey", "default");
        node.put("version", version);
        node.put("createdAt", createdAt);
        node.put("updatedAt", now.toString());
        return node;
    }

    private void insertNode(
            String nodeId,
            RunRow run,
            RoundRow round,
            String type,
            String status,
            int ordinal,
            int version,
            ObjectNode projection,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO render_node_projection(
                    node_id, conversation_id, branch_id, turn_id, run_id,
                    round_id, pipeline_step_run_id, node_type, node_status,
                    group_id, ordinal, renderer_key, version,
                    final_content_hash, projection_json, created_at, updated_at
                ) VALUES (
                    :nodeId, :conversationId, :branchId, :turnId, :runId,
                    :roundId, NULL, :type, :status,
                    NULL, :ordinal, 'default', :version,
                    NULL, :projection, :now, :now
                )
                """)
                .param("nodeId", nodeId)
                .param("conversationId", run.conversationId())
                .param("branchId", run.branchId())
                .param("turnId", run.turnId())
                .param("runId", run.runId())
                .param("roundId", round.roundId())
                .param("type", type)
                .param("status", status)
                .param("ordinal", ordinal)
                .param("version", version)
                .param("projection", projection.toString())
                .param("now", now.toString())
                .update();
    }

    private void updateNode(
            String nodeId,
            String status,
            int version,
            ObjectNode projection,
            Instant now
    ) {
        int updated = jdbc.sql("""
                UPDATE render_node_projection
                SET node_status = :status, version = :version,
                    projection_json = :projection, updated_at = :now
                WHERE node_id = :nodeId AND version = :expectedVersion
                """)
                .param("status", status)
                .param("version", version)
                .param("projection", projection.toString())
                .param("now", now.toString())
                .param("nodeId", nodeId)
                .param("expectedVersion", version - 1)
                .update();
        if (updated != 1) {
            throw new IllegalStateException(
                    "Render node projection changed concurrently"
            );
        }
    }

    private ExistingNode existingNode(String nodeId) {
        return jdbc.sql("""
                SELECT ordinal, version, created_at
                FROM render_node_projection
                WHERE node_id = :nodeId
                """)
                .param("nodeId", nodeId)
                .query((rs, rowNum) -> new ExistingNode(
                        rs.getInt("ordinal"),
                        rs.getInt("version"),
                        rs.getString("created_at")
                ))
                .single();
    }

    private int nextOrdinal(String turnId) {
        return jdbc.sql("""
                SELECT COALESCE(MAX(ordinal), -1) + 1
                FROM render_node_projection
                WHERE turn_id = :turnId
                """)
                .param("turnId", turnId)
                .query(Integer.class)
                .single();
    }

    private String visibleToolStatus(String phase) {
        return switch (phase) {
            case "claimed", "prepared" -> "queued";
            case "awaiting_approval", "verifying" -> "verifying";
            case "executing" -> "running";
            case "succeeded" -> "succeeded";
            case "outcome_unknown" -> "outcome_unknown";
            case "rejected", "expired", "failed" -> "failed";
            default -> "failed";
        };
    }

    private String visibleAttentionStatus(String phase) {
        return switch (phase) {
            case "awaiting_approval" -> "waiting";
            case "expired" -> "expired";
            case "rejected", "succeeded", "failed",
                 "outcome_unknown" -> "resolved";
            default -> "resolved";
        };
    }

    private String toolSummary(RuntimeResult result) {
        if (result.impactStatement() != null
                && !result.impactStatement().isBlank()) {
            return result.impactStatement();
        }
        if (result.message() != null && !result.message().isBlank()) {
            return result.message();
        }
        return switch (result.phase()) {
            case "succeeded" -> "工具执行完成";
            case "awaiting_approval" -> "等待批准后执行";
            case "outcome_unknown" -> "结果未知，需要先核验";
            default -> "工具正在处理";
        };
    }

    private void action(
            ArrayNode actions,
            String id,
            String label,
            String tone
    ) {
        ObjectNode action = actions.addObject();
        action.put("id", id);
        action.put("label", label);
        action.put("tone", tone);
    }

    private String id(String prefix) {
        return prefix + "_" + UUID.randomUUID().toString().replace("-", "");
    }

    private record ExistingNode(
            int ordinal,
            int version,
            String createdAt
    ) {
    }

    private record AttentionLink(
            String attentionId,
            String nodeId
    ) {
    }

    private record ApprovalProjection(
            long version,
            String status,
            String riskLevel,
            String expiresAt
    ) {
    }

    private record ProjectionEmission(
            RunRow run,
            ObjectNode toolNode,
            ObjectNode attentionNode
    ) {
    }
}
