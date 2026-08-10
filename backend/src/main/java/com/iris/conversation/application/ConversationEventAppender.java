package com.iris.conversation.application;

import com.fasterxml.jackson.databind.JsonNode;
import com.iris.conversation.domain.ConversationEvent;
import com.iris.conversation.infrastructure.ConversationEventHub;
import com.iris.conversation.infrastructure.ConversationRepository;
import com.iris.storage.SqliteContention;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.locks.LockSupport;

/**
 * Appends post-command projection events with a conversation-local sequence.
 */
@Service
public class ConversationEventAppender {
    private static final int MAX_BUSY_RETRIES = 2;
    private final ConversationRepository repository;
    private final ConversationEventHub hub;
    private final ConversationLocks locks;
    private final TransactionTemplate transactions;
    private final Clock clock = Clock.systemUTC();

    public ConversationEventAppender(
            ConversationRepository repository,
            ConversationEventHub hub,
            ConversationLocks locks,
            TransactionTemplate transactions
    ) {
        this.repository = repository;
        this.hub = hub;
        this.locks = locks;
        this.transactions = transactions;
    }

    public ConversationEvent append(EventDraft draft) {
        ConversationEvent event = locks.withLock(
                draft.conversationId(),
                () -> appendWithBusyRetry(draft)
        );
        if (event == null) {
            throw new IllegalStateException(
                    "Conversation event transaction returned no result"
            );
        }
        hub.publish(List.of(event));
        return event;
    }

    private ConversationEvent appendWithBusyRetry(EventDraft draft) {
        for (int attempt = 0; ; attempt++) {
            try {
                return transactions.execute(status -> {
                    long sequence = repository.nextEventSequence(
                            draft.conversationId()
                    );
                    ConversationEvent created = new ConversationEvent(
                            1,
                            id("evt"),
                            draft.eventType(),
                            draft.conversationId(),
                            draft.branchId(),
                            draft.turnId(),
                            draft.runId(),
                            draft.parentRunId(),
                            sequence,
                            new ConversationEvent.AggregateRef(
                                    draft.aggregateKind(),
                                    draft.aggregateId(),
                                    draft.aggregateVersion()
                            ),
                            draft.causationId(),
                            draft.correlationId(),
                            clock.instant(),
                            draft.payload()
                    );
                    repository.insertEvent(created);
                    repository.incrementConversationVersion(
                            draft.conversationId(),
                            created.occurredAt()
                    );
                    return created;
                });
            } catch (RuntimeException exception) {
                if (!SqliteContention.isBusy(exception)
                        || attempt >= MAX_BUSY_RETRIES) {
                    throw exception;
                }
                LockSupport.parkNanos(
                        java.time.Duration.ofMillis(50L << attempt).toNanos()
                );
            }
        }
    }

    private String id(String prefix) {
        return prefix + "_" + UUID.randomUUID().toString().replace("-", "");
    }

    public record EventDraft(
            String eventType,
            String conversationId,
            String branchId,
            String turnId,
            String runId,
            String parentRunId,
            String aggregateKind,
            String aggregateId,
            long aggregateVersion,
            String causationId,
            String correlationId,
            JsonNode payload
    ) {
        public EventDraft(
                String eventType,
                String conversationId,
                String branchId,
                String turnId,
                String runId,
                String aggregateKind,
                String aggregateId,
                long aggregateVersion,
                String causationId,
                String correlationId,
                JsonNode payload
        ) {
            this(
                    eventType,
                    conversationId,
                    branchId,
                    turnId,
                    runId,
                    null,
                    aggregateKind,
                    aggregateId,
                    aggregateVersion,
                    causationId,
                    correlationId,
                    payload
            );
        }
    }
}
