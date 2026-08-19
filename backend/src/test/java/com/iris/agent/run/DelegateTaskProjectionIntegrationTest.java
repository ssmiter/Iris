package com.iris.agent.run;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.ModelAttemptRepository.RoundToolCall;
import com.iris.conversation.application.ConversationQueryService;
import com.iris.conversation.domain.ConversationViews.ConversationView;
import com.iris.tools.core.ToolExecutionViews.RuntimeResult;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * delegate_task 必须投影为 {@code type=run} 节点，并在子 Run 生命周期变化时
 * 同步更新；水合（ConversationView）与 SSE（ConversationEventStream）两路径
 * 看到的投影必须一致。
 */
@SpringBootTest
class DelegateTaskProjectionIntegrationTest {
    private static final Path DATABASE = Path.of(
            "target",
            "test-data",
            "delegate-task-projection.db"
    ).toAbsolutePath();
    private static final Path WORKSPACE = Path.of(
            "target",
            "test-workspace"
    ).toAbsolutePath();

    @Autowired
    private JdbcClient jdbc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private ToolProjectionService projections;

    @Autowired
    private ChildRunNodeProjectionService childRunNodes;

    @Autowired
    private ConversationQueryService queries;

    @DynamicPropertySource
    static void testProperties(DynamicPropertyRegistry registry)
            throws IOException {
        Files.createDirectories(DATABASE.getParent());
        Files.deleteIfExists(DATABASE);
        Files.deleteIfExists(Path.of(DATABASE + "-wal"));
        Files.deleteIfExists(Path.of(DATABASE + "-shm"));
        Files.createDirectories(WORKSPACE);
        registry.add(
                "spring.datasource.url",
                () -> "jdbc:sqlite:" + DATABASE.toString().replace('\\', '/')
        );
        registry.add("iris.workspace", WORKSPACE::toString);
    }

    @Test
    void delegateTaskProjectsAsRunNodeWithChildRunIdAndProgressSummary()
            throws Exception {
        String suffix = "dt-" + Instant.now().toEpochMilli();
        String task = "整理本周会议纪要并提取行动项";
        seedParents(suffix);
        String pipelineRunId = seedPipelineRun(suffix, task);
        String executionId = seedDelegateTaskExecution(suffix, pipelineRunId, task);

        RoundToolCall call = new RoundToolCall(
                "tc-" + suffix,
                "pc-" + suffix,
                "delegate_task",
                delegateTaskInput(task),
                0,
                executionId
        );
        RuntimeResult result = new RuntimeResult(
                executionId,
                call.toolCallId(),
                "delegate_task",
                "succeeded",
                null,
                null,
                null,
                "创建一个隔离后台子任务",
                "succeeded",
                null,
                null,
                1,
                Instant.now().minusSeconds(2),
                Instant.now()
        );

        projections.project("round-" + suffix, call, result);

        // Hydration path: ConversationView renders the node as type=run.
        ConversationView view = queries.view(
                "conv-" + suffix,
                null,
                null,
                50
        ).block(Duration.ofSeconds(5));
        assertThat(view).isNotNull();
        assertThat(view.renderNodesById()).hasSize(1);
        JsonNode node = view.renderNodesById().values().iterator().next();
        assertThat(node.path("type").asText()).isEqualTo("run");
        assertThat(node.path("childRunId").asText()).isEqualTo(pipelineRunId);
        assertThat(node.path("status").asText()).isEqualTo("running");
        assertThat(node.path("progressSummary").asText()).isEqualTo(task);
        assertThat(node.path("label").asText()).isEqualTo(task);

        // SSE path: a render_node.added event carrying the same node is appended.
        String addedPayload = jdbc.sql("""
                SELECT payload_json FROM conversation_event
                WHERE conversation_id = :convId AND event_type = 'render_node.added'
                ORDER BY sequence DESC LIMIT 1
                """)
                .param("convId", "conv-" + suffix)
                .query(String.class)
                .single();
        JsonNode addedNode = objectMapper.readTree(addedPayload).path("node");
        assertThat(addedNode.path("type").asText()).isEqualTo("run");
        assertThat(addedNode.path("childRunId").asText()).isEqualTo(pipelineRunId);
        assertThat(addedNode.path("progressSummary").asText()).isEqualTo(task);
    }

