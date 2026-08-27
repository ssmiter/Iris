package com.iris.agent.run;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.agent.model.AutoCompactionService;
import com.iris.agent.model.ModelAttemptRepository.AttemptRow;
import com.iris.agent.model.AnswerStreamProjector;
import com.iris.agent.model.ModelAttemptResult;
import com.iris.agent.model.ModelAttemptService;
import com.iris.agent.model.ModelAttemptService.FailureDiagnostic;
import com.iris.agent.model.ModelContext;
import com.iris.agent.model.ModelContextAssembler;
import com.iris.agent.model.ModelContextAssembler.ContextSeed;
import com.iris.agent.model.PromptTooLargeException;
import com.iris.agent.model.ModelProtocolException;
import com.iris.agent.model.ModelRequest;
import com.iris.agent.model.ModelStreamAssembler;
import com.iris.agent.model.ToolObservationService;
import com.iris.agent.model.provider.ModelProvider;
import com.iris.agent.model.provider.ModelProviderRegistry;
import com.iris.agent.model.provider.ModelProviderException;
import com.iris.agent.run.RoundToolCoordinator.RoundToolProgress;
import com.iris.agent.run.RunRoundRepository.RoundRow;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.conversation.application.RunEventEmitter;
import com.iris.conversation.infrastructure.TurnStopRepository;
import com.iris.storage.SqliteContention;
import com.iris.tools.core.ToolRuntime;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import reactor.core.Exceptions;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Advances one durable Agentic Round without owning a long-lived Java loop.
 */
@Service
public class AgenticRoundCoordinator {
    private static final int MAX_ATTEMPTS_PER_ROUND = 5;
    private static final int MAX_CONTEXT_OVERFLOW_RECOVERIES = 2;
    private static final double OVERFLOW_BUDGET_REDUCTION_RATIO = 0.85;
    private static final long BASE_RETRY_DELAY_MILLIS = 250;
    private static final long MAX_BACKOFF_MILLIS = 2_000;
    private static final Duration MAX_ROOT_RETRY_AFTER =
            Duration.ofSeconds(10);
    private static final Duration MAX_BACKGROUND_RETRY_AFTER =
            Duration.ofSeconds(60);

    private final RunRoundRepository runFacts;
    private final ModelContextAssembler contexts;
    private final ModelProviderRegistry providers;
    private final ModelAttemptService attempts;
    private final RoundToolCoordinator tools;
    private final ObjectMapper objectMapper;
    private final AnswerStreamProjector answerStreams;
    private final RunEventEmitter lifecycleEvents;
    private final SupplementInjectionService supplementInjections;
    private final RunMailboxInjectionService mailboxInjections;
    private final TurnStopRepository stopRequests;
    private final RunCancellationRegistry cancellations;
    private final RunFinalizationPolicy finalizationPolicy;
    private final AutoCompactionService autoCompactions;
    private final ToolObservationService toolObservations;
    private final ToolRuntime toolRuntime;
    private final AgentRunContextRepository runContexts;
    private final double compactionWarningRatio;
    private final double compactionBlockingRatio;
    private final boolean speculationEnabled;
    private final int speculationMaxParallel;
    private final Clock clock = Clock.systemUTC();

