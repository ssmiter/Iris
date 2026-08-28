package com.iris.agent.model;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.CompactionRepository.CompactionRow;
import com.iris.agent.model.CompactionService.CompactBoundary;
import com.iris.agent.model.CompactionService.CompactPlan;
import com.iris.agent.model.ModelAttemptRepository.AttemptRow;
import com.iris.agent.model.ModelAttemptService.FailureDiagnostic;
import com.iris.agent.model.ModelAttemptResult.ContentBlock;
import com.iris.agent.model.ModelStreamEvent.BlockKind;
import com.iris.agent.model.provider.ModelProvider;
import com.iris.agent.model.provider.ModelProviderException;
import com.iris.agent.model.provider.ModelProviderRegistry;
import com.iris.agent.run.RoundPhase;
import com.iris.agent.run.RunPhase;
import com.iris.agent.run.RunRoundRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.time.Clock;
import java.util.Map;

@Service
public final class CompactionCoordinator {
    private static final int MAX_ATTEMPTS = 3;

    private final CompactionRepository compactions;
    private final CompactionService frames;
    private final ModelProviderRegistry providers;
    private final ModelAttemptService attempts;
    private final ModelContextSnapshotRepository snapshots;
    private final ModelRequestSnapshotService requestSnapshots;
    private final RunRoundRepository runs;
    private final TransactionTemplate transactions;
    private final ObjectMapper objectMapper;
    private final Clock clock = Clock.systemUTC();
    private final CompactionSummaryContextFactory summaryContexts;

    public CompactionCoordinator(
            CompactionRepository compactions,
            CompactionService frames,
            ModelProviderRegistry providers,
            ModelAttemptService attempts,
            ModelContextSnapshotRepository snapshots,
            ModelRequestSnapshotService requestSnapshots,
            RunRoundRepository runs,
            TransactionTemplate transactions,
            ObjectMapper objectMapper,
            CompactionSummaryContextFactory summaryContexts
    ) {
        this.compactions = compactions;
        this.frames = frames;
        this.providers = providers;
        this.attempts = attempts;
        this.snapshots = snapshots;
        this.requestSnapshots = requestSnapshots;
        this.runs = runs;
        this.transactions = transactions;
        this.objectMapper = objectMapper;
        this.summaryContexts = summaryContexts;
    }

    public Mono<CompactBoundary> advance(
            String runId,
            String providerProfile
    ) {
        return Mono.fromCallable(() -> prepare(runId, providerProfile))
                .subscribeOn(Schedulers.boundedElastic())
                .flatMap(prepared -> {
                    if (prepared.completedSummary() != null) {
                        return finalizeFrame(
                                prepared.compaction(),
                                prepared.completedSummary()
                        );
                    }
                    return consume(prepared);
                })
                .onErrorResume(error -> Mono.fromRunnable(() ->
                                fail(runId, error))
                        .subscribeOn(Schedulers.boundedElastic())
                        .then(Mono.error(error)));
    }

    private Mono<CompactBoundary> consume(Prepared prepared) {
        ModelStreamAssembler assembler = new ModelStreamAssembler(
                prepared.attempt().attemptId(),
                objectMapper
        );
        // docs/42 §5.2：摘要请求同样是发给模型的请求，header 快照一体落库。
        requestSnapshots.capture(
                prepared.provider(),
                prepared.attempt(),
                prepared.request()
        );
        return prepared.provider()
                .stream(prepared.request())
                .timeout(prepared.provider().timeout())
                .doOnNext(assembler::accept)
                .then(Mono.fromCallable(assembler::finish))
                .flatMap(result -> commitAndFinalize(prepared, result))
                .onErrorResume(error -> {
                    Throwable cause = unwrap(error);
                    if (!retryable(cause)
                            || prepared.attempt().attemptIndex() + 1
                            >= MAX_ATTEMPTS) {
                        return Mono.error(cause);
                    }
                    return Mono.fromCallable(() -> {
                                AttemptRow successor = attempts.retry(
                                        prepared.attempt().attemptId(),
                                        prepared.attempt().version(),
                                        failureCode(cause),
                                        FailureDiagnostic.from(cause)
                                );
                                return new Prepared(
                                        prepared.compaction(),
                                        prepared.provider(),
                                        successor,
                                        withAttemptId(
                                                prepared.request(),
                                                successor.attemptId()
                                        ),
                                        null
                                );
                            })
                            .subscribeOn(Schedulers.boundedElastic())
                            .flatMap(this::consume);
                });
    }

