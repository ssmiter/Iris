package com.iris.agent.run;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.conversation.application.ConversationQueryService;
import com.iris.conversation.domain.ConversationViews.ConversationView;
import com.iris.conversation.domain.ConversationViews.RunView;
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
 * RunView.progressSummary 水合装配：带 pipeline input 的 child Run 投影摘要
 * （与实时节点投影同一套文案），root Run 一律为 null。
 */
@SpringBootTest
class RunViewProgressSummaryIntegrationTest {
    private static final Path DATABASE = Path.of(
            "target",
            "test-data",
            "run-view-progress-summary.db"
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
    void childRunProjectsProgressSummaryWhileRootRunDoesNot()
            throws Exception {
        String suffix = "rvp-" + Instant.now().toEpochMilli();
        String task = "整理本周会议纪要并提取行动项";
        seedParents(suffix);
        String pipelineRunId = seedPipelineRun(suffix, task);

        ConversationView view = queries.view(
                "conv-" + suffix,
                null,
                null,
                50
        ).block(Duration.ofSeconds(5));

        assertThat(view).isNotNull();
        RunView child = view.runsById().get(pipelineRunId);
        assertThat(child).isNotNull();
        assertThat(child.parentRunId()).isEqualTo("run-" + suffix);
        assertThat(child.progressSummary()).isEqualTo(task);
        RunView root = view.runsById().get("run-" + suffix);
        assertThat(root).isNotNull();
        assertThat(root.parentRunId()).isNull();
        assertThat(root.progressSummary()).isNull();
    }

    @Test
    void acceptedChildRunProjectsQueuedProgressSummary() throws Exception {
        String suffix = "rvp-queued-" + Instant.now().toEpochMilli();
        String task = "分析竞争对手本周发布";
        seedParents(suffix);
        String pipelineRunId = seedPipelineRun(suffix, task);
        jdbc.sql("UPDATE agent_run SET phase = 'accepted' WHERE run_id = :runId")
                .param("runId", pipelineRunId)
                .update();

        ConversationView view = queries.view(
                "conv-" + suffix,
                null,
                null,
                50
        ).block(Duration.ofSeconds(5));

        assertThat(view).isNotNull();
        RunView child = view.runsById().get(pipelineRunId);
        assertThat(child).isNotNull();
        assertThat(child.phase()).isEqualTo("accepted");
        assertThat(child.progressSummary())
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
                .param("title", "run view progress summary test")
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
                INSERT INTO run_definition_snapshot(
                    run_id, definition_id, definition_version, snapshot_hash,
                    normalized_input_hash, dependency_snapshot_ref,
                    tool_calls_limit, time_limit_ms
                ) VALUES (
                    :runId, 'iris.agentic.default', '1', :snapshotHash,
                    :snapshotHash, NULL, 30, 600000
                )
                """)
                .param("runId", "run-" + suffix)
                .param("snapshotHash", "root-" + suffix)
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

    private String hash(String value) throws Exception {
        return java.util.HexFormat.of().formatHex(
                java.security.MessageDigest.getInstance("SHA-256")
                        .digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8))
        );
    }
}
