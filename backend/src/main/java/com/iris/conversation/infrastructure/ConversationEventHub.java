package com.iris.conversation.infrastructure;

import com.iris.conversation.domain.ConversationEvent;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Sinks;

import java.util.Collection;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

@Component
public final class ConversationEventHub {
    private final ConcurrentMap<String, Sinks.Many<ConversationEvent>> hubs =
            new ConcurrentHashMap<>();

    public Flux<ConversationEvent> live(String conversationId) {
        return hubs.computeIfAbsent(
                        conversationId,
                        ignored -> Sinks.many().multicast().onBackpressureBuffer(256, false)
                )
                .asFlux();
    }

    public void publish(Collection<ConversationEvent> events) {
        for (ConversationEvent event : events) {
            Sinks.Many<ConversationEvent> hub = hubs.get(event.conversationId());
            if (hub != null) {
                hub.emitNext(event, (signalType, emitResult) ->
                        emitResult == Sinks.EmitResult.FAIL_NON_SERIALIZED
                );
            }
        }
    }
}
