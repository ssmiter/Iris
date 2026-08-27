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
    /** 背压溢出重置次数（可观测性）：非零说明有慢客户端导致 SSE 流被强制重建 */
    private final AtomicLong overflowResets = new AtomicLong();

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
            } else if (result == Sinks.EmitResult.FAIL_OVERFLOW) {
                // 共享 hub 的缓冲区已满。继续静默丢弃会让 healthy 连接也永远缺事件
                // （run active、审批 waiting 等）。事件已先落库，所以对该 hub
                // emitError 强制所有当前订阅断线；客户端走 Last-Event-ID / after
                // 游标重连，按 ConversationEventStreamService 的 replay/live 拼接
                // 补齐 (afterSequence, watermark] 与 watermark 之后的 live 事件。
                long resets = overflowResets.incrementAndGet();
                log.warn(
                        "Conversation event hub backpressure overflow: "
                                + "conversation={}, totalOverflows={}. "
                                + "Terminating SSE stream so clients reconnect and replay.",
                        event.conversationId(), resets
                );
                Sinks.EmitResult errorResult = hub.tryEmitError(
                        new BackpressureOverflowException(
                                "Backpressure overflow for conversation "
                                        + event.conversationId()
                                        + "; terminating SSE stream to force replay."
                        )
                );
                if (errorResult.isFailure()
                        && errorResult != Sinks.EmitResult.FAIL_TERMINATED) {
                    log.debug(
                            "Failed to emit error on overflowed hub: "
                                    + "conversation={}, result={}",
                            event.conversationId(), errorResult
                    );
                }
                // 去掉已终止的 sink，后续连接会新建 hub 而不是一连上就收到终端信号。
                hubs.remove(event.conversationId(), hub);
            } else if (result.isFailure()) {
                // FAIL_CANCELLED / FAIL_TERMINATED：hub 已不健康，清理掉让新连接重建。
                hubs.remove(event.conversationId(), hub);
            }
        }
    }

    static final class BackpressureOverflowException extends RuntimeException {
        BackpressureOverflowException(String message) {
            super(message);
        }
    }
}
