package com.iris.objective.history;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.conversation.infrastructure.ConversationRepository;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * /api/history 的消息读写（SQLite 权威）。纯事实 CRUD，无编排。
 * 追加消息只落 message 行（role/content + 结构化字段进入 extras_json），
 * 后端不解释渲染语义，只做安全透传。删除会话级联清消息/turn/branch。
 */
@Service
public class HistoryMessageService {

    private final JdbcClient jdbc;
    private final ConversationRepository repository;
    private final ObjectMapper objectMapper;

    public HistoryMessageService(
            JdbcClient jdbc,
            ConversationRepository repository,
            ObjectMapper objectMapper
    ) {
        this.jdbc = jdbc;
        this.repository = repository;
        this.objectMapper = objectMapper;
    }

    /** 平铺消息列表，形状对齐 WonWork Message[]。 */
    public List<Map<String, Object>> listMessages(String conversationId) {
        if (!repository.conversationExists(conversationId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "conversation not found");
        }
        List<Map<String, Object>> rows = jdbc.sql("""
                SELECT message_id, role, content, extras_json, created_at
                FROM message
                WHERE conversation_id = :conversationId
                ORDER BY created_at ASC, message_id ASC
                """)
                .param("conversationId", conversationId)
                .query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getString("message_id"));
                    m.put("role", rs.getString("role"));
                    m.put("content", rs.getString("content"));
                    String extras = rs.getString("extras_json");
                    if (extras != null && !extras.isBlank()) {
                        try {
                            var node = objectMapper.readTree(extras);
                            if (node != null && node.isObject()) {
                                node.fields().forEachRemaining(e ->
                                        m.put(e.getKey(), objectMapper.convertValue(e.getValue(), Object.class)));
                            }
                        } catch (Exception ignored) {
                            // A malformed optional payload must not hide the message itself.
                        }
                    }
                    m.put("createdAt", rs.getString("created_at"));
                    return m;
                })
                .list();
        return rows;
    }

    /** 追加一条消息事实（任意 role）。不触发任何模型调用。 */
    public void appendMessage(String conversationId, HistoryApiController.AppendMessageRequest request) {
        if (!repository.conversationExists(conversationId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "conversation not found");
        }
        String branchId = jdbc.sql("""
                SELECT root_branch_id FROM iris_conversation WHERE conversation_id = :id
                """)
                .param("id", conversationId)
                .query(String.class)
                .single();
        String messageId = "msg-" + UUID.randomUUID();
        String turnId = "turn-" + UUID.randomUUID();
        String role = request.role() == null ? "user" : request.role();
        Instant now = Instant.now();
        String extrasJson = writeExtras(request);
        jdbc.sql("""
                INSERT INTO message(
                    message_id, conversation_id, branch_id, turn_id, role,
                    content, client_request_id, extras_json, created_at
                ) VALUES (
                    :messageId, :conversationId, :branchId, :turnId, :role,
                    :content, NULL, :extrasJson, :now
                )
                """)
                .param("messageId", messageId)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("turnId", turnId)
                .param("role", role)
                .param("content", request.content() == null ? "" : request.content())
                .param("extrasJson", extrasJson)
                .param("now", now.toString())
                .update();
        jdbc.sql("""
                UPDATE iris_conversation SET updated_at = :now WHERE conversation_id = :id
                """)
                .param("now", now.toString())
                .param("id", conversationId)
                .update();
    }

    /** 更新已落库工具消息的可见正文；其余结构化字段保持不变。 */
    public void updateToolMessageContent(String conversationId, String toolCallId, String content) {
        jdbc.sql("SELECT message_id, extras_json FROM message WHERE conversation_id = :id")
                .param("id", conversationId)
                .query((rs, n) -> new MessageExtrasRow(rs.getString("message_id"), rs.getString("extras_json")))
                .list()
                .stream()
                .filter(row -> toolCallId.equals(readText(row.extrasJson(), "toolCallId")))
                .findFirst()
                .ifPresent(row -> jdbc.sql("UPDATE message SET content = :content WHERE message_id = :messageId")
                        .param("content", content == null ? "" : content)
                        .param("messageId", row.messageId())
                        .update());
    }

    private String writeExtras(HistoryApiController.AppendMessageRequest request) {
        var node = objectMapper.createObjectNode();
        if (request.reasoningContent() != null) node.put("reasoningContent", request.reasoningContent());
        if (request.toolCalls() != null) node.set("toolCalls", objectMapper.valueToTree(request.toolCalls()));
        if (request.toolCallId() != null) node.put("toolCallId", request.toolCallId());
        if (request.toolCallName() != null) node.put("toolCallName", request.toolCallName());
        if (request.toolCallStatus() != null) node.put("toolCallStatus", request.toolCallStatus());
        if (request.structuredData() != null) node.set("structuredData", objectMapper.valueToTree(request.structuredData()));
        if (request.renderNodes() != null) node.set("renderNodes", objectMapper.valueToTree(request.renderNodes()));
        if (request.extras() != null) node.set("extras", objectMapper.valueToTree(request.extras()));
        try {
            return objectMapper.writeValueAsString(node);
        } catch (Exception e) {
            return "{}";
        }
    }

    private String readText(String json, String field) {
        try {
            var node = objectMapper.readTree(json == null ? "{}" : json).path(field);
            return node.isTextual() ? node.asText() : null;
        } catch (Exception ignored) {
            return null;
        }
    }

    private record MessageExtrasRow(String messageId, String extrasJson) { }

    /** 删除会话及其消息/turn/branch/事件等事实行。 */
    public void deleteConversation(String conversationId) {
        if (!repository.conversationExists(conversationId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "conversation not found");
        }
        // 先删子表，再删主表。message_attachment 依赖 message。
        jdbc.sql("DELETE FROM message_attachment WHERE message_id IN (SELECT message_id FROM message WHERE conversation_id = :id)")
                .param("id", conversationId).update();
        jdbc.sql("DELETE FROM message WHERE conversation_id = :id")
                .param("id", conversationId).update();
        jdbc.sql("DELETE FROM conversation_turn WHERE conversation_id = :id")
                .param("id", conversationId).update();
        jdbc.sql("DELETE FROM conversation_branch WHERE conversation_id = :id")
                .param("id", conversationId).update();
        jdbc.sql("DELETE FROM iris_conversation WHERE conversation_id = :id")
                .param("id", conversationId).update();
    }
}
