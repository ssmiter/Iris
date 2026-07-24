package com.iris.conversation.application;

import com.iris.conversation.domain.ConversationEvent;
import com.iris.conversation.domain.ApiProblemException;
import com.iris.conversation.infrastructure.ConversationEventHub;
import com.iris.conversation.infrastructure.ConversationRepository;
import org.springframework.stereotype.Service;
import org.springframework.http.HttpStatus;
import reactor.core.Disposable;
import reactor.core.publisher.Flux;
import reactor.core.publisher.FluxSink;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.OptionalLong;

@Service
public final class ConversationEventStreamService {
    private final ConversationRepository repository;
    private final ConversationEventHub eventHub;

    public ConversationEventStreamService(
            ConversationRepository repository,
            ConversationEventHub eventHub
    ) {
        this.repository = repository;
        this.eventHub = eventHub;
    }

    public Flux<ConversationEvent> stream(
            String conversationId,
            OptionalLong afterSequence
    ) {
        return Flux.create(sink -> openStream(conversationId, afterSequence, sink),
                FluxSink.OverflowStrategy.BUFFER);
    }

    public Mono<OptionalLong> resolveStart(
            String conversationId,
            String eventCursor
    ) {
        return Mono.fromCallable(() -> {
                    if (!repository.conversationExists(conversationId)) {
                        throw new ApiProblemException(
                                HttpStatus.NOT_FOUND,
                                "conversation_not_found",
                                "not_found",
                                "找不到这个对话。"
                        );
                    }
                    if (eventCursor == null || eventCursor.isBlank()) {
                        return OptionalLong.empty();
                    }
                    OptionalLong sequence =
                            repository.resolveEventCursor(conversationId, eventCursor);
                    if (sequence.isEmpty()) {
                        throw new ApiProblemException(
                                HttpStatus.GONE,
                                "event_cursor_unavailable",
                                "precondition",
                                "这个事件游标不属于当前对话或已经不可用。"
                        );
                    }
                    return sequence;
                })
                .subscribeOn(Schedulers.boundedElastic());
    }

    private void openStream(
            String conversationId,
            OptionalLong afterSequence,
            FluxSink<ConversationEvent> sink
    ) {
        Object monitor = new Object();
        List<ConversationEvent> pendingLiveEvents = new ArrayList<>();
        boolean[] replaying = {true};

        Disposable liveSubscription = eventHub.live(conversationId).subscribe(
                event -> {
                    synchronized (monitor) {
                        if (replaying[0]) {
                            pendingLiveEvents.add(event);
                        } else {
                            sink.next(event);
                        }
                    }
                },
                sink::error
        );

        Disposable replaySubscription = Mono.fromCallable(() -> {
                    long watermark = repository.latestEventSequence(conversationId);
                    long replayAfter = afterSequence.isPresent()
                            ? afterSequence.getAsLong()
                            : watermark;
                    List<ConversationEvent> replay =
                            repository.findEvents(conversationId, replayAfter, watermark);
                    return new ReplayBatch(watermark, replay);
                })
                .subscribeOn(Schedulers.boundedElastic())
                .subscribe(
                        batch -> {
                            synchronized (monitor) {
                                batch.events().forEach(sink::next);
                                pendingLiveEvents.stream()
                                        .filter(event -> event.sequence() > batch.watermark())
                                        .sorted(Comparator.comparingLong(ConversationEvent::sequence))
                                        .forEach(sink::next);
                                pendingLiveEvents.clear();
                                replaying[0] = false;
                            }
                        },
                        sink::error
                );

        sink.onDispose(() -> {
            liveSubscription.dispose();
            replaySubscription.dispose();
        });
    }

    private record ReplayBatch(long watermark, List<ConversationEvent> events) {
    }
}
