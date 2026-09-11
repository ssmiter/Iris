package com.iris.objective.attachments;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.time.Instant;
import java.util.List;

/**
 * WonWork-compatible attachment facts.
 *
 * <p>This endpoint deliberately does not make attachments part of the agent
 * loop. It only gives the conversation UI a durable, lossless place for the
 * small inline DTOs that still exist beside workspace uploads. Large files
 * use the workspace/object store path and never get copied into this table.</p>
 */
@RestController
@RequestMapping("/api/attachments")
public final class AttachmentApiController {
    private static final int MAX_DTO_CHARS = 8 * 1024 * 1024;

    private final JdbcClient jdbc;
    private final ObjectMapper json;

    public AttachmentApiController(JdbcClient jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    @GetMapping("/{conversationId}")
    public Mono<List<JsonNode>> list(@PathVariable String conversationId) {
        return Mono.fromCallable(() -> jdbc.sql("""
                SELECT dto_json
                FROM conversation_attachment
                WHERE conversation_id = :conversationId
                ORDER BY created_at ASC, attachment_id ASC
                """)
                .param("conversationId", requiredConversationId(conversationId))
                .query(String.class)
                .list()
                .stream()
                .map(this::parseStoredDto)
                .toList())
                .subscribeOn(Schedulers.boundedElastic());
    }

    @PostMapping("/{conversationId}")
    public Mono<ResponseEntity<Void>> upsert(
            @PathVariable String conversationId,
            @RequestBody JsonNode dto
    ) {
        return Mono.<ResponseEntity<Void>>fromCallable(() -> {
            String conversation = requiredConversationId(conversationId);
            if (!conversationExists(conversation)) {
                throw new ResponseStatusException(
                        HttpStatus.NOT_FOUND, "conversation not found");
            }
            if (dto == null || !dto.isObject()) {
                throw new ResponseStatusException(
                        HttpStatus.BAD_REQUEST, "attachment 必须是 JSON 对象");
            }
            String attachmentId = text(dto, "id");
            if (attachmentId == null) {
                throw new ResponseStatusException(
                        HttpStatus.BAD_REQUEST, "attachment.id 不能为空");
            }
            String encoded = json.writeValueAsString(normalize(dto, conversation));
            if (encoded.length() > MAX_DTO_CHARS) {
                throw new ResponseStatusException(
                        HttpStatus.PAYLOAD_TOO_LARGE,
                        "附件元数据过大；大文件请使用工作区上传");
            }
            Instant now = Instant.now();
            jdbc.sql("""
                    INSERT INTO conversation_attachment (
                      attachment_id, conversation_id, dto_json,
                      created_at, updated_at
                    ) VALUES (:id, :conversationId, :dto, :createdAt, :updatedAt)
                    ON CONFLICT(attachment_id) DO UPDATE SET
                      conversation_id = excluded.conversation_id,
                      dto_json = excluded.dto_json,
                      updated_at = excluded.updated_at
                    """)
                    .param("id", attachmentId)
                    .param("conversationId", conversation)
                    .param("dto", encoded)
                    .param("createdAt", now.toString())
                    .param("updatedAt", now.toString())
                    .update();
            return ResponseEntity.<Void>noContent().build();
        }).subscribeOn(Schedulers.boundedElastic());
    }

    @DeleteMapping("/{attachmentId}")
    public Mono<ResponseEntity<Void>> delete(@PathVariable String attachmentId) {
        return Mono.<ResponseEntity<Void>>fromCallable(() -> {
            if (attachmentId == null || attachmentId.isBlank()) {
                throw new ResponseStatusException(
                        HttpStatus.BAD_REQUEST, "attachmentId 不能为空");
            }
            jdbc.sql("DELETE FROM conversation_attachment WHERE attachment_id = :id")
                    .param("id", attachmentId)
                    .update();
            // DELETE is idempotent: a stale local attachment must not create a
            // toast during a later cleanup pass.
            return ResponseEntity.<Void>noContent().build();
        }).subscribeOn(Schedulers.boundedElastic());
    }

    private boolean conversationExists(String id) {
        return jdbc.sql("SELECT COUNT(*) FROM iris_conversation WHERE conversation_id = :id")
                .param("id", id)
                .query(Integer.class)
                .single() > 0;
    }

    private String requiredConversationId(String value) {
        if (value == null || value.isBlank()) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST, "conversationId 不能为空");
        }
        return value;
    }

    private ObjectNode normalize(JsonNode value, String conversationId) {
        ObjectNode copy = ((ObjectNode) value).deepCopy();
        // The path is authoritative. This prevents a stale client DTO from
        // silently appearing in another conversation after a reconnect.
        if (conversationId.matches("-?\\d+")) {
            try {
                copy.put("conversationId", Long.parseLong(conversationId));
            } catch (NumberFormatException ignored) {
                copy.put("conversationId", conversationId);
            }
        } else {
            copy.put("conversationId", conversationId);
        }
        return copy;
    }

    private JsonNode parseStoredDto(String value) {
        try {
            return json.readTree(value);
        } catch (Exception ignored) {
            // A corrupt optional attachment should not prevent the whole
            // conversation from opening. It will be cleaned up on delete.
            return json.createObjectNode()
                    .put("id", "invalid-attachment")
                    .put("name", "无法读取的附件")
                    .put("type", "unknown")
                    .put("mimeType", "application/octet-stream")
                    .put("size", 0)
                    .put("data", "")
                    .put("createdAt", Instant.now().toString());
        }
    }

    private String text(JsonNode node, String field) {
        JsonNode value = node.get(field);
        if (value == null || !value.isTextual() || value.asText().isBlank()) {
            return null;
        }
        return value.asText().trim();
    }
}
