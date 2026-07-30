package com.iris.conversation.infrastructure;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.conversation.domain.SupplementCommands.SupplementView;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Repository
public class SupplementRepository {
    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;

    public SupplementRepository(JdbcClient jdbc, ObjectMapper objectMapper) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
    }

    public Optional<TurnContext> turnContext(String turnId) {
        return jdbc.sql("""
                SELECT turn_id, conversation_id, branch_id, root_run_id, phase
                FROM conversation_turn
                WHERE turn_id = :turnId
                """)
                .param("turnId", turnId)
                .query((rs, rowNum) -> new TurnContext(
                        rs.getString("turn_id"),
                        rs.getString("conversation_id"),
                        rs.getString("branch_id"),
                        rs.getString("root_run_id"),
                        rs.getString("phase")
                ))
                .optional();
    }

    public void insertPending(
            String supplementId,
            TurnContext turn,
            String text,
            List<String> attachmentRefs,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO turn_supplement(
                    supplement_id, conversation_id, branch_id, turn_id,
                    message_id, text_content, attachment_refs_json, phase,
                    injected_after_round_id, version, created_at, updated_at
                ) VALUES (
                    :supplementId, :conversationId, :branchId, :turnId,
                    NULL, :text, :attachments, 'pending',
                    NULL, 1, :now, :now
                )
                """)
                .param("supplementId", supplementId)
                .param("conversationId", turn.conversationId())
                .param("branchId", turn.branchId())
                .param("turnId", turn.turnId())
                .param("text", text)
                .param("attachments", write(attachmentRefs))
                .param("now", now.toString())
                .update();
    }

    public Optional<SupplementRow> find(String supplementId) {
        return jdbc.sql("""
                SELECT * FROM turn_supplement
                WHERE supplement_id = :supplementId
                """)
                .param("supplementId", supplementId)
                .query((rs, rowNum) -> new SupplementRow(
                        rs.getString("supplement_id"),
                        rs.getString("conversation_id"),
                        rs.getString("branch_id"),
                        rs.getString("turn_id"),
                        rs.getString("message_id"),
                        rs.getString("text_content"),
                        readRefs(rs.getString("attachment_refs_json")),
                        rs.getString("phase"),
                        rs.getString("injected_after_round_id"),
                        rs.getLong("version"),
                        Instant.parse(rs.getString("created_at")),
                        Instant.parse(rs.getString("updated_at"))
                ))
                .optional();
    }

    public List<SupplementRow> pendingForTurn(String turnId) {
        return jdbc.sql("""
                SELECT * FROM turn_supplement
                WHERE turn_id = :turnId AND phase = 'pending'
                ORDER BY created_at, supplement_id
                """)
                .param("turnId", turnId)
                .query((rs, rowNum) -> new SupplementRow(
                        rs.getString("supplement_id"),
                        rs.getString("conversation_id"),
                        rs.getString("branch_id"),
                        rs.getString("turn_id"),
                        rs.getString("message_id"),
                        rs.getString("text_content"),
                        readRefs(rs.getString("attachment_refs_json")),
                        rs.getString("phase"),
                        rs.getString("injected_after_round_id"),
                        rs.getLong("version"),
                        Instant.parse(rs.getString("created_at")),
                        Instant.parse(rs.getString("updated_at"))
                ))
                .list();
    }

    public boolean hasPending(String turnId) {
        return jdbc.sql("""
                SELECT COUNT(*)
                FROM turn_supplement
                WHERE turn_id = :turnId AND phase = 'pending'
                """)
                .param("turnId", turnId)
                .query(Integer.class)
                .single() > 0;
    }

    public List<SupplementView> viewsForTurn(String turnId) {
        return jdbc.sql("""
                SELECT * FROM turn_supplement
                WHERE turn_id = :turnId
                ORDER BY created_at, supplement_id
                """)
                .param("turnId", turnId)
                .query((rs, rowNum) -> new SupplementView(
                        rs.getString("supplement_id"),
                        rs.getString("turn_id"),
                        rs.getString("message_id"),
                        rs.getString("phase"),
                        rs.getString("text_content"),
                        readRefs(rs.getString("attachment_refs_json")),
                        rs.getString("injected_after_round_id"),
                        Instant.parse(rs.getString("created_at")),
                        Instant.parse(rs.getString("updated_at")),
                        rs.getLong("version")
                ))
                .list();
    }

    public boolean cancel(String supplementId, long expectedVersion, Instant now) {
        return jdbc.sql("""
                UPDATE turn_supplement
                SET phase = 'cancelled', version = version + 1, updated_at = :now
                WHERE supplement_id = :supplementId
                  AND phase = 'pending' AND version = :expectedVersion
                """)
                .param("now", now.toString())
                .param("supplementId", supplementId)
                .param("expectedVersion", expectedVersion)
                .update() == 1;
    }

    public boolean markInjected(
            String supplementId,
            long expectedVersion,
            String messageId,
            String injectedAfterRoundId,
            Instant now
    ) {
        return jdbc.sql("""
                UPDATE turn_supplement
                SET phase = 'injected', message_id = :messageId,
                    injected_after_round_id = :afterRoundId,
                    version = version + 1, updated_at = :now
                WHERE supplement_id = :supplementId
                  AND phase = 'pending' AND version = :expectedVersion
                """)
                .param("messageId", messageId)
                .param("afterRoundId", injectedAfterRoundId)
                .param("now", now.toString())
                .param("supplementId", supplementId)
                .param("expectedVersion", expectedVersion)
                .update() == 1;
    }

    private String write(List<String> refs) {
        try {
            return objectMapper.writeValueAsString(refs);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("Cannot serialize attachment refs", exception);
        }
    }

    private List<String> readRefs(String json) {
        try {
            return objectMapper.readValue(json, new TypeReference<>() {});
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("Stored attachment refs are invalid", exception);
        }
    }

    public record TurnContext(
            String turnId,
            String conversationId,
            String branchId,
            String rootRunId,
            String phase
    ) {
    }

    public record SupplementRow(
            String supplementId,
            String conversationId,
            String branchId,
            String turnId,
            String messageId,
            String text,
            List<String> attachmentRefs,
            String phase,
            String injectedAfterRoundId,
            long version,
            Instant createdAt,
            Instant updatedAt
    ) {
        public SupplementView view() {
            return new SupplementView(
                    supplementId, turnId, messageId, phase, text,
                    attachmentRefs, injectedAfterRoundId, createdAt,
                    updatedAt, version
            );
        }
    }
}
