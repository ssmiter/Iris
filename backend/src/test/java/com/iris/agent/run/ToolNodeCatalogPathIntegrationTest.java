package com.iris.agent.run;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.ModelAttemptRepository.RoundToolCall;
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
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Tool 节点的 catalogPath 投影（docs/36 M16）：已注册工具投能力树路径，
 * 未注册工具投 null（fail-closed，前端缺失不渲染）。
 */
@SpringBootTest
class ToolNodeCatalogPathIntegrationTest {
    private static final Path DATABASE = Path.of(
            "target",
            "test-data",
            "tool-node-catalog-path.db"
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
    void registeredToolProjectsCapabilityPath() throws Exception {
        String suffix = "tcp-" + Instant.now().toEpochMilli();
        seedParents(suffix);
        ObjectNode input = objectMapper.createObjectNode();
        input.put("path", ".");
        RoundToolCall call = new RoundToolCall(
                "tc-" + suffix,
                "pc-" + suffix,
                "list_files",
                input,
                0,
                "exec-" + suffix
        );
        RuntimeResult result = new RuntimeResult(
                "exec-" + suffix,
                call.toolCallId(),
                "list_files",
                "succeeded",
                null,
                null,
                null,
                null,
                "succeeded",
                null,
                "已列出工作区根目录",
                1,
                Instant.now().minusSeconds(1),
                Instant.now()
        );

        projections.project("round-" + suffix, call, result);

        JsonNode node = toolNode("turn-" + suffix);
        assertThat(node.path("type").asText()).isEqualTo("tool");
        assertThat(node.path("toolName").asText()).isEqualTo("list_files");
        assertThat(node.path("catalogPath").asText())
                .isEqualTo("/system/files/list_files");
    }

    @Test
    void unregisteredToolProjectsNullCatalogPath() throws Exception {
        String suffix = "tcp-ghost-" + Instant.now().toEpochMilli();
        seedParents(suffix);
        ObjectNode input = objectMapper.createObjectNode();
        input.put("query", "anything");
        RoundToolCall call = new RoundToolCall(
                "tc-" + suffix,
                "pc-" + suffix,
                "phantom_tool",
                input,
                0,
                "exec-" + suffix
        );
        RuntimeResult result = new RuntimeResult(
                "exec-" + suffix,
                call.toolCallId(),
                "phantom_tool",
                "succeeded",
                null,
                null,
                null,
                null,
                "succeeded",
                null,
                "完成",
                1,
                Instant.now().minusSeconds(1),
                Instant.now()
        );

        projections.project("round-" + suffix, call, result);

        JsonNode node = toolNode("turn-" + suffix);
        assertThat(node.path("toolName").asText()).isEqualTo("phantom_tool");
        assertThat(node.has("catalogPath")).isTrue();
        assertThat(node.path("catalogPath").isNull()).isTrue();
    }

    private JsonNode toolNode(String turnId) throws Exception {
        String json = jdbc.sql("""
                SELECT projection_json FROM render_node_projection
                WHERE turn_id = :turnId AND node_type = 'tool'
                """)
                .param("turnId", turnId)
                .query(String.class)
                .single();
        return objectMapper.readTree(json);
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
                .param("title", "tool node catalog path test")
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
                .param("content", "跑一个工具")
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
}