    @Test
    void childRunNodeUpdatesWhenPipelineRunPhaseChanges()
            throws Exception {
        String suffix = "dt-update-" + Instant.now().toEpochMilli();
        String task = "检查数据库备份状态";
        seedParents(suffix);
        String pipelineRunId = seedPipelineRun(suffix, task);
        String executionId = seedDelegateTaskExecution(suffix, pipelineRunId, task);

        RoundToolCall call = new RoundToolCall(
                "tc-" + suffix,
                "pc-" + suffix,
                "delegate_task",
                delegateTaskInput(task),
                0,
                executionId
        );
        RuntimeResult result = new RuntimeResult(
                executionId,
                call.toolCallId(),
                "delegate_task",
                "succeeded",
                null,
                null,
                null,
                "创建一个隔离后台子任务",
                "succeeded",
                null,
                null,
                1,
                Instant.now().minusSeconds(2),
                Instant.now()
        );
        projections.project("round-" + suffix, call, result);

        ConversationView view = queries.view(
                "conv-" + suffix,
                null,
                null,
                50
        ).block(Duration.ofSeconds(5));
        String nodeId = view.renderNodesById().keySet().iterator().next();
        assertThat(view.renderNodesById().get(nodeId).path("status").asText())
                .isEqualTo("running");

        // Simulate the pipeline Run settling: update canonical phase and refresh
        // the run render node.
        jdbc.sql("UPDATE agent_run SET phase = 'succeeded' WHERE run_id = :runId")
                .param("runId", pipelineRunId)
                .update();
        childRunNodes.updateForRun(pipelineRunId);

        // Hydration path reflects the updated status and version.
        ConversationView updatedView = queries.view(
                "conv-" + suffix,
                null,
                null,
                50
        ).block(Duration.ofSeconds(5));
        JsonNode updatedNode = updatedView.renderNodesById().get(nodeId);
        assertThat(updatedNode.path("status").asText()).isEqualTo("succeeded");
        assertThat(updatedNode.path("version").asInt()).isEqualTo(2);
        assertThat(updatedNode.path("progressSummary").asText()).isEqualTo(task);

        // SSE path emits a render_node.updated event for the same node.
        String updatedPayload = jdbc.sql("""
                SELECT payload_json FROM conversation_event
                WHERE conversation_id = :convId AND event_type = 'render_node.updated'
                ORDER BY sequence DESC LIMIT 1
                """)
                .param("convId", "conv-" + suffix)
                .query(String.class)
                .single();
        JsonNode updatedEventNode = objectMapper.readTree(updatedPayload)
                .path("node");
        assertThat(updatedEventNode.path("nodeId").asText()).isEqualTo(nodeId);
        assertThat(updatedEventNode.path("status").asText()).isEqualTo("succeeded");
    }

    @Test
    void acceptedPipelineRunShowsQueuedProgressSummary()
            throws Exception {
        String suffix = "dt-queued-" + Instant.now().toEpochMilli();
        String task = "分析竞争对手本周发布";
        seedParents(suffix);
        String pipelineRunId = seedPipelineRun(suffix, task);
        jdbc.sql("UPDATE agent_run SET phase = 'accepted' WHERE run_id = :runId")
                .param("runId", pipelineRunId)
                .update();
        String executionId = seedDelegateTaskExecution(suffix, pipelineRunId, task);

        RoundToolCall call = new RoundToolCall(
                "tc-" + suffix,
                "pc-" + suffix,
                "delegate_task",
                delegateTaskInput(task),
                0,
                executionId
        );
        RuntimeResult result = new RuntimeResult(
                executionId,
                call.toolCallId(),
                "delegate_task",
                "succeeded",
                null,
                null,
                null,
                "创建一个隔离后台子任务",
                "succeeded",
                null,
                null,
                1,
                Instant.now().minusSeconds(2),
                Instant.now()
        );

        projections.project("round-" + suffix, call, result);

        ConversationView view = queries.view(
                "conv-" + suffix,
                null,
                null,
                50
        ).block(Duration.ofSeconds(5));
        JsonNode node = view.renderNodesById().values().iterator().next();
        assertThat(node.path("type").asText()).isEqualTo("run");
        assertThat(node.path("status").asText()).isEqualTo("accepted");
        assertThat(node.path("progressSummary").asText())
                .isEqualTo("子任务已排队，等待启动：" + task);
    }