    public AgenticRoundCoordinator(
            RunRoundRepository runFacts,
            ModelContextAssembler contexts,
            ModelProviderRegistry providers,
            ModelAttemptService attempts,
            RoundToolCoordinator tools,
            ObjectMapper objectMapper,
            AnswerStreamProjector answerStreams,
            RunEventEmitter lifecycleEvents,
            SupplementInjectionService supplementInjections,
            RunMailboxInjectionService mailboxInjections,
            TurnStopRepository stopRequests,
            RunCancellationRegistry cancellations,
            RunFinalizationPolicy finalizationPolicy,
            AutoCompactionService autoCompactions,
            ToolObservationService toolObservations,
            ToolRuntime toolRuntime,
            AgentRunContextRepository runContexts,
            @Value("${iris.agent.compaction.warning-ratio:0.85}")
            double compactionWarningRatio,
            @Value("${iris.agent.compaction.blocking-ratio:0.95}")
            double compactionBlockingRatio,
            @Value("${iris.agent.speculation.enabled:true}")
            boolean speculationEnabled,
            @Value("${iris.agent.speculation.max-parallel:2}")
            int speculationMaxParallel
    ) {
        this.runFacts = runFacts;
        this.contexts = contexts;
        this.providers = providers;
        this.attempts = attempts;
        this.tools = tools;
        this.objectMapper = objectMapper;
        this.answerStreams = answerStreams;
        this.lifecycleEvents = lifecycleEvents;
        this.supplementInjections = supplementInjections;
        this.mailboxInjections = mailboxInjections;
        this.stopRequests = stopRequests;
        this.cancellations = cancellations;
        this.finalizationPolicy = finalizationPolicy;
        this.autoCompactions = autoCompactions;
        this.toolObservations = toolObservations;
        this.toolRuntime = toolRuntime;
        this.runContexts = runContexts;
        this.compactionWarningRatio = compactionWarningRatio;
        this.compactionBlockingRatio = compactionBlockingRatio;
        if (speculationMaxParallel < 1 || speculationMaxParallel > 16) {
            throw new IllegalArgumentException(
                    "speculation max-parallel must be between 1 and 16"
            );
        }
        this.speculationEnabled = speculationEnabled;
        this.speculationMaxParallel = speculationMaxParallel;
    }

    public Mono<RoundAdvance> advance(
            String roundId,
            String providerProfile,
            ContextSeed contextSeed,
            Path workspaceRoot,
            boolean cancelled
    ) {
        return Mono.fromCallable(() -> load(roundId))
                .subscribeOn(Schedulers.boundedElastic())
                .flatMap(loaded -> switch (loaded.round().phase()) {
                    case ACCEPTED -> streamModel(
                            loaded,
                            providerProfile,
                            contextSeed,
                            workspaceRoot,
                            cancelled
                    );
                    case AWAITING_TOOLS -> advanceTools(
                            loaded.round(),
                            workspaceRoot,
                            cancelled
                    );
                    case COMPLETED, STOPPED, FAILED -> Mono.just(new RoundAdvance(
                            loaded.round().roundId(),
                            loaded.round().phase(),
                            null,
                            false
                    ));
                    default -> Mono.error(new IllegalStateException(
                            "Round is already being advanced: "
                                    + loaded.round().phase()
                    ));
                });
    }

    private Mono<RoundAdvance> streamModel(
            LoadedRound loaded,
            String providerProfile,
            ContextSeed contextSeed,
            Path workspaceRoot,
            boolean cancelled
    ) {
        ModelProvider provider = providers.require(providerProfile);
        return Mono.fromCallable(() -> {
                    if (loaded.run().root()) {
                        supplementInjections.injectPending(
                                loaded.run(),
                                loaded.round()
                        );
                    }
                    mailboxInjections.injectPending(
                            loaded.run(),
                            loaded.round()
                    );
                    ModelContext context = contexts.assemble(
                            loaded.run(),
                            loaded.round(),
                            contextSeed
                    );
                    double originalRatio = contextPressureRatio(context);
                    context = compactIfBlocking(loaded, contextSeed, context);
                    if (loaded.run().root()) {
                        lifecycleEvents.contextUsageUpdated(
                                context,
                                loaded.run(),
                                contextPressurePhase(originalRatio)
                        );
                    }
                    AttemptRow attempt = attempts.begin(
                            loaded.round().roundId(),
                            loaded.round().version(),
                            provider.profileId(),
                            provider.modelId(),
                            context.contextHash(),
                            context.capabilityLeaseHash()
                    );
                    lifecycleEvents.roundUpdated(
                            loaded.round().roundId()
                    );
                    ModelRequest request = new ModelRequest(
                            attempt.attemptId(),
                            loaded.run().conversationId(),
                            loaded.run().runId(),
                            loaded.round().roundId(),
                            provider.modelId(),
                            context.systemInstruction(),
                            context.items(),
                            context.tools(),
                            Map.of(
                                    "providerProfile", provider.profileId(),
                                    "providerKind", provider.providerKind(),
                                    "contextHash", context.contextHash(),
                                    "promptDefinitionId",
                                    context.promptPrefix()
                                            .promptDefinitionId(),
                                    "promptVersion",
                                    Integer.toString(
                                            context.promptPrefix()
                                                    .promptVersion()
                                    ),
                                    "prefixHash",
                                    context.promptPrefix().prefixHash(),
                                    "capabilityLeaseHash",
                                    context.capabilityLeaseHash(),
                                    "estimatedInputTokens",
                                    Integer.toString(
                                            context.estimatedInputTokens()
                                    ),
                                    "droppedFactCount",
                                    Integer.toString(
                                            context.droppedFactCount()
                                    )
                            )
                    );
                    return new StartedAttempt(
                            loaded.run(),
                            loaded.round(),
                            attempt,
                            request,
                            contextSeed
                    );
                })
                .subscribeOn(Schedulers.boundedElastic())
                // 先 map 出内层 Mono 再压平：让 onErrorResume 只覆盖 assemble
                // 段（此时尚无 attempt，走 LoadedRound 恢复路径）；consume 段
                // 的错误由 consume 自己的 handleAttemptFailure 处理。
                .map(started -> consume(
                        provider,
                        started,
                        workspaceRoot,
                        cancelled
                ))
                .onErrorResume(error -> handleAssembleOverflow(
                        provider,
                        loaded,
                        contextSeed,
                        workspaceRoot,
                        cancelled,
                        error
                ).map(Mono::just))
                .flatMap(advance -> advance);
    }

