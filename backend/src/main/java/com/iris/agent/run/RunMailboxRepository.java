package com.iris.agent.run;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.agent.model.ModelInputItem;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Durable asynchronous messages between Runs. */
@Repository
public class RunMailboxRepository {
    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;

    public RunMailboxRepository(JdbcClient jdbc, ObjectMapper objectMapper) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
    }

    public MailboxMessage enqueue(
            String targetRunId,
            String sourceRunId,
            String kind,
            String content,
            JsonNode payload,
            Instant now
    ) {
        String messageId = "runmsg_" + UUID.randomUUID()
                .toString().replace("-", "");
        jdbc.sql("""
                INSERT INTO run_mailbox_message(
                    message_id, target_run_id, source_run_id,
                    message_kind, content, payload_json, phase,
                    injection_round_id, created_at, injected_at
                ) VALUES (
                    :messageId, :targetRunId, :sourceRunId,
                    :kind, :content, :payload, 'queued',
                    NULL, :now, NULL
                )
                """)
                .param("messageId", messageId)
                .param("targetRunId", targetRunId)
                .param("sourceRunId", sourceRunId, java.sql.Types.VARCHAR)
                .param("kind", kind)
                .param("content", content)
                .param("payload", payload == null ? "{}" : payload.toString())
                .param("now", now.toString())
                .update();
        return find(messageId).orElseThrow();
    }

    public MailboxMessage enqueueTerminal(
            String targetRunId,
            String sourceRunId,
            String kind,
            String content,
            JsonNode payload,
            Instant now
    ) {
        if (!"completion".equals(kind) && !"cancellation".equals(kind)) {
            throw new IllegalArgumentException(
                    "Terminal mailbox kind is invalid"
            );
        }
        String messageId = "runmsg_terminal_" + sourceRunId + "_" + kind;
        jdbc.sql("""
                INSERT INTO run_mailbox_message(
                    message_id, target_run_id, source_run_id,
                    message_kind, content, payload_json, phase,
                    injection_round_id, created_at, injected_at
                ) VALUES (
                    :messageId, :targetRunId, :sourceRunId,
                    :kind, :content, :payload, 'queued',
                    NULL, :now, NULL
                )
                ON CONFLICT(message_id) DO NOTHING
                """)
                .param("messageId", messageId)
                .param("targetRunId", targetRunId)
                .param("sourceRunId", sourceRunId)
                .param("kind", kind)
                .param("content", content)
                .param("payload", payload == null ? "{}" : payload.toString())
                .param("now", now.toString())
                .update();
        return find(messageId).orElseThrow();
    }

    public List<MailboxMessage> pendingFor(
            String targetRunId,
            String branchId,
            boolean inheritTerminalRunMessages
    ) {
        return jdbc.sql("""
                SELECT message.* FROM run_mailbox_message message
                WHERE message.phase = 'queued'
                  AND (
                    message.target_run_id = :runId
                    OR (
                      :inheritTerminal = 1
                      AND message.message_kind IN ('completion', 'cancellation')
                      AND EXISTS (
                        SELECT 1 FROM agent_run target
                        WHERE target.run_id = message.target_run_id
                          AND target.branch_id = :branchId
                          AND target.phase IN (
                            'succeeded', 'failed', 'cancelled', 'timed_out'
                          )
                      )
                    )
                  )
                ORDER BY created_at, message_id
                """)
                .param("runId", targetRunId)
                .param("branchId", branchId)
                .param("inheritTerminal", inheritTerminalRunMessages ? 1 : 0)
                .query(this::map)
                .list();
    }

    public boolean markInjected(
            String messageId,
            String consumingRunId,
            String roundId,
            Instant now
    ) {
        return jdbc.sql("""
                UPDATE run_mailbox_message
                SET phase = 'injected', target_run_id = :consumingRunId,
                    injection_round_id = :roundId, injected_at = :now
                WHERE message_id = :messageId AND phase = 'queued'
                """)
                .param("consumingRunId", consumingRunId)
                .param("roundId", roundId)
                .param("now", now.toString())
                .param("messageId", messageId)
                .update() == 1;
    }

    public List<ModelInputItem> injectedBeforeOrAt(
            String runId,
            int roundIndex
    ) {
        return jdbc.sql("""
                SELECT message.message_id, message.message_kind,
                       message.content, source.round_index AS injection_index
                FROM run_mailbox_message message
                JOIN agent_round source
                  ON source.round_id = message.injection_round_id
                WHERE message.target_run_id = :runId
                  AND message.phase = 'injected'
                  AND source.round_index <= :roundIndex
                ORDER BY source.round_index, message.created_at,
                         message.message_id
                """)
                .param("runId", runId)
                .param("roundIndex", roundIndex)
                .query((rs, rowNum) -> (ModelInputItem)
                        new ModelInputItem.UserText(
                                rs.getString("message_id"),
                                envelope(
                                        rs.getString("message_kind"),
                                        rs.getString("content")
                                )
                        ))
                .list();
    }

    public Optional<MailboxMessage> find(String messageId) {
        return jdbc.sql("""
                SELECT * FROM run_mailbox_message
                WHERE message_id = :messageId
                """)
                .param("messageId", messageId)
                .query(this::map)
                .optional();
    }

    private String envelope(String kind, String content) {
        return switch (kind) {
            case "completion" -> "【后台运行完成】\n" + content;
            case "cancellation" -> "【后台运行已取消】\n" + content;
            default -> content;
        };
    }

    private MailboxMessage map(java.sql.ResultSet rs, int rowNum)
            throws java.sql.SQLException {
        try {
            return new MailboxMessage(
                    rs.getString("message_id"),
                    rs.getString("target_run_id"),
                    rs.getString("source_run_id"),
                    rs.getString("message_kind"),
                    rs.getString("content"),
                    objectMapper.readTree(rs.getString("payload_json")),
                    rs.getString("phase"),
                    rs.getString("injection_round_id"),
                    Instant.parse(rs.getString("created_at"))
            );
        } catch (com.fasterxml.jackson.core.JsonProcessingException exception) {
            throw new java.sql.SQLException("Stored mailbox payload is invalid", exception);
        }
    }

    public record MailboxMessage(
            String messageId,
            String targetRunId,
            String sourceRunId,
            String kind,
            String content,
            JsonNode payload,
            String phase,
            String injectionRoundId,
            Instant createdAt
    ) { }
}