    private void seedParents(String suffix) {
        String now = Instant.now().toString();
        jdbc.sql("""
                INSERT INTO iris_conversation(
                    conversation_id, root_branch_id, title, version,
                    created_at, updated_at
                ) VALUES (:convId, :branchId, :title, 1, :now, :now)
                """)
                .param("convId", "conv-" + suffix)
                .param("branchId", "branch-" + suffix)
                .param("title", "delegate_task projection test")
                .param("now", now)
                .update();
        jdbc.sql("""
                INSERT INTO conversation_branch(
                    branch_id, conversation_id, status, version, created_at
                ) VALUES (:branchId, :convId, 'active', 1, :now)
                """)
                .param("branchId", "branch-" + suffix)
                .param("convId", "conv-" + suffix)
                .param("now", now)
                .update();
        jdbc.sql("""
                INSERT INTO message(
                    message_id, conversation_id, branch_id, turn_id,
                    role, content, created_at
                ) VALUES (:msgId, :convId, :branchId, :turnId, 'user', :content, :now)
                """)
                .param("msgId", "msg-" + suffix)
                .param("convId", "conv-" + suffix)
                .param("branchId", "branch-" + suffix)
                .param("turnId", "turn-" + suffix)
                .param("content", "委派一个后台任务")
                .param("now", now)
                .update();
        jdbc.sql("""
                INSERT INTO conversation_turn(
                    turn_id, conversation_id, branch_id, request_message_id,
                    root_run_id, phase, version, started_at
                ) VALUES (:turnId, :convId, :branchId, :msgId, :runId, 'running', 1, :now)
                """)
                .param("turnId", "turn-" + suffix)
                .param("convId", "conv-" + suffix)
                .param("branchId", "branch-" + suffix)
                .param("msgId", "msg-" + suffix)
                .param("runId", "run-" + suffix)
                .param("now", now)
                .update();
        jdbc.sql("""
                INSERT INTO agent_run(
                    run_id, conversation_id, branch_id, turn_id,
                    parent_run_id, root_run_id, kind, purpose, phase,
                    version, started_at
                ) VALUES (
                    :runId, :convId, :branchId, :turnId, NULL, :runId,
                    'agentic', :purpose, 'running', 1, :now
                )
                """)
                .param("runId", "run-" + suffix)
                .param("convId", "conv-" + suffix)
                .param("branchId", "branch-" + suffix)
                .param("turnId", "turn-" + suffix)
                .param("purpose", "测试父 Run")
                .param("now", now)
                .update();
        jdbc.sql("""
                INSERT INTO agent_round(
                    round_id, conversation_id, branch_id, turn_id, run_id,
                    round_index, phase, tool_call_count, duration_ms,
                    version, created_at, updated_at
                ) VALUES (
                    :roundId, :convId, :branchId, :turnId, :runId,
                    0, 'awaiting_tools', 0, 0, 1, :now, :now
                )
                """)
                .param("roundId", "round-" + suffix)
                .param("convId", "conv-" + suffix)
                .param("branchId", "branch-" + suffix)
                .param("turnId", "turn-" + suffix)
                .param("runId", "run-" + suffix)
                .param("now", now)
                .update();
        jdbc.sql("""
                INSERT INTO conversation_event(
                    conversation_id, sequence, event_id, event_type,
                    branch_id, turn_id, run_id, parent_run_id,
                    aggregate_kind, aggregate_id, aggregate_version,
                    causation_id, correlation_id, occurred_at, payload_json
                ) VALUES (
                    :convId, 1, :eventId, 'turn.accepted',
                    :branchId, :turnId, :runId, NULL,
                    'turn', :turnId, 1,
                    NULL, NULL, :now, :payload
                )
                """)
                .param("convId", "conv-" + suffix)
                .param("eventId", "evt-" + suffix)
                .param("branchId", "branch-" + suffix)
                .param("turnId", "turn-" + suffix)
                .param("runId", "run-" + suffix)
                .param("now", now)
                .param("payload", "{}")
                .update();
    }