    private ModelRequest withAttemptId(
            ModelRequest request,
            String attemptId
    ) {
        return new ModelRequest(
                attemptId,
                request.conversationId(),
                request.runId(),
                request.roundId(),
                request.modelId(),
                request.systemInstruction(),
                request.items(),
                request.tools(),
                request.metadata()
        );
    }

    private boolean retryable(Throwable error) {
        if (error instanceof ModelProviderException provider) {
            return provider.retryable();
        }
        return error instanceof java.util.concurrent.TimeoutException;
    }

    private Throwable unwrap(Throwable error) {
        Throwable current = reactor.core.Exceptions.unwrap(error);
        while (current.getCause() != null && current != current.getCause()) {
            current = current.getCause();
        }
        return current;
    }

    private Prepared prepare(String runId, String providerProfile) {
        CompactionRow row = compactions.find(runId).orElseThrow(
                () -> new IllegalArgumentException(
                        "Compaction Run does not exist"
                )
        );
        if ("completed".equals(row.phase())) {
            throw new IllegalStateException("Compaction is already completed");
        }
        if ("failed".equals(row.phase()) || "cancelled".equals(row.phase())) {
            throw new IllegalStateException("Compaction is already terminal");
        }
        if ("accepted".equals(row.phase())
                && !compactions.markRunning(
                        row.runId(),
                        row.version(),
                        clock.instant()
                )) {
            throw new IllegalStateException(
                    "Compaction start changed concurrently"
            );
        }
        RoundPhase roundPhase = runs.findRound(row.roundId())
                .orElseThrow()
                .phase();
        if (roundPhase == RoundPhase.COMPLETED) {
            String summary = compactions.completedSummary(row.roundId())
                    .orElseThrow(() -> new IllegalStateException(
                            "Completed compaction attempt has no text summary"
                    ));
            return new Prepared(row, null, null, null, summary);
        }
        if (roundPhase != RoundPhase.ACCEPTED) {
            throw new IllegalStateException(
                    "Compaction model step cannot resume from " + roundPhase
            );
        }

        ModelProvider provider = providers.require(providerProfile);
        ModelContext context = context(row);
        AttemptRow attempt = attempts.begin(
                row.roundId(),
                runs.findRound(row.roundId()).orElseThrow().version(),
                provider.profileId(),
                provider.modelId(),
                context.contextHash(),
                context.capabilityLeaseHash()
        );
        ModelRequest request = new ModelRequest(
                attempt.attemptId(),
                row.conversationId(),
                row.runId(),
                row.roundId(),
                provider.modelId(),
                context.systemInstruction(),
                context.items(),
                context.tools(),
                Map.of(
                        "providerProfile", provider.profileId(),
                        "pipeline", "compact_context",
                        "promptDefinitionId",
                        context.promptPrefix().promptDefinitionId(),
                        "promptVersion",
                        Integer.toString(
                                context.promptPrefix().promptVersion()
                        ),
                        "prefixHash", context.promptPrefix().prefixHash(),
                        "sourceSnapshotId", row.sourceSnapshotId(),
                        "sourceContentHash", row.sourceContentHash()
                )
        );
        return new Prepared(row, provider, attempt, request, null);
    }

    /**
     * The summary request reuses the last routed request's retained prefix
     * verbatim and carries the summary instruction in a trailing user message,
     * so the provider cache prefix warmed by that request stays usable. Any
     * miss (no routed snapshot, undecodable payload, reused prefix plus source
     * over budget) falls back to the standalone summary shape; correctness
     * never depends on cache reuse.
     */
    private ModelContext context(CompactionRow row) {
        var routedPrefix = snapshots
                .latestRoutedPrefix(row.conversationId(), row.branchId())
                .flatMap(snapshot -> RoutedRequestPrefix.restore(
                        objectMapper,
                        snapshot.contextHash(),
                        snapshot.payloadJson()
                ));
        CompactionSummaryContextFactory.SummaryContext built =
                summaryContexts.build(row, routedPrefix);
        snapshots.save(
                built.context(),
                row.conversationId(),
                row.branchId(),
                row.runId(),
                row.roundId(),
                built.payloadJson(),
                clock.instant()
        );
        return built.context();
    }

