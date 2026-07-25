package com.iris.agent.model;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.ModelStreamEvent.BlockDelta;
import com.iris.agent.model.ModelStreamEvent.BlockKind;
import com.iris.agent.model.ModelStreamEvent.BlockStarted;
import com.iris.agent.model.ModelStreamEvent.FragmentMode;
import com.iris.agent.run.RunRoundRepository.RoundRow;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.conversation.application.ConversationEventAppender;
import com.iris.conversation.application.ConversationEventAppender.EventDraft;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 把模型文本流的增量投影成 answer render node（docs/08 §10.4）。
 * 节点 ID 从 attemptId 确定性派生：finalize 与失败清理都能找到同一个节点。
 */
@Service
public class AnswerStreamProjector {
    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;
    private final ConversationEventAppender events;
    private final Clock clock = Clock.systemUTC();
    private final Map<String, StreamState> streams = new ConcurrentHashMap<>();

    public AnswerStreamProjector(
            JdbcClient jdbc,
            ObjectMapper objectMapper,
            ConversationEventAppender events
    ) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.events = events;
    }

    public static String nodeIdFor(String attemptId) {
        return "node_answer_" + attemptId;
    }

    public void accept(
            RunRow run,
            RoundRow round,
            String attemptId,
            ModelStreamEvent event
    ) {
        if (event instanceof BlockStarted started
                && started.kind() == BlockKind.TEXT) {
            streams.computeIfAbsent(
                    attemptId,
                    key -> new StreamState(run, round, attemptId)
            ).openBlock(started.index());
            return;
        }
        if (event instanceof BlockDelta delta) {
            StreamState state = streams.get(attemptId);
            if (state == null || !state.isTextBlock(delta.index())) {
                return;
            }
            String append = state.append(delta.index(), delta);
            if (append.isEmpty()) {
                return;
            }
            synchronized (state) {
                applyDelta(state, append);
            }
        }
    }

    /**
     * Attempt 失败：删除半截 answer 节点并通知前端移除。
     */
    public void invalidate(
            String conversationId,
            String attemptId
    ) {
        StreamState state = streams.remove(attemptId);
        String nodeId = nodeIdFor(attemptId);
        ObjectNode node = readNode(nodeId);
        if (node == null) {
            return;
        }
        jdbc.sql("""
                DELETE FROM render_node_projection
                WHERE node_id = :nodeId
                """)
                .param("nodeId", nodeId)
                .update();
        String conversation = state == null
                ? conversationId
                : state.run.conversationId();
        ObjectNode payload = objectMapper.createObjectNode();
        payload.set("node", node);
        events.append(new EventDraft(
                "render_node.invalidated",
                conversation,
                text(node, "branchId"),
                text(node, "turnId"),
                text(node, "runId"),
                "render_node",
                nodeId,
                node.path("version").asLong(),
                attemptId,
                text(node, "runId"),
                payload
        ));
    }

    public void discard(String attemptId) {
        streams.remove(attemptId);
    }

    /**
     * 进程重启后残留的 streaming 节点没有活着的流：标记失败，
     * 让水合视图不显示一条永远“正在输入”的回答。
     */
    public int recoverInterrupted() {
        return jdbc.sql("""
                UPDATE render_node_projection
                SET node_status = 'failed',
                    projection_json = json_set(projection_json, '$.status', 'failed'),
                    updated_at = :now
                WHERE node_type = 'answer' AND node_status = 'streaming'
                """)
                .param("now", clock.instant().toString())
                .update();
    }

    private void applyDelta(StreamState state, String append) {
        Instant now = clock.instant();
        if (!state.nodeCreated) {
            state.ordinal = nextOrdinal(state.run.turnId());
            state.createdAt = now;
            ObjectNode projection = baseNode(state, 1, now);
            projection.put("content", state.content.toString());
            jdbc.sql("""
                    INSERT INTO render_node_projection(
                        node_id, conversation_id, branch_id, turn_id, run_id,
                        round_id, pipeline_step_run_id, node_type, node_status,
                        group_id, ordinal, renderer_key, version,
                        final_content_hash, projection_json, created_at, updated_at
                    ) VALUES (
                        :nodeId, :conversationId, :branchId, :turnId, :runId,
                        :roundId, NULL, 'answer', 'streaming',
                        NULL, :ordinal, 'default', 1,
                        NULL, :projection, :now, :now
                    )
                    """)
                    .param("nodeId", state.nodeId)
                    .param("conversationId", state.run.conversationId())
                    .param("branchId", state.run.branchId())
                    .param("turnId", state.run.turnId())
                    .param("runId", state.run.runId())
                    .param("roundId", state.round.roundId())
                    .param("ordinal", nextOrdinal(state.run.turnId()))
                    .param("projection", projection.toString())
                    .param("now", now.toString())
                    .update();
            state.nodeCreated = true;
            state.version = 1;
            ObjectNode added = objectMapper.createObjectNode();
            added.set("node", projection);
            events.append(new EventDraft(
                    "render_node.added",
                    state.run.conversationId(),
                    state.run.branchId(),
                    state.run.turnId(),
                    state.run.runId(),
                    "render_node",
                    state.nodeId,
                    1,
                    state.attemptId,
                    state.run.runId(),
                    added
            ));
            return;
        }

        int baseVersion = state.version;
        int targetVersion = baseVersion + 1;
        state.chunkSequence++;
        String content = state.content.toString();
        ObjectNode projection = baseNode(
                state,
                targetVersion,
                state.createdAt,
                now
        );
        projection.put("content", content);
        int updated = jdbc.sql("""
                UPDATE render_node_projection
                SET version = :version, projection_json = :projection,
                    updated_at = :now
                WHERE node_id = :nodeId AND version = :expectedVersion
                """)
                .param("version", targetVersion)
                .param("projection", projection.toString())
                .param("now", now.toString())
                .param("nodeId", state.nodeId)
                .param("expectedVersion", baseVersion)
                .update();
        if (updated != 1) {
            throw new IllegalStateException(
                    "Answer stream projection changed concurrently"
            );
        }
        state.version = targetVersion;

        ObjectNode delta = objectMapper.createObjectNode();
        delta.put("nodeId", state.nodeId);
        delta.put("field", "content");
        delta.put("baseVersion", baseVersion);
        delta.put("targetVersion", targetVersion);
        delta.put("chunkSequence", state.chunkSequence);
        delta.put("append", append);
        events.append(new EventDraft(
                "render_node.delta",
                state.run.conversationId(),
                state.run.branchId(),
                state.run.turnId(),
                state.run.runId(),
                "render_node",
                state.nodeId,
                targetVersion,
                state.attemptId,
                state.run.runId(),
                delta
        ));
    }

    private ObjectNode baseNode(
            StreamState state,
            int version,
            Object createdAt,
            Instant now
    ) {
        ObjectNode node = objectMapper.createObjectNode();
        node.put("nodeId", state.nodeId);
        node.put("turnId", state.run.turnId());
        node.put("runId", state.run.runId());
        node.put("roundId", state.round.roundId());
        node.put("branchId", state.run.branchId());
        node.putNull("pipelineStepRunId");
        node.putNull("groupId");
        node.put("ordinal", state.ordinal());
        node.put("rendererKey", "default");
        node.put("version", version);
        node.put("createdAt", createdAt.toString());
        node.put("updatedAt", now.toString());
        node.put("type", "answer");
        node.put("status", "streaming");
        node.put("role", "stage");
        node.putNull("sourceMessageId");
        return node;
    }

    private ObjectNode readNode(String nodeId) {
        String json = jdbc.sql("""
                SELECT projection_json FROM render_node_projection
                WHERE node_id = :nodeId
                """)
                .param("nodeId", nodeId)
                .query(String.class)
                .optional()
                .orElse(null);
        if (json == null) {
            return null;
        }
        try {
            return (ObjectNode) objectMapper.readTree(json);
        } catch (com.fasterxml.jackson.core.JsonProcessingException exception) {
            throw new IllegalStateException(
                    "Stored render projection is invalid JSON",
                    exception
            );
        }
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

    private String text(ObjectNode node, String field) {
        return node.path(field).isTextual()
                ? node.path(field).asText()
                : null;
    }

    private final class StreamState {
        private final RunRow run;
        private final RoundRow round;
        private final String attemptId;
        private final String nodeId;
        private final StringBuilder content = new StringBuilder();
        private final Map<Integer, StringBuilder> blocks = new ConcurrentHashMap<>();
        private boolean nodeCreated;
        private int version;
        private int chunkSequence;
        private Object createdAt;

        private StreamState(RunRow run, RoundRow round, String attemptId) {
            this.run = run;
            this.round = round;
            this.attemptId = attemptId;
            this.nodeId = nodeIdFor(attemptId);
        }

        private void openBlock(int index) {
            blocks.put(index, new StringBuilder());
        }

        private boolean isTextBlock(int index) {
            return blocks.containsKey(index);
        }

        private String append(int index, BlockDelta delta) {
            StringBuilder block = blocks.get(index);
            if (delta.mode() == FragmentMode.CUMULATIVE) {
                String fragment = delta.fragment();
                String current = block.toString();
                if (!fragment.startsWith(current)) {
                    return "";
                }
                String suffix = fragment.substring(current.length());
                block.setLength(0);
                block.append(fragment);
                content.append(suffix);
                return suffix;
            }
            block.append(delta.fragment());
            content.append(delta.fragment());
            return delta.fragment();
        }

        private int ordinal() {
            return jdbc.sql("""
                    SELECT ordinal FROM render_node_projection
                    WHERE node_id = :nodeId
                    """)
                    .param("nodeId", nodeId)
                    .query(Integer.class)
                    .single();
        }
    }
}