    private String seedPipelineRun(String suffix, String task) throws Exception {
        String pipelineRunId = "pipeline-" + suffix;
        String now = Instant.now().toString();
        ObjectNode input = objectMapper.createObjectNode();
        input.put("task", task);
        input.put("work_mode", "observe");
        String inputJson = objectMapper.writeValueAsString(input);
        String inputHash = hash(inputJson);

        jdbc.sql("""
                INSERT INTO agent_run(
                    run_id, conversation_id, branch_id, turn_id,
                    parent_run_id, root_run_id, kind, purpose, phase,
                    version, started_at
                ) VALUES (
                    :runId, :convId, :branchId, :turnId, :parentRunId, :rootRunId,
                    'pipeline', :purpose, 'running', 1, :now
                )
                """)
                .param("runId", pipelineRunId)
                .param("convId", "conv-" + suffix)
                .param("branchId", "branch-" + suffix)
                .param("turnId", "turn-" + suffix)
                .param("parentRunId", "run-" + suffix)
                .param("rootRunId", "run-" + suffix)
                .param("purpose", "后台子任务")
                .param("now", now)
                .update();
        jdbc.sql("""
                INSERT INTO run_definition_snapshot(
                    run_id, definition_id, definition_version, snapshot_hash,
                    normalized_input_hash, dependency_snapshot_ref,
                    tool_calls_limit, time_limit_ms
                ) VALUES (
                    :runId, 'iris.pipeline.delegated_task', '1', :snapshotHash,
                    :inputHash, NULL, 0, 60000
                )
                """)
                .param("runId", pipelineRunId)
                .param("snapshotHash", inputHash)
                .param("inputHash", inputHash)
                .update();
        jdbc.sql("""
                INSERT INTO run_invocation(
                    run_id, parent_run_id, invoking_step_run_id, trigger_kind,
                    trigger_ref, requested_by, created_at
                ) VALUES (
                    :runId, :parentRunId, NULL, 'agent_tool',
                    :triggerRef, 'agent', :now
                )
                """)
                .param("runId", pipelineRunId)
                .param("parentRunId", "run-" + suffix)
                .param("triggerRef", "agent_tool:" + suffix)
                .param("now", now)
                .update();
        jdbc.sql("""
                INSERT INTO pipeline_run_input(
                    run_id, input_json, input_hash, trigger_kind, trigger_ref,
                    delivery_policy, created_at
                ) VALUES (
                    :runId, :inputJson, :inputHash, 'agent_tool', :triggerRef,
                    'notify_parent', :now
                )
                """)
                .param("runId", pipelineRunId)
                .param("inputJson", inputJson)
                .param("inputHash", inputHash)
                .param("triggerRef", "agent_tool:" + suffix)
                .param("now", now)
                .update();
        return pipelineRunId;
    }

    private String seedDelegateTaskExecution(
            String suffix,
            String pipelineRunId,
            String task
    ) throws Exception {
        String executionId = "exec-" + suffix;
        String now = Instant.now().toString();
        ObjectNode output = objectMapper.createObjectNode();
        output.put("pipelineRunId", pipelineRunId);
        output.put("phase", "running");
        output.put("delivery", "后台运行完成后自动通知父 Run");

        jdbc.sql("""
                INSERT INTO tool_execution(
                    execution_id, tool_call_id, conversation_id, turn_id, run_id,
                    round_id, tool_id, tool_version, tool_name, capability_path,
                    manifest_hash, input_hash, phase, version, created_at, updated_at,
                    output_json
                ) VALUES (
                    :executionId, :toolCallId, :convId, :turnId, :runId, :roundId,
                    'iris.system.agents.delegate_task', '3', 'delegate_task',
                    '/system/agents', :manifestHash, :inputHash, 'succeeded', 1,
                    :now, :now, :outputJson
                )
                """)
                .param("executionId", executionId)
                .param("toolCallId", "tc-" + suffix)
                .param("convId", "conv-" + suffix)
                .param("turnId", "turn-" + suffix)
                .param("runId", "run-" + suffix)
                .param("roundId", "round-" + suffix)
                .param("manifestHash", hash("manifest"))
                .param("inputHash", hash(delegateTaskInput(task).toString()))
                .param("now", now)
                .param("outputJson", objectMapper.writeValueAsString(output))
                .update();
        return executionId;
    }

    private ObjectNode delegateTaskInput(String task) {
        ObjectNode input = objectMapper.createObjectNode();
        input.put("task", task);
        input.put("work_mode", "observe");
        return input;
    }

    private String hash(String value) throws Exception {
        return java.util.HexFormat.of().formatHex(
                java.security.MessageDigest.getInstance("SHA-256")
                        .digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8))
        );
    }
}