    private Mono<RoundAdvance> consume(
            ModelProvider provider,
            StartedAttempt started,
            Path workspaceRoot,
            boolean cancelled
    ) {
        ModelStreamAssembler assembler = new ModelStreamAssembler(
                started.attempt().attemptId(),
                objectMapper
        );
        StreamingToolSpeculator speculator = new StreamingToolSpeculator(
                toolRuntime,
                cancellations,
                runContexts,
                objectMapper,
                speculationEnabled,
                speculationMaxParallel,
                started.attempt().attemptId(),
                started.run(),
                started.round().roundId(),
                workspaceRoot,
                cancelled
        );
        AtomicBoolean attemptCommitted = new AtomicBoolean(false);
        Mono<RoundRow> committed = provider.stream(started.request())
                .timeout(provider.timeout())
                .takeUntilOther(
                        cancellations.whenCancelled(started.run().runId())
                                .then(Mono.error(
                                        new RunCancellationException()
                                ))
                )
                .publishOn(Schedulers.boundedElastic())
                .doOnNext(event -> {
                    assembler.accept(event);
                    speculator.accept(event);
                    answerStreams.accept(
                            started.run(),
                            started.round(),
                            started.attempt().attemptId(),
                            event
                    );
                })
                .then(Mono.fromCallable(() -> {
                    ModelAttemptResult result = assembler.finish();
                    RoundRow round = attempts.commit(
                            started.attempt().attemptId(),
                            started.attempt().version(),
                            result
                    );
                    attemptCommitted.set(true);
                    speculator.close();
                    String visibleText = visibleText(result);
                    if (visibleText.isBlank()) {
                        answerStreams.discard(started.attempt().attemptId());
                    } else {
                        boolean finalizationRetry = result.toolCalls().isEmpty()
                                && !"max_tokens".equals(result.stopReason())
                                && finalizationPolicy.evaluate(
                                        started.run().runId()
                                ).continueRun();
                        answerStreams.complete(
                                started.run(),
                                round,
                                started.attempt().attemptId(),
                                visibleText,
                                result.toolCalls().isEmpty()
                                        && !"max_tokens".equals(
                                                result.stopReason()
                                        )
                                        && !finalizationRetry
                                        ? "final"
                                        : "stage"
                        );
                    }
                    lifecycleEvents.roundUpdated(round.roundId());
                    return round;
                }).subscribeOn(Schedulers.boundedElastic()));

        return committed
                .flatMap(round -> {
                    if (round.phase() == RoundPhase.AWAITING_TOOLS) {
                        return advanceTools(
                                round,
                                workspaceRoot,
                                cancelled
                        );
                    }
                    return Mono.just(new RoundAdvance(
                            round.roundId(),
                            round.phase(),
                            started.attempt().attemptId(),
                            false
                    ));
                })
                .onErrorResume(error -> handleAttemptFailure(
                        provider,
                        started,
                        workspaceRoot,
                        cancelled,
                        attemptCommitted.get(),
                        speculator,
                        error
                ));
    }

