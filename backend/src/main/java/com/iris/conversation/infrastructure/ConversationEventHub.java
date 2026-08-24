package com.iris.conversation.infrastructure;

import com.iris.conversation.domain.ConversationEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Sinks;

import java.util.Collection;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.AtomicLong;

@Component
public final class ConversationEventHub {
    private static final Logger log = LoggerFactory.getLogger(
            ConversationEventHub.class
    );
    private final ConcurrentMap<String, Sinks.Many<ConversationEvent>> hubs =
            new ConcurrentHashMap<>();
    /** 背压溢出丢弃计数（可观测性）：非零说明有慢客户端在静默丢事件 */
    private final AtomicLong overflowDrops = new AtomicLong();

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
            if (hub == null) {
                continue;
            }
            Sinks.EmitResult result = hub.tryEmitNext(event);
            if (result == Sinks.EmitResult.FAIL_NON_SERIALIZED) {
                hub.emitNext(event, (signalType, emitResult) ->
                        emitResult == Sinks.EmitResult.FAIL_NON_SERIALIZED
                );
            } else if (result.isFailure()) {
                // FAIL_OVERFLOW / FAIL_CANCELLED / FAIL_TERMINATED：
                // 事件被丢弃，前端靠 Last-Event-ID 重连补；此前静默无感，
                // 现在至少可观测（慢客户端"卡住/少字"的第一嫌疑）。
                long drops = overflowDrops.incrementAndGet();
                if (drops == 1 || drops % 64 == 0) {
                    log.warn(
                            "Conversation event dropped by sink backpressure: "
                                    + "conversation={}, result={}, totalDrops={}",
                            event.conversationId(), result, drops
                    );
                }
            }
        }
    }
}
