package com.iris.agent.run;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.conversation.application.ConversationEventAppender;
import com.iris.conversation.application.ConversationEventAppender.EventDraft;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Instant;
import java.util.List;

/**
 * Keeps {@code run} render nodes in sync with their child Run lifecycle.
 *
 * <p>When a pipeline/agentic child Run changes phase, this service re-projects
 * the corresponding {@code type=run} node so the timeline header status and
 * progress summary stay consistent across SSE and hydration paths.
 */
@Service
public class ChildRunNodeProjectionService {
    private static final Logger LOGGER = LoggerFactory.getLogger(
            ChildRunNodeProjectionService.class
    );

    private final JdbcClient jdbc;
    private final RunRoundRepository runs;
    private final TransactionTemplate transactions;
    private final ObjectMapper objectMapper;
    private final ConversationEventAppender events;
    private final Clock clock = Clock.systemUTC();

    public ChildRunNodeProjectionService(
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

    /**
     * Refreshes every {@code run} node that points to {@code childRunId}.
     *
     * <p>Safe to call for any Run: if no render node references it, the call is a
     * no-op. This is invoked from {@link com.iris.conversation.application.RunEventEmitter}
     * after run.updated/run.settled so the parent timeline stays live.
     */
    public void updateForRun(String childRunId) {
        List<ChildRunNode> nodes = findNodes(childRunId);
        if (nodes.isEmpty()) {
            return;
        }
        ChildRunState state = state(childRunId);
        if (state == null) {
            LOGGER.warn("No child run state found for render node refresh: {}", childRunId);
            return;
        }
        for (ChildRunNode node : nodes) {
            reprojectNode(node, state);
        }
    }

    private List<ChildRunNode> findNodes(String childRunId) {
        return jdbc.sql("""
                SELECT n.node_id, n.run_id, n.version, n.ordinal, n.created_at,
                       n.projection_json
                FROM child_run_render_link link
                JOIN render_node_projection n ON n.node_id = link.node_id
                WHERE link.child_run_id = :childRunId
                """)
                .param("childRunId", childRunId)
                .query((rs, rowNum) -> new ChildRunNode(
                        rs.getString("node_id"),
                        rs.getString("run_id"),
                        rs.getInt("version"),
                        rs.getInt("ordinal"),
                        rs.getString("created_at"),
                        rs.getString("projection_json")
                ))
                .list();
    }

    private ChildRunState state(String childRunId) {
        return jdbc.sql("""
                SELECT r.phase, p.input_json
                FROM agent_run r
                JOIN pipeline_run_input p ON p.run_id = r.run_id
                WHERE r.run_id = :childRunId
                """)
                .param("childRunId", childRunId)
                .query((rs, rowNum) -> new ChildRunState(
                        rs.getString("phase"),
                        taskTextFromPipelineInput(
                                objectMapper,
                                rs.getString("input_json")
                        )
                ))
                .optional()
                .orElse(null);
    }

    /**
     * Shared child-Run task text extraction (pipeline input {@code task}
     * field). Also used by the RunView query assembly so the hydration path
     * and the live node projection never diverge.
     */
    public static String taskTextFromPipelineInput(
            ObjectMapper objectMapper,
            String inputJson
    ) {
        if (inputJson == null || inputJson.isBlank()) {
            return "后台子任务";
        }
        try {
            JsonNode input = objectMapper.readTree(inputJson);
            String task = input.path("task").asText("").trim();
            return task.isBlank() ? "后台子任务" : task;
        } catch (com.fasterxml.jackson.core.JsonProcessingException exception) {
            LOGGER.warn("Pipeline input is not valid JSON", exception);
            return "后台子任务";
        }
    }

    private void reprojectNode(ChildRunNode node, ChildRunState state) {
        ObjectNode projection = parseProjection(node.projectionJson());
        if (projection == null) {
            return;
        }

        projection.put("status", state.phase());
        projection.put("progressSummary", progressSummary(state.phase(), state.taskText()));
        projection.put("updatedAt", clock.instant().toString());

        int nextVersion = node.version() + 1;
        projection.put("version", nextVersion);
        boolean updated = transactions.execute(status -> {
            int rows = jdbc.sql("""
                    UPDATE render_node_projection
                    SET node_status = :status, version = :version,
                        projection_json = :projection, updated_at = :now
                    WHERE node_id = :nodeId AND version = :expectedVersion
                    """)
                    .param("status", state.phase())
                    .param("version", nextVersion)
                    .param("projection", projection.toString())
                    .param("now", clock.instant().toString())
                    .param("nodeId", node.nodeId())
                    .param("expectedVersion", node.version())
                    .update();
            if (rows != 1) {
                throw new IllegalStateException(
                        "Child run render node changed concurrently: " + node.nodeId()
                );
            }
            return true;
        });
        if (Boolean.FALSE.equals(updated)) {
            return;
        }

        ObjectNode payload = objectMapper.createObjectNode();
        payload.set("node", projection);

        RunRow run = runs.findRun(node.runId()).orElse(null);
        if (run == null) {
            LOGGER.warn(
                    "Cannot emit child run node update; parent run missing: {}",
                    node.runId()
            );
            return;
        }
        events.append(new EventDraft(
                "render_node.updated",
                run.conversationId(),
                run.branchId(),
                run.turnId(),
                run.runId(),
                "render_node",
                node.nodeId(),
                nextVersion,
                null,
                run.runId(),
                payload
        ));
    }

    private ObjectNode parseProjection(String json) {
        try {
            return (ObjectNode) objectMapper.readTree(json);
        } catch (com.fasterxml.jackson.core.JsonProcessingException exception) {
            LOGGER.warn("Stored render projection is invalid JSON", exception);
            return null;
        }
    }

    /**
     * Shared child-Run progress summary; identical wording for the live node
     * projection and the RunView hydration assembly.
     */
    public static String progressSummary(String phase, String taskText) {
        if ("accepted".equals(phase)) {
            return "子任务已排队，等待启动：" + taskText;
        }
        return taskText;
    }

    private record ChildRunNode(
            String nodeId,
            String runId,
            int version,
            int ordinal,
            String createdAt,
            String projectionJson
    ) {
    }

    private record ChildRunState(String phase, String taskText) {
    }
}