    private Mono<RoundAdvance> handleAttemptFailure(
            ModelProvider provider,
            StartedAttempt started,
            Path workspaceRoot,
            boolean cancelled,
            boolean attemptCommitted,
            StreamingToolSpeculator speculator,
            Throwable error
    ) {
        Throwable cause = Exceptions.unwrap(error);
        if (attemptCommitted) {
            answerStreams.discard(started.attempt().attemptId());
            return Mono.error(propagate(cause));
        }
        answerStreams.invalidate(
                started.run().conversationId(),
                started.attempt().attemptId()
        );
        // invalidate 与下游取消/重试/溢出分支同路，一次 discard 全覆盖：
        // 阻止新投机并跳过尚未开始的排队任务；已开始执行的只读调用
        // 任其完成，孤儿 execution 行按设计不回收。
        speculator.discard();
        boolean stopRequested = cancelled
                || cause instanceof RunCancellationException
                || cancellations.isCancelled(started.run().runId())
                || (started.run().root()
                    && stopRequests.requested(started.run().turnId()));
        if (stopRequested) {
            return cancelAttempt(started.attempt())
                    .map(round -> new RoundAdvance(
                            round.roundId(),
                            round.phase(),
                            started.attempt().attemptId(),
                            false
                    ));
        }
        if (isPromptTooLarge(cause)
                && started.contextSeed().contextOverflowRecoveries()
                        < MAX_CONTEXT_OVERFLOW_RECOVERIES) {
            return recoverContextOverflow(
                    provider,
                    started,
                    workspaceRoot,
                    cancelled,
                    cause
            );
        }
        if (retryableWithinInteractiveBudget(cause, started.run().root())
                && started.attempt().attemptIndex() + 1
                < MAX_ATTEMPTS_PER_ROUND) {
            return retryAttempt(
                    provider,
                    started,
                    workspaceRoot,
                    cancelled,
                    cause
            );
        }
        return failAttempt(started.attempt(), cause);
    }

    private Mono<RoundAdvance> handleAssembleOverflow(
            ModelProvider provider,
            LoadedRound loaded,
            ContextSeed contextSeed,
            Path workspaceRoot,
            boolean cancelled,
            Throwable error
    ) {
        Throwable cause = Exceptions.unwrap(error);
        if (!isPromptTooLarge(cause)) {
            return Mono.error(propagate(cause));
        }
        if (contextSeed.contextOverflowRecoveries()
                < MAX_CONTEXT_OVERFLOW_RECOVERIES) {
            return recoverContextOverflow(
                    provider,
                    loaded,
                    contextSeed,
                    workspaceRoot,
                    cancelled,
                    cause
            );
        }
        return failRoundForOverflow(provider, loaded, cause);
    }

    private Mono<RoundAdvance> retryAttempt(
            ModelProvider provider,
            StartedAttempt failed,
            Path workspaceRoot,
            boolean cancelled,
            Throwable error
    ) {
        Duration delay = retryDelay(failed.attempt().attemptIndex(), error);
        Mono<Boolean> wait = Mono.firstWithSignal(
                Mono.delay(delay).thenReturn(true),
                cancellations.whenCancelled(failed.run().runId())
                        .thenReturn(false)
        );
        return wait.flatMap(elapsed -> {
            boolean stopRequested = !elapsed
                    || cancelled
                    || cancellations.isCancelled(failed.run().runId())
                    || (failed.run().root()
                        && stopRequests.requested(failed.run().turnId()));
            if (stopRequested) {
                return cancelAttempt(failed.attempt())
                        .map(round -> new RoundAdvance(
                                round.roundId(),
                                round.phase(),
                                failed.attempt().attemptId(),
                                false
                        ));
            }
            return Mono.fromCallable(() -> {
                    AttemptRow successor = attempts.retry(
                            failed.attempt().attemptId(),
                            failed.attempt().version(),
                            category(error),
                            FailureDiagnostic.from(error)
                    );
                    RoundRow round = runFacts.findRound(
                            successor.roundId()
                    ).orElseThrow();
                    lifecycleEvents.roundUpdated(round.roundId());
                    return new StartedAttempt(
                            failed.run(),
                            round,
                            successor,
                            withAttemptId(
                                    failed.request(),
                                    successor.attemptId()
                            ),
                            failed.contextSeed()
                    );
                })
                .subscribeOn(Schedulers.boundedElastic())
                .flatMap(successor -> consume(
                        provider,
                        successor,
                        workspaceRoot,
                        cancelled
                ));
        });
    }

