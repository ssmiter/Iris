package com.iris.conversation.application;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.run.RunRoundRepository;
import com.iris.conversation.domain.ConversationEvent;
import com.iris.conversation.infrastructure.ConversationEventHub;
import com.iris.conversation.infrastructure.ConversationRepository;
import com.iris.storage.SqliteContention;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.locks.LockSupport;

/** Publishes a generated title without overwriting a title chosen by the user. */
@Service
public class GeneratedConversationTitleService {
    private static final int MAX_TITLE_CODE_POINTS = 40;
    private static final int MAX_BUSY_RETRIES = 2;

    private final ConversationRepository conversations;
    private final RunRoundRepository runs;
    private final ConversationLocks locks;
    private final TransactionTemplate transactions;
    private final ConversationEventHub eventHub;
    private final ObjectMapper objectMapper;
    private final Clock clock = Clock.systemUTC();

    public GeneratedConversationTitleService(
            ConversationRepository conversations,
            RunRoundRepository runs,
            ConversationLocks locks,
            TransactionTemplate transactions,
            ConversationEventHub eventHub,
            ObjectMapper objectMapper
    ) {
        this.conversations = conversations;
        this.runs = runs;
        this.locks = locks;
        this.transactions = transactions;
        this.eventHub = eventHub;
        this.objectMapper = objectMapper;
    }

    public PublishResult publish(
            String conversationId,
            String sourceRunId,
            String candidate
    ) {
        String title = normalize(candidate);
        if (title.isBlank()) {
            return new PublishResult("", false, "generated_title_empty");
        }
        PublishTransaction result = locks.withLock(
                conversationId,
                () -> publishWithBusyRetry(conversationId, sourceRunId, title)
        );
        if (result == null) {
            throw new IllegalStateException(
                    "Generated title transaction returned no result"
            );
        }
        if (result.event() != null) {
            eventHub.publish(List.of(result.event()));
        }
        return result.result();
    }

    /**
     * Retries only SQLite's transient writer contention; the title write is
     * naturally idempotent because publishLocked re-checks the placeholder
     * before writing. Mirrors ConversationEventAppender's backoff.
     */
    private PublishTransaction publishWithBusyRetry(
            String conversationId,
            String sourceRunId,
            String title
    ) {
        for (int attempt = 0; ; attempt++) {
            try {
                return transactions.execute(status -> publishLocked(
                        conversationId,
                        sourceRunId,
                        title
                ));
            } catch (RuntimeException exception) {
                if (!SqliteContention.isBusy(exception)
                        || attempt >= MAX_BUSY_RETRIES) {
                    throw exception;
                }
                LockSupport.parkNanos(
                        Duration.ofMillis(50L << attempt).toNanos()
                );
            }
        }
    }

    public boolean needsGeneratedTitle(String conversationId) {
        return conversations.findConversationMetadata(conversationId)
                .map(metadata -> placeholder(metadata.title()))
                .orElse(false);
    }

    private PublishTransaction publishLocked(
            String conversationId,
            String sourceRunId,
            String title
    ) {
        var metadata = conversations.findConversationMetadata(conversationId)
                .orElseThrow(() -> new IllegalArgumentException(
                        "Conversation not found"
                ));
        if (!placeholder(metadata.title())) {
            return new PublishTransaction(
                    new PublishResult(
                            metadata.title(),
                            false,
                            "user_title_preserved"
                    ),
                    null
            );
        }
        var source = runs.findRun(sourceRunId).orElseThrow(() ->
                new IllegalArgumentException("Source Run not found")
        );
        long version = conversations.updateConversationTitle(
                conversationId,
                metadata.version(),
                title,
                clock.instant()
        );
        if (version < 0) {
            throw new IllegalStateException(
                    "Conversation title changed concurrently"
            );
        }
        var now = clock.instant();
        ObjectNode view = objectMapper.createObjectNode();
        view.put("conversationId", conversationId);
        view.put("title", title);
        view.put("updatedAt", now.toString());
        view.put("version", version);
        ObjectNode payload = objectMapper.createObjectNode();
        payload.set("conversation", view);
        ConversationEvent event = new ConversationEvent(
                1,
                id("evt"),
                "conversation.updated",
                conversationId,
                source.branchId(),
                source.turnId(),
                source.runId(),
                source.parentRunId(),
                conversations.nextEventSequence(conversationId),
                new ConversationEvent.AggregateRef(
                        "conversation", conversationId, version
                ),
                sourceRunId,
                source.rootRunId(),
                now,
                payload
        );
        conversations.insertEvent(event);
        return new PublishTransaction(
                new PublishResult(title, true, "generated_title_published"),
                event
        );
    }

    private String normalize(String candidate) {
        if (candidate == null) {
            return "";
        }
        String firstLine = candidate.strip().lines()
                .filter(line -> !line.isBlank())
                .findFirst()
                .orElse("")
                .replaceFirst("^#{1,6}\\s*", "")
                .replaceFirst("^[\"'“‘《]+", "")
                .replaceFirst("[\"'”’》。]+$", "")
                .replaceAll("\\s+", " ")
                .trim();
        int count = firstLine.codePointCount(0, firstLine.length());
        if (count <= MAX_TITLE_CODE_POINTS) {
            return firstLine;
        }
        int end = firstLine.offsetByCodePoints(0, MAX_TITLE_CODE_POINTS);
        return firstLine.substring(0, end).stripTrailing();
    }

    private boolean placeholder(String title) {
        return title == null || title.isBlank() || "新对话".equals(title.trim());
    }

    private String id(String prefix) {
        return prefix + "_" + UUID.randomUUID().toString().replace("-", "");
    }

    public record PublishResult(
            String title,
            boolean published,
            String reason
    ) { }

    private record PublishTransaction(
            PublishResult result,
            ConversationEvent event
    ) { }
}
