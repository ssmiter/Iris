package com.iris.agent.run;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.run.RunRoundRepository.RoundRow;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.conversation.application.ConversationEventAppender;
import com.iris.conversation.application.ConversationEventAppender.EventDraft;
import com.iris.conversation.application.ConversationLocks;
import com.iris.conversation.domain.SupplementCommands.SupplementView;
import com.iris.conversation.infrastructure.ConversationRepository;
import com.iris.conversation.infrastructure.SupplementRepository;
import com.iris.conversation.infrastructure.SupplementRepository.SupplementRow;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Converts queued supplement facts into model-visible messages exactly at a
 * round boundary and creates the stable render nodes used by hydration/SSE.
 */
@Service
public class SupplementInjectionService {
    private final SupplementRepository supplements;
    private final ConversationRepository conversations;
    private final ObjectMapper objectMapper;
    private final SupplementProjectionStore projections;
    private final ConversationLocks locks;
    private final TransactionTemplate transactions;
    private final ConversationEventAppender events;
    private final Clock clock = Clock.systemUTC();

    public SupplementInjectionService(
            SupplementRepository supplements,
            ConversationRepository conversations,
            ObjectMapper objectMapper,
            SupplementProjectionStore projections,
            ConversationLocks locks,
            TransactionTemplate transactions,
            ConversationEventAppender events
    ) {
        this.supplements = supplements;
        this.conversations = conversations;
        this.objectMapper = objectMapper;
        this.projections = projections;
        this.locks = locks;
        this.transactions = transactions;
        this.events = events;
    }

    public List<SupplementView> injectPending(RunRow run, RoundRow round) {
        List<Injection> injections = locks.withLock(
                run.conversationId(),
                () -> transactions.execute(status -> inject(run, round))
        );
        if (injections == null || injections.isEmpty()) {
            return List.of();
        }
        injections.forEach(injection -> emit(run, injection));
        return injections.stream().map(Injection::supplement).toList();
    }

    private List<Injection> inject(RunRow run, RoundRow round) {
        List<SupplementRow> pending =
                supplements.pendingForTurn(run.turnId());
        if (pending.isEmpty()) {
            return List.of();
        }
        String afterRoundId = projections.previousRoundId(
                run.runId(), round.index()
        );
        Instant now = clock.instant();
        List<Injection> result = new ArrayList<>(pending.size());
        for (SupplementRow queued : pending) {
            Instant factTime = now.plusNanos(result.size());
            String messageId = id("msg");
            conversations.insertMessage(
                    messageId,
                    run.conversationId(),
                    run.branchId(),
                    run.turnId(),
                    queued.text(),
                    "supplement:" + queued.supplementId(),
                    queued.attachmentRefs(),
                    factTime
            );
            if (!supplements.markInjected(
                    queued.supplementId(),
                    queued.version(),
                    messageId,
                    afterRoundId,
                    factTime
            )) {
                throw new IllegalStateException(
                        "Supplement changed while entering a round boundary"
                );
            }
            SupplementView view = supplements.find(
                    queued.supplementId()
            ).orElseThrow().view();
            ObjectNode node = projections.insert(run, round, view, now);
            result.add(new Injection(view, node));
        }
        return List.copyOf(result);
    }

    private void emit(RunRow run, Injection injection) {
        ObjectNode supplementPayload = objectMapper.createObjectNode();
        supplementPayload.set(
                "supplement",
                objectMapper.valueToTree(injection.supplement())
        );
        events.append(new EventDraft(
                "supplement.updated",
                run.conversationId(),
                run.branchId(),
                run.turnId(),
                run.runId(),
                "supplement",
                injection.supplement().supplementId(),
                injection.supplement().version(),
                null,
                run.runId(),
                supplementPayload
        ));

        ObjectNode nodePayload = objectMapper.createObjectNode();
        nodePayload.set("node", injection.node());
        events.append(new EventDraft(
                "render_node.added",
                run.conversationId(),
                run.branchId(),
                run.turnId(),
                run.runId(),
                "render_node",
                injection.node().path("nodeId").asText(),
                1,
                null,
                run.runId(),
                nodePayload
        ));
    }

    private String id(String prefix) {
        return prefix + "_" + UUID.randomUUID().toString().replace("-", "");
    }

    private record Injection(
            SupplementView supplement,
            ObjectNode node
    ) {
    }
}