    private Mono<RoundAdvance> recoverContextOverflow(
            ModelProvider provider,
            StartedAttempt failed,
            Path workspaceRoot,
            boolean cancelled,
            Throwable error
    ) {
        return Mono.fromCallable(() -> attempts.failAndResetForOverflow(
                        failed.attempt().attemptId(),
                        category(error),
                        FailureDiagnostic.from(error)
                ))
                .subscribeOn(Schedulers.boundedElastic())
                .flatMap(resetRound -> streamModel(
                        new LoadedRound(failed.run(), resetRound),
                        provider.profileId(),
                        failed.contextSeed().withTighterBudget(
                                OVERFLOW_BUDGET_REDUCTION_RATIO
                        ),
                        workspaceRoot,
                        cancelled
                ));
    }

    /**
     * Recovery when context assembly itself overflows: no attempt has begun yet,
     * so the Round is still ACCEPTED and we only need to re-stream with a
     * tighter budget. Shares the same recovery counter as the provider path.
     */
    private Mono<RoundAdvance> recoverContextOverflow(
            ModelProvider provider,
            LoadedRound loaded,
            ContextSeed contextSeed,
            Path workspaceRoot,
            boolean cancelled,
            Throwable error
    ) {
        return streamModel(
                loaded,
                provider.profileId(),
                contextSeed.withTighterBudget(OVERFLOW_BUDGET_REDUCTION_RATIO),
                workspaceRoot,
                cancelled
        );
    }

    private Mono<RoundAdvance> failAttempt(
            AttemptRow attempt,
            Throwable error
    ) {
        return Mono.<RoundAdvance>fromCallable(() -> {
                    attempts.fail(
                            attempt.attemptId(),
                            category(error),
                            FailureDiagnostic.from(error)
                    );
                    lifecycleEvents.roundUpdated(attempt.roundId());
                    throw propagate(error);
                })
                .subscribeOn(Schedulers.boundedElastic());
    }