    private Mono<CompactBoundary> commitAndFinalize(
            Prepared prepared,
            ModelAttemptResult result
    ) {
        return Mono.fromCallable(() -> {
                    attempts.commit(
                            prepared.attempt().attemptId(),
                            prepared.attempt().version(),
                            result
                    );
                    String summary = result.blocks().stream()
                            .filter(block -> block.kind() == BlockKind.TEXT)
                            .map(ContentBlock::text)
                            .filter(text -> text != null && !text.isBlank())
                            .reduce((left, right) -> left + "\n" + right)
                            .orElseThrow(() -> new ModelProtocolException(
                                    "compaction_summary_missing",
                                    "Compaction model returned no text summary"
                            ));
                    return summary.trim();
                })
                .subscribeOn(Schedulers.boundedElastic())
                .flatMap(summary ->
                        finalizeFrame(prepared.compaction(), summary));
    }

    private Mono<CompactBoundary> finalizeFrame(
            CompactionRow row,
            String summary
    ) {
        return Mono.fromCallable(() -> transactions.execute(status -> {
                    var run = runs.findRun(row.runId()).orElseThrow();
                    if (run.phase() == RunPhase.RUNNING
                            && !runs.transitionRun(
                                    run.runId(),
                                    RunPhase.RUNNING,
                                    RunPhase.VERIFYING,
                                    run.version(),
                                    clock.instant()
                            )) {
                        throw new IllegalStateException(
                                "Compaction Run verification transition conflicted"
                        );
                    }
                    CompactPlan plan = new CompactPlan(
                            row.conversationId(),
                            row.branchId(),
                            row.parentFrameId(),
                            row.sourceStartSequence(),
                            row.beforeTurnId(),
                            row.waterlineSequence(),
                            null,
                            row.sourceFactCount(),
                            0
                    );
                    CompactBoundary boundary =
                            frames.record(plan, row.trigger(), summary);
                    compactions.complete(
                            row.runId(),
                            boundary.boundaryId(),
                            clock.instant()
                    );
                    return boundary;
                }))
                .subscribeOn(Schedulers.boundedElastic())
                .map(boundary -> {
                    if (boundary == null) {
                        throw new IllegalStateException(
                                "Compaction finalization returned no boundary"
                        );
                    }
                    return boundary;
                });
    }

    private void fail(String runId, Throwable error) {
        CompactionRow row = compactions.find(runId).orElse(null);
        if (row == null
                || "completed".equals(row.phase())
                || "failed".equals(row.phase())
                || "cancelled".equals(row.phase())) {
            return;
        }
        ObjectNode failure = objectMapper.createObjectNode();
        failure.put("code", failureCode(error));
        failure.put(
                "userMessage",
                "这次上下文整理没有完成，原始对话历史没有受到影响。"
        );
        failure.put("source", "compaction_pipeline");
        compactions.streamingAttemptId(runId).ifPresent(attemptId -> {
            try {
                attempts.fail(
                        attemptId,
                        failureCode(error),
                        FailureDiagnostic.from(error)
                );
            } catch (RuntimeException ignored) {
                // The durable failure projection below remains authoritative.
            }
        });
        compactions.fail(runId, write(failure), clock.instant());
    }

    private String failureCode(Throwable error) {
        Throwable current = error;
        while (current.getCause() != null && current != current.getCause()) {
            current = current.getCause();
        }
        if (current instanceof PromptTooLargeException) {
            return "compaction_source_too_large";
        }
        if (current instanceof ModelProtocolException protocol) {
            return protocol.code();
        }
        return "compaction_failed";
    }

    private String write(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "Cannot serialize compaction model context",
                    exception
            );
        }
    }

    private record Prepared(
            CompactionRow compaction,
            ModelProvider provider,
            AttemptRow attempt,
            ModelRequest request,
            String completedSummary
    ) {
    }
}
