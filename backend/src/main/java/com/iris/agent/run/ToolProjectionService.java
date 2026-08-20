package com.iris.agent.run;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.ModelAttemptRepository.RoundToolCall;
import com.iris.agent.run.RunRoundRepository.RoundRow;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.tools.core.ToolExecutionViews.RuntimeResult;
import com.iris.tools.core.ToolRegistry;
import com.iris.tools.core.ToolRuntimeRepository;
import com.iris.conversation.application.ConversationEventAppender;
import com.iris.conversation.application.ConversationEventAppender.EventDraft;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.sql.Types;

@Service
public class ToolProjectionService {
    private static final Logger LOGGER = LoggerFactory.getLogger(
            ToolProjectionService.class
    );

    private static final int ARGUMENTS_SUMMARY_MAX_LENGTH = 160;

    private final JdbcClient jdbc;
    private final RunRoundRepository runs;
    private final ToolRuntimeRepository toolFacts;
    private final ToolRegistry toolRegistry;
    private final TransactionTemplate transactions;
    private final ObjectMapper objectMapper;
    private final ConversationEventAppender events;
    private final List<ToolProjectionEnricher> enrichers;
    private final Clock clock = Clock.systemUTC();

    public ToolProjectionService(
            JdbcClient jdbc,
            RunRoundRepository runs,
            ToolRuntimeRepository toolFacts,
            ToolRegistry toolRegistry,
            TransactionTemplate transactions,
            ObjectMapper objectMapper,
            ConversationEventAppender events,
            List<ToolProjectionEnricher> enrichers
    ) {
        this.jdbc = jdbc;
        this.runs = runs;
        this.toolFacts = toolFacts;
        this.toolRegistry = toolRegistry;
        this.transactions = transactions;
        this.objectMapper = objectMapper;
        this.events = events;
        this.enrichers = List.copyOf(enrichers);
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
            String inputRequestId = inputRequestId(result.executionId());
            if (inputRequestId != null) {
                projectUserInputAttention(
                        run,
                        round,
                        result,
                        inputRequestId
                );
            }
            ObjectNode artifactNode = projectPublishedArtifact(
                    run,
                    round,
                    call,
                    result
            );
            return new ProjectionEmission(
                    run,
                    projectionForTool(call.toolCallId()),
                    result.approvalId() == null
                            ? inputRequestId == null
                                    ? null
                                    : projectionForUserInput(inputRequestId)
                            : projectionForApproval(result.approvalId()),
                    artifactNode
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
        if (emission.artifactNode() != null) {
            emitRenderNode(emission.run(), emission.artifactNode());
        }
    }

    /** Projects a ToolRuntime execution owned by a Pipeline rather than a model Round. */
    public void projectPipeline(
            String pipelineRunId,
            String pipelineStepRunId,
            com.fasterxml.jackson.databind.JsonNode input,
            RuntimeResult result
    ) {
        RoundToolCall call = new RoundToolCall(
                result.toolCallId(),
                "host:" + pipelineStepRunId,
                result.toolName(),
                input,
                0,
                result.executionId()
        );
        RoundRow noRound = new RoundRow(
                null,
                pipelineRunId,
                0,
                RoundPhase.AWAITING_TOOLS,
                1,
                1
        );
        ProjectionEmission emission = transactions.execute(status -> {
            RunRow run = runs.findRun(pipelineRunId).orElseThrow();
            projectTool(run, noRound, call, result);
            if (result.approvalId() != null) {
                projectAttention(run, noRound, result);
            }
            String inputRequestId = inputRequestId(result.executionId());
            if (inputRequestId != null) {
                projectUserInputAttention(
                        run, noRound, result, inputRequestId
                );
            }
            ObjectNode artifactNode = projectPublishedArtifact(
                    run, noRound, call, result
            );
            return new ProjectionEmission(
                    run,
                    projectionForTool(call.toolCallId()),
                    result.approvalId() == null
                            ? inputRequestId == null
                                    ? null
                                    : projectionForUserInput(inputRequestId)
                            : projectionForApproval(result.approvalId()),
                    artifactNode
            );
        });
        if (emission == null) {
            throw new IllegalStateException(
                    "Pipeline Tool projection transaction returned no result"
            );
        }
        emitRenderNode(emission.run(), emission.toolNode());
        if (emission.attentionNode() != null) {
            emitAttention(emission.run(), emission.attentionNode());
        }
        if (emission.artifactNode() != null) {
            emitRenderNode(emission.run(), emission.artifactNode());
        }
    }

    private ObjectNode projectPublishedArtifact(
            RunRow run,
            RoundRow round,
            RoundToolCall call,
            RuntimeResult result
    ) {
        if (!("publish_artifact".equals(result.toolName())
                || "present_artifact".equals(result.toolName()))
                || !"succeeded".equals(result.phase())) {
            return null;
        }
        PublishedArtifact artifact = jdbc.sql("""
                SELECT a.artifact_id, v.artifact_version,
                       a.title, a.kind, v.byte_count
                FROM artifact_publication publication
                JOIN artifact a
                  ON a.artifact_id = publication.artifact_id
                JOIN artifact_version v
                  ON v.artifact_id = publication.artifact_id
                 AND v.artifact_version = publication.artifact_version
                WHERE publication.publication_execution_id = :executionId
                  AND publication.visibility = 'user_timeline'
                """)
                .param("executionId", result.executionId())
                .query((rs, row) -> new PublishedArtifact(
                        rs.getString("artifact_id"),
                        rs.getInt("artifact_version"),
                        rs.getString("title"),
                        rs.getString("kind"),
                        rs.getLong("byte_count")
                ))
                .optional()
                .orElse(null);
        if (artifact == null) {
            return null;
        }
        String existing = jdbc.sql("""
                SELECT node_id
                FROM artifact_render_link
                WHERE artifact_id = :artifactId
                  AND artifact_version = :version
                  AND visibility = 'user_timeline'
                """)
                .param("artifactId", artifact.artifactId())
                .param("version", artifact.version())
                .query(String.class)
                .optional()
                .orElse(null);
        if (existing != null) {
            return null;
        }

        Instant now = clock.instant();
        String nodeId = id("node");
        int ordinal = nextOrdinal(run.turnId());
        ObjectNode projection = base(
                nodeId,
                run,
                round,
                ordinal,
                1,
                now.toString(),
                now
        );
        projection.put("type", "artifact");
        projection.put("status", "available");
        projection.put("artifactId", artifact.artifactId());
        projection.put(
                "artifactRef",
                "artifact://" + artifact.artifactId()
                        + "@" + artifact.version()
        );
        projection.put("kind", visibleArtifactKind(artifact.kind()));
        projection.put("title", artifact.title());
        projection.put("byteCount", artifact.byteCount());
        projection.put(
                "previewRef",
                "/api/v1/artifacts/" + artifact.artifactId()
                        + "/versions/" + artifact.version() + "/preview"
        );
        projection.put(
                "downloadRef",
                "/api/v1/artifacts/" + artifact.artifactId()
                        + "/versions/" + artifact.version() + "/content"
        );
        projection.put("sourceToolCallId", call.toolCallId());
        insertNode(
                nodeId,
                run,
                round,
                "artifact",
                "available",
                ordinal,
                1,
                projection,
                now
        );
        jdbc.sql("""
                INSERT INTO artifact_render_link (
                  artifact_id, artifact_version, visibility,
                  publication_execution_id, node_id
                ) VALUES (
                  :artifactId, :version, 'user_timeline',
                  :executionId, :nodeId
                )
                """)
                .param("artifactId", artifact.artifactId())
                .param("version", artifact.version())
                .param("executionId", result.executionId())
                .param("nodeId", nodeId)
                .update();
        return projection;
    }

    private String visibleArtifactKind(String kind) {
        return switch (kind) {
            case "document", "pdf", "html", "code" -> "document";
            case "spreadsheet", "data" -> "spreadsheet";
            case "image" -> "image";
            case "archive" -> "archive";
            default -> "other";
        };
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

    private String inputRequestId(String executionId) {
        return jdbc.sql("""
                SELECT input_request_id
                FROM tool_user_input_request
                WHERE execution_id = :executionId
                """)
                .param("executionId", executionId)
                .query(String.class)
                .optional()
                .orElse(null);
    }

    private ObjectNode projectionForUserInput(String inputRequestId) {
        return projectionByNodeId(jdbc.sql("""
                SELECT node_id FROM user_input_attention_link
                WHERE input_request_id = :inputRequestId
                """)
                .param("inputRequestId", inputRequestId)
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
        projection.put("toolName", result.toolName());
        if (!result.toolName().equals(call.toolName())) {
            projection.put("proxyToolName", call.toolName());
        }
        projection.put("catalogPath", catalogPathFor(result.toolName()));
        String summary = toolSummary(result);
        projection.put("summary", summary);
        if ("succeeded".equals(result.phase())) {
            projection.put(
                    "resultRef",
                    "tool-result://" + result.executionId()
            );
        }
        if (result.message() != null && !result.message().isBlank()) {
            if (!result.message().equals(summary)) {
                projection.put("evidenceSummary", result.message());
            }
        }
        long durationMs = Duration.between(
                result.createdAt(),
                result.updatedAt()
        ).toMillis();
        projection.put("durationMs", Math.max(0, durationMs));
        if (call.arguments() != null && !call.arguments().isNull()) {
            projection.put("args", compactJson(call.arguments()));
        }
        enrichToolProjection(
                projection,
                run.conversationId(),
                call,
                result
        );

        String nodeType = projection.path("type").asText("tool");
        String nodeStatus = projection.path("status").asText(
                visibleToolStatus(result.phase())
        );

        if (existing == null) {
            insertNode(
                    nodeId,
                    run,
                    round,
                    nodeType,
                    nodeStatus,
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
            upsertChildRunLink(nodeId, projection);
        } else {
            updateNode(
                    nodeId,
                    nodeType,
                    nodeStatus,
                    version,
                    projection,
                    now
            );
            upsertChildRunLink(nodeId, projection);
        }
    }

    /**
     * 能力树目录路径投影（docs/36 M16）：真相源是 ToolRegistry 的注册绑定；
     * 查不到（外部/已卸载工具）投 null，前端缺失不渲染，fail-closed。
     */
    private String catalogPathFor(String toolName) {
        try {
            return toolRegistry.find(toolName)
                    .map(ToolRegistry.ToolBinding::capabilityPath)
                    .orElse(null);
        } catch (RuntimeException exception) {
            LOGGER.warn(
                    "Tool capability path lookup failed for {}",
                    toolName,
                    exception
            );
            return null;
        }
    }

    private void upsertChildRunLink(String nodeId, ObjectNode projection) {
        String childRunId = projection.path("childRunId").asText(null);
        if (childRunId == null || childRunId.isBlank()) {
            return;
        }
        jdbc.sql("""
                INSERT INTO child_run_render_link(child_run_id, node_id)
                VALUES (:childRunId, :nodeId)
                ON CONFLICT(child_run_id) DO UPDATE SET node_id = excluded.node_id
                """)
                .param("childRunId", childRunId)
                .param("nodeId", nodeId)
                .update();
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
        attachToolArguments(approvalView, result);
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
            updateNode(nodeId, "attention", status, version, projection, now);
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

    private void projectUserInputAttention(
            RunRow run,
            RoundRow round,
            RuntimeResult result,
            String inputRequestId
    ) {
        AttentionLink link = jdbc.sql("""
                SELECT attention_id, node_id
                FROM user_input_attention_link
                WHERE input_request_id = :inputRequestId
                """)
                .param("inputRequestId", inputRequestId)
                .query((rs, rowNum) -> new AttentionLink(
                        rs.getString("attention_id"),
                        rs.getString("node_id")
                ))
                .optional()
                .orElse(null);
        UserInputProjection input = jdbc.sql("""
                SELECT question, options_json, recommended_option_id,
                       status, answer_option_id, answer_value,
                       version, expires_at, resolved_at
                FROM tool_user_input_request
                WHERE input_request_id = :inputRequestId
                """)
                .param("inputRequestId", inputRequestId)
                .query((rs, rowNum) -> new UserInputProjection(
                        rs.getString("question"),
                        rs.getString("options_json"),
                        rs.getString("recommended_option_id"),
                        rs.getString("status"),
                        rs.getString("answer_option_id"),
                        rs.getString("answer_value"),
                        rs.getLong("version"),
                        rs.getString("expires_at"),
                        rs.getString("resolved_at")
                ))
                .single();
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
        String status = switch (input.status()) {
            case "waiting" -> "waiting";
            case "expired" -> "expired";
            case "cancelled" -> "cancelled";
            default -> "resolved";
        };

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
        projection.put("subtype", "clarification");
        projection.put("impact", input.question());
        projection.put("expiresAt", input.expiresAt());
        if (input.resolvedAt() != null) {
            projection.put("resolvedAt", input.resolvedAt());
        }
        ObjectNode inputView = projection.putObject("input");
        inputView.put("inputRequestId", inputRequestId);
        inputView.put("question", input.question());
        inputView.put("version", input.version());
        ArrayNode options;
        try {
            options = (ArrayNode) objectMapper.readTree(input.optionsJson());
        } catch (com.fasterxml.jackson.core.JsonProcessingException exception) {
            throw new IllegalStateException(
                    "Stored user input options are invalid JSON",
                    exception
            );
        }
        ArrayNode visibleOptions = inputView.putArray("options");
        ArrayNode actions = projection.putArray("actions");
        for (com.fasterxml.jackson.databind.JsonNode raw : options) {
            String optionId = raw.path("id").asText();
            String label = raw.path("label").asText();
            boolean recommended = optionId.equals(
                    input.recommendedOptionId()
            );
            ObjectNode option = visibleOptions.addObject();
            option.put("id", optionId);
            option.put("label", label);
            option.put("recommended", recommended);
            if (raw.hasNonNull("description")) {
                option.put("description", raw.path("description").asText());
            }
            if ("waiting".equals(status)) {
                action(
                        actions,
                        optionId,
                        label,
                        recommended ? "primary" : "secondary"
                );
            }
        }
        if (input.answerValue() != null) {
            inputView.put("answer", input.answerValue());
        }
        if (input.answerOptionId() != null) {
            inputView.put("answerOptionId", input.answerOptionId());
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
            insertAttentionProjection(
                    attentionId,
                    run,
                    status,
                    projection,
                    now
            );
            jdbc.sql("""
                    INSERT INTO user_input_attention_link(
                        input_request_id, attention_id, node_id
                    ) VALUES (
                        :inputRequestId, :attentionId, :nodeId
                    )
                    """)
                    .param("inputRequestId", inputRequestId)
                    .param("attentionId", attentionId)
                    .param("nodeId", nodeId)
                    .update();
        } else {
            updateNode(nodeId, "attention", status, version, projection, now);
            updateAttentionProjection(
                    attentionId,
                    status,
                    projection,
                    now
            );
        }
    }

    private void insertAttentionProjection(
            String attentionId,
            RunRow run,
            String status,
            ObjectNode projection,
            Instant now
    ) {
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
    }

    private void updateAttentionProjection(
            String attentionId,
            String status,
            ObjectNode projection,
            Instant now
    ) {
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
        if (round.roundId() == null) {
            node.putNull("roundId");
            node.put("pipelineStepRunId", pipelineStepRunId(run.runId()));
        } else {
            node.put("roundId", round.roundId());
            node.putNull("pipelineStepRunId");
        }
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
                    :roundId, :pipelineStepRunId, :type, :status,
                    NULL, :ordinal, :rendererKey, :version,
                    NULL, :projection, :now, :now
                )
                """)
                .param("nodeId", nodeId)
                .param("conversationId", run.conversationId())
                .param("branchId", run.branchId())
                .param("turnId", run.turnId())
                .param("runId", run.runId())
                .param("roundId", round.roundId(), Types.VARCHAR)
                .param(
                        "pipelineStepRunId",
                        round.roundId() == null
                                ? pipelineStepRunId(run.runId()) : null,
                        Types.VARCHAR
                )
                .param("type", type)
                .param("status", status)
                .param("ordinal", ordinal)
                .param(
                        "rendererKey",
                        projection.path("rendererKey").asText("default")
                )
                .param("version", version)
                .param("projection", projection.toString())
                .param("now", now.toString())
                .update();
    }

    private String pipelineStepRunId(String pipelineRunId) {
        return jdbc.sql("""
                SELECT step_run_id FROM pipeline_step_run
                WHERE pipeline_run_id = :runId
                  AND phase = 'waiting_tool'
                ORDER BY step_index
                LIMIT 1
                """)
                .param("runId", pipelineRunId)
                .query(String.class)
                .optional()
                .orElse(null);
    }

    private void updateNode(
            String nodeId,
            String type,
            String status,
            int version,
            ObjectNode projection,
            Instant now
    ) {
        int updated = jdbc.sql("""
                UPDATE render_node_projection
                SET node_type = :type, node_status = :status, version = :version,
                    renderer_key = :rendererKey,
                    projection_json = :projection, updated_at = :now
                WHERE node_id = :nodeId AND version = :expectedVersion
                """)
                .param("type", type)
                .param("status", status)
                .param("version", version)
                .param(
                        "rendererKey",
                        projection.path("rendererKey").asText("default")
                )
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
            case "awaiting_approval", "awaiting_input", "verifying" ->
                    "verifying";
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
        if (result.terminal()
                && result.message() != null
                && !result.message().isBlank()) {
            return result.message();
        }
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
            case "awaiting_input" -> "等待用户回答后继续";
            case "outcome_unknown" -> "结果未知，需要先核验";
            default -> "工具正在处理";
        };
    }

    private String compactJson(com.fasterxml.jackson.databind.JsonNode node) {
        try {
            return objectMapper.writeValueAsString(node);
        } catch (com.fasterxml.jackson.core.JsonProcessingException exception) {
            return node.toString();
        }
    }

    private void attachToolArguments(
            ObjectNode approvalView,
            RuntimeResult result
    ) {
        ToolRuntimeRepository.SnapshotRow snapshot;
        try {
            snapshot = toolFacts.snapshot(result.executionId());
        } catch (RuntimeException exception) {
            LOGGER.warn(
                    "Approval projection could not load operation snapshot for {}",
                    result.executionId(),
                    exception
            );
            return;
        }
        if (snapshot == null || snapshot.normalizedInputJson() == null) {
            return;
        }
        JsonNode parameters;
        try {
            parameters = objectMapper.readTree(snapshot.normalizedInputJson());
        } catch (JsonProcessingException exception) {
            LOGGER.warn(
                    "Approval projection could not parse normalized input for {}",
                    result.executionId(),
                    exception
            );
            return;
        }
        if (parameters.isNull()) {
            return;
        }
        approvalView.set("parameters", parameters);
        String summary = compactJsonSummary(parameters, ARGUMENTS_SUMMARY_MAX_LENGTH);
        if (summary != null && !summary.isBlank()) {
            approvalView.put("argumentsSummary", summary);
        }
    }

    private String compactJsonSummary(JsonNode value, int maxLength) {
        if (value == null) {
            return null;
        }
        String compact = value.toString();
        if (compact.length() <= maxLength) {
            return compact;
        }
        int cut = Math.max(0, maxLength - 3);
        if (cut >= compact.length()) {
            cut = compact.length() - 3;
        }
        if (cut < 0) {
            cut = 0;
        }
        return compact.substring(0, cut) + "...";
    }

    private void enrichToolProjection(
            ObjectNode projection,
            String conversationId,
            RoundToolCall call,
            RuntimeResult result
    ) {
        for (ToolProjectionEnricher enricher : enrichers) {
            if (!enricher.supports(result.toolName())) {
                continue;
            }
            try {
                enricher.enrich(projection, conversationId, result);
            } catch (RuntimeException exception) {
                LOGGER.warn(
                        "Tool presentation enrichment failed for {} ({})",
                        result.toolName(),
                        result.executionId(),
                        exception
                );
                projection.put("rendererKey", "default");
                projection.put("presentationUnavailable", true);
            }
        }
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

    private record UserInputProjection(
            String question,
            String optionsJson,
            String recommendedOptionId,
            String status,
            String answerOptionId,
            String answerValue,
            long version,
            String expiresAt,
            String resolvedAt
    ) {
    }

    private record ProjectionEmission(
            RunRow run,
            ObjectNode toolNode,
            ObjectNode attentionNode,
            ObjectNode artifactNode
    ) {
    }

    private record PublishedArtifact(
            String artifactId,
            int version,
            String title,
            String kind,
            long byteCount
    ) {
    }
}