    private Mono<RoundAdvance> failRoundForOverflow(
            ModelProvider provider,
            LoadedRound loaded,
            Throwable error
    ) {
        return Mono.<RoundAdvance>fromCallable(() -> {
                    RoundRow round = attempts.failAcceptedRoundForOverflow(
                            loaded.round().roundId(),
                            provider.profileId(),
                            provider.modelId(),
                            category(error),
                            FailureDiagnostic.from(error)
                    );
                    lifecycleEvents.roundUpdated(round.roundId());
                    throw propagate(error);
                })
                .subscribeOn(Schedulers.boundedElastic());
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

    private boolean isPromptTooLarge(Throwable error) {
        if (error instanceof PromptTooLargeException) {
            return true;
        }
        if (error instanceof ModelProviderException provider) {
            return "prompt_too_large".equals(provider.category())
                    || Integer.valueOf(413).equals(provider.httpStatus());
        }
        return false;
    }

    private boolean retryable(Throwable error) {
        if (SqliteContention.isBusy(error)) {
            return true;
        }
        if (error instanceof ModelProviderException provider) {
            return provider.retryable();
        }
        return error instanceof java.util.concurrent.TimeoutException;
    }

    boolean retryableWithinInteractiveBudget(
            Throwable error,
            boolean rootRun
    ) {
        if (!retryable(error)) {
            return false;
        }
        if (error instanceof ModelProviderException provider
                && provider.retryAfter() != null) {
            Duration max = rootRun
                    ? MAX_ROOT_RETRY_AFTER
                    : MAX_BACKGROUND_RETRY_AFTER;
            return provider.retryAfter().compareTo(max) <= 0;
        }
        return true;
    }

    private Duration retryDelay(int failedAttemptIndex, Throwable error) {
        if (error instanceof ModelProviderException provider
                && provider.retryAfter() != null) {
            return provider.retryAfter();
        }
        int exponent = Math.min(Math.max(failedAttemptIndex, 0), 3);
        long backoff = Math.min(
                MAX_BACKOFF_MILLIS,
                BASE_RETRY_DELAY_MILLIS * (1L << exponent)
        );
        long jitter = ThreadLocalRandom.current().nextLong(0, 126);
        return Duration.ofMillis(backoff + jitter);
    }

    private Mono<RoundRow> cancelAttempt(AttemptRow attempt) {
        return Mono.fromCallable(() -> {
                    RoundRow round = attempts.cancel(attempt.attemptId());
                    lifecycleEvents.roundUpdated(round.roundId());
                    return round;
                })
                .subscribeOn(Schedulers.boundedElastic());
    }

    private Mono<RoundAdvance> advanceTools(
            RoundRow round,
            Path workspaceRoot,
            boolean cancelled
    ) {
        return Mono.fromCallable(() -> {
                    RunRow run = runFacts.findRun(round.runId())
                            .orElseThrow();
                    boolean stopRequested = run.root()
                            && stopRequests.requested(run.turnId());
                    boolean shouldCancel = cancelled || stopRequested;
                    if (shouldCancel) {
                        toolObservations.recordCancelledPendingCalls(
                                run.conversationId(),
                                run.turnId(),
                                run.runId(),
                                round.roundId(),
                                clock.instant()
                        );
                    }
                    RoundToolProgress progress = tools.advance(
                            round.roundId(),
                            workspaceRoot,
                            shouldCancel
                    );
                    return new RoundAdvance(
                            progress.roundId(),
                            progress.phase(),
                            null,
                            progress.waitingForAttention()
                    );
                })
                .subscribeOn(Schedulers.boundedElastic());
    }

    private ModelContext compactIfBlocking(
            LoadedRound loaded,
            ContextSeed contextSeed,
            ModelContext assembled
    ) {
        double ratio = contextPressureRatio(assembled);
        if (ratio < compactionBlockingRatio) {
            return assembled;
        }
        autoCompactions.requestCompaction(loaded.run().runId());
        return contexts.assemble(
                loaded.run(),
                loaded.round(),
                contextSeed.withTighterBudget(OVERFLOW_BUDGET_REDUCTION_RATIO)
        );
    }

    private String contextPressurePhase(ModelContext context) {
        return contextPressurePhase(contextPressureRatio(context));
    }

    private String contextPressurePhase(double ratio) {
        if (ratio >= compactionBlockingRatio) {
            return "blocking";
        }
        if (ratio >= compactionWarningRatio) {
            return "warning";
        }
        return null;
    }

    private double contextPressureRatio(ModelContext context) {
        int usable = context.maxInputTokens()
                - context.reservedOutputTokens();
        if (usable <= 0) {
            return 1.0;
        }
        return (double) context.estimatedInputTokens() / usable;
    }

    private LoadedRound load(String roundId) {
        RoundRow round = runFacts.findRound(roundId).orElseThrow(
                () -> new IllegalStateException("Round not found")
        );
        RunRow run = runFacts.findRun(round.runId()).orElseThrow(
                () -> new IllegalStateException("Run not found")
        );
        return new LoadedRound(run, round);
    }

    private String category(Throwable error) {
        error = Exceptions.unwrap(error);
        if (SqliteContention.isBusy(error)) {
            return "storage_busy";
        }
        if (error instanceof ModelProtocolException protocol) {
            return "protocol:" + protocol.code();
        }
        if (error instanceof ModelProviderException provider) {
            return provider.category();
        }
        if (error instanceof java.util.concurrent.TimeoutException) {
            return "provider_timeout";
        }
        return "provider_stream_failed";
    }

    private RuntimeException propagate(Throwable error) {
        error = Exceptions.unwrap(error);
        return error instanceof RuntimeException runtime
                ? runtime
                : new IllegalStateException("Model provider failed", error);
    }

    private String visibleText(ModelAttemptResult result) {
        return result.blocks().stream()
                .filter(block -> block.kind()
                        == com.iris.agent.model.ModelStreamEvent.BlockKind.TEXT)
                .sorted(java.util.Comparator.comparingInt(
                        ModelAttemptResult.ContentBlock::index
                ))
                .map(ModelAttemptResult.ContentBlock::text)
                .filter(java.util.Objects::nonNull)
                .collect(java.util.stream.Collectors.joining());
    }

    public record RoundAdvance(
            String roundId,
            RoundPhase phase,
            String attemptId,
            boolean waitingForAttention
    ) {
    }

    private record LoadedRound(RunRow run, RoundRow round) {
    }

    private record StartedAttempt(
            RunRow run,
            RoundRow round,
            AttemptRow attempt,
            ModelRequest request,
            ContextSeed contextSeed
    ) {
    }
}
