package com.iris.agent.run;

import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Sinks;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Process-local cancellation accelerator. Durable StopRequest facts remain
 * authoritative; losing this registry only delays cancellation to recovery.
 */
@Component
public class RunCancellationRegistry {
    private final ConcurrentHashMap<String, Entry> entries =
            new ConcurrentHashMap<>();

    public void signal(String runId) {
        Entry entry = entries.computeIfAbsent(runId, ignored -> new Entry());
        entry.cancelled.set(true);
        entry.signal.tryEmitEmpty();
    }

    public boolean isCancelled(String runId) {
        Entry entry = entries.get(runId);
        return entry != null && entry.cancelled.get();
    }

    public Mono<Void> whenCancelled(String runId) {
        Entry entry = entries.computeIfAbsent(runId, ignored -> new Entry());
        if (entry.cancelled.get()) {
            return Mono.empty();
        }
        return entry.signal.asMono();
    }

    public void clear(String runId) {
        entries.remove(runId);
    }

    private static final class Entry {
        private final AtomicBoolean cancelled = new AtomicBoolean(false);
        private final Sinks.One<Void> signal = Sinks.one();
    }
}
