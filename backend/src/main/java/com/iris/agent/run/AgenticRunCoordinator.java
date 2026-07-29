package com.iris.agent.run;

import com.iris.agent.model.ModelContextAssembler.ContextSeed;
import com.iris.agent.model.AnswerProjectionService;
import com.iris.agent.model.AgentContextPolicy;
import com.iris.agent.model.ModelProtocolException;
import com.iris.agent.model.provider.ModelProviderException;
import com.iris.agent.run.AgenticRoundCoordinator.RoundAdvance;
import com.iris.agent.run.RunRoundRepository.RoundRow;
import com.iris.agent.run.RunRoundRepository.RunBudget;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.conversation.application.RunEventEmitter;
import com.iris.conversation.domain.ConversationViews.FailureView;
import com.iris.conversation.infrastructure.TurnStopRepository;
import com.iris.tools.core.ToolRuntime;
import org.springframework.stereotype.Service;
import reactor.core.Exceptions;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.util.UUID;

/**
 * Drives durable Rounds until a user-attention or terminal boundary is reached.
 */
@Service
public class AgenticRunCoordinator {
    private static final int MAX_ROUNDS_PER_ADVANCE = 64;
    private static final int MAX_OUTPUT_CONTINUATIONS = 4;

    private final RunRoundRepository facts;
    private final RunRoundService states;
    private final AgenticRoundCoordinator rounds;
    private final AnswerProjectionService answers;
    private final AgentContextPolicy contextPolicy;
    private final RunEventEmitter lifecycleEvents;
    private final TurnStopRepository stopRequests;
    private final ToolRuntime toolRuntime;
    private final RunCancellationRegistry cancellations;
    private final Clock clock = Clock.systemUTC();

    public AgenticRunCoordinator(
            RunRoundRepository facts,
            RunRoundService states,
            AgenticRoundCoordinator rounds,
            AnswerProjectionService answers,
            AgentContextPolicy contextPolicy,
            RunEventEmitter lifecycleEvents,
            TurnStopRepository stopRequests,
            ToolRuntime toolRuntime,
            RunCancellationRegistry cancellations
    ) {
        this.facts = facts;
        this.states = states;
        this.rounds = rounds;
        this.answers = answers;
        this.contextPolicy = contextPolicy;
        this.lifecycleEvents = lifecycleEvents;
        this.stopRequests = stopRequests;
        this.toolRuntime = toolRuntime;
        this.cancellations = cancellations;
    }

    public Mono<RunAdvance> advance(
            String runId,
            String providerProfile,
            Path workspaceRoot,
            boolean cancelled
    ) {
        return step(
                runId,
                providerProfile,
                null,
                workspaceRoot,
                cancelled,
                0
        );
    }

    public Mono<RunAdvance> advance(
            String runId,
            String providerProfile,
            ContextSeed contextSeed,
            Path workspaceRoot,
            boolean cancelled
    ) {
        return step(
                runId,
                providerProfile,
                contextSeed,
                workspaceRoot,
                cancelled,
                0
        );
    }

    public Mono<RunAdvance> resume(
            String runId,
            String providerProfile,
            ContextSeed contextSeed,
            Path workspaceRoot,
            boolean cancelled
    ) {
        return Mono.fromCallable(() -> {
                    RunRow run = requireRun(runId);
                    if (run.phase() != RunPhase.SUSPENDED) {
                        throw new IllegalStateException(
                                "Only a suspended Run can be resumed"
                        );
                    }
                    return states.transitionRun(
                            runId,
                            run.version(),
                            RunPhase.RUNNING
                    );
                })
                .subscribeOn(Schedulers.boundedElastic())
                .flatMap(ignored -> advance(
                        runId,
                        providerProfile,
                        contextSeed,
                        workspaceRoot,
                        cancelled
                ));
    }

    public Mono<RunAdvance> resume(
            String runId,
            String providerProfile,
            Path workspaceRoot,
            boolean cancelled
    ) {
        return Mono.fromCallable(() -> {
                    RunRow run = requireRun(runId);
                    if (run.phase() != RunPhase.SUSPENDED) {
                        throw new IllegalStateException(
                                "Only a suspended Run can be resumed"
                        );
                    }
                    return states.transitionRun(
                            runId,
                            run.version(),
                            RunPhase.RUNNING
                    );
                })
                .subscribeOn(Schedulers.boundedElastic())
                .flatMap(ignored -> advance(
                        runId,
                        providerProfile,
                        workspaceRoot,
                        cancelled
                ));
    }

    private Mono<RunAdvance> step(
            String runId,
            String providerProfile,
            ContextSeed contextSeed,
            Path workspaceRoot,
            boolean cancelled,
            int roundsAdvanced
    ) {
        if (roundsAdvanced >= MAX_ROUNDS_PER_ADVANCE) {
            return failRun(runId, "round_limit_exceeded");
        }
        return Mono.fromCallable(() -> next(runId))
                .subscribeOn(Schedulers.boundedElastic())
                .flatMap(next -> {
                    if (next.terminal() != null) {
                        return Mono.just(next.terminal());
                    }
                    if (next.failure() != null) {
                        return failRun(runId, next.failure());
                    }
                    ContextSeed effectiveSeed = contextSeed == null
                            ? contextPolicy.seedFor(
                                    runId,
                                    next.round().roundId()
                            )
                            : contextSeed;
                    return rounds.advance(
                                    next.round().roundId(),
                                    providerProfile,
                                    effectiveSeed,
                                    workspaceRoot,
                                    cancelled
                            )
                            .flatMap(progress -> afterRound(
                                    runId,
                                    providerProfile,
                                    contextSeed,
                                    workspaceRoot,
                                    cancelled,
                                    roundsAdvanced,
                                    progress
                            ))
                            .onErrorResume(error -> failRun(
                                    runId,
                                    failureCode(error)
                            ));
                });
    }

    private NextRound next(String runId) {
        RunRow run = requireRun(runId);
        if (run.phase().terminal()) {
            return new NextRound(null, view(run, false, null), null);
        }
        if (stopRequests.requested(run.turnId())) {
            toolRuntime.cancelBeforeExecution(runId);
            RoundRow latest = facts.latestRound(runId).orElse(null);
            if (latest != null
                    && latest.phase() == RoundPhase.AWAITING_TOOLS) {
                return new NextRound(latest, null, null);
            }
            if (toolRuntime.hasCommittedActivity(runId)) {
                boolean enteredDraining = stopRequests.markDraining(
                        run.turnId(),
                        clock.instant()
                );
                if (enteredDraining) {
                    lifecycleEvents.turnUpdated(run.turnId());
                }
                if (latest != null && !latest.phase().terminal()) {
                    return new NextRound(latest, null, null);
                }
                throw new IllegalStateException(
                        "Committed tool activity has no resumable Round"
                );
            }
            return new NextRound(
                    null,
                    stopRun(run, latest),
                    null
            );
        }
        if (run.phase() != RunPhase.RUNNING) {
            throw new IllegalStateException(
                    "Run cannot advance from phase " + run.phase()
            );
        }
        RunBudget budget = facts.runBudget(runId);
        if (budget.exhausted()) {
            return new NextRound(null, null, "run_budget_exhausted");
        }
        RoundRow latest = facts.latestRound(runId).orElse(null);
        if (latest == null) {
            return new NextRound(states.openRound(runId), null, null);
        }
        if (latest.phase() == RoundPhase.COMPLETED
                && latest.toolCallCount() > 0) {
            answers.publishStage(latest.roundId());
            return new NextRound(states.openRound(runId), null, null);
        }
        if (latest.phase() == RoundPhase.FAILED) {
            return new NextRound(
                    null,
                    null,
                    facts.latestAttemptFailure(latest.roundId())
                            .orElse("round_failed")
            );
        }
        if (latest.phase() == RoundPhase.COMPLETED) {
            String stopReason = facts.latestCompletedAttemptStopReason(
                    latest.roundId()
            ).orElseThrow(() -> new ModelProtocolException(
                    "completed_round_missing_stop_reason",
                    "Completed Round has no completed model stop reason"
            ));
            if ("max_tokens".equals(stopReason)) {
                answers.publishStage(latest.roundId());
                if (facts.outputLimitStopCount(runId)
                        > MAX_OUTPUT_CONTINUATIONS) {
                    return new NextRound(
                            null,
                            null,
                            "model_output_continuation_limit"
                    );
                }
                return new NextRound(
                        states.openRound(runId),
                        null,
                        null
                );
            }
            answers.publishFinal(latest.roundId());
            return new NextRound(null, completeRun(run), null);
        }
        return new NextRound(latest, null, null);
    }

    private Mono<RunAdvance> afterRound(
            String runId,
            String providerProfile,
            ContextSeed contextSeed,
            Path workspaceRoot,
            boolean cancelled,
            int roundsAdvanced,
            RoundAdvance progress
    ) {
        if (progress.waitingForAttention()) {
            if (stopRequests.requested(
                    requireRun(runId).turnId()
            )) {
                return step(
                        runId,
                        providerProfile,
                        contextSeed,
                        workspaceRoot,
                        true,
                        roundsAdvanced + 1
                );
            }
            return Mono.fromCallable(() -> {
                        RunRow run = requireRun(runId);
                        RunRow suspended = states.transitionRun(
                                runId,
                                run.version(),
                                RunPhase.SUSPENDED
                        );
                        return view(suspended, true, progress.roundId());
                    })
                    .subscribeOn(Schedulers.boundedElastic());
        }
        if (progress.phase() == RoundPhase.FAILED) {
            return failRun(runId, "round_failed");
        }
        return step(
                runId,
                providerProfile,
                contextSeed,
                workspaceRoot,
                cancelled,
                roundsAdvanced + 1
        );
    }

    private Mono<RunAdvance> failRun(String runId, String reason) {
        return Mono.fromCallable(() -> {
                    RunRow run = requireRun(runId);
                    if (run.phase().terminal()) {
                        cancellations.clear(runId);
                        return view(run, false, null);
                    }
                    FailureView failure = failure(reason);
                    RunRow failed = states.failRun(
                            runId,
                            run.version(),
                            failure
                    );
                    facts.settleTurn(run.turnId(), "failed", clock.instant());
                    lifecycleEvents.turnUpdated(run.turnId());
                    cancellations.clear(runId);
                    return view(
                            failed,
                            false,
                            null,
                            failure.code()
                    );
                })
                .subscribeOn(Schedulers.boundedElastic());
    }

    private String failureCode(Throwable error) {
        error = Exceptions.unwrap(error);
        if (error instanceof ModelProtocolException protocol) {
            return protocol.code();
        }
        if (error instanceof ModelProviderException provider) {
            return provider.category();
        }
        if (error instanceof java.util.concurrent.TimeoutException) {
            return "provider_timeout";
        }
        return "round_advance_failed";
    }

    private FailureView failure(String code) {
        String category = "agent_kernel";
        String source = "agent_kernel";
        String recovery = "none";
        String message = "Iris 没能安全完成这次任务，运行状态和已有结果已经保留。";
        switch (code) {
            case "provider_rate_limited", "provider_unavailable",
                 "provider_timeout" -> {
                category = "external_dependency";
                source = "model_provider";
                recovery = "retry_same";
                message = "模型服务暂时不可用；Iris 已完成有限重试，但这次任务仍未能继续。";
            }
            case "provider_auth_failed" -> {
                category = "configuration";
                source = "model_provider";
                recovery = "user_input";
                message = "模型服务认证失败，请检查本机的 API 配置后再试。";
            }
            case "provider_request_rejected" -> {
                category = "provider_request";
                source = "model_provider";
                recovery = "none";
                message = "模型服务拒绝了本次请求，Iris 没有继续猜测或改写请求。";
            }
            case "prompt_too_large" -> {
                category = "context";
                source = "agent_kernel";
                recovery = "user_input";
                message = "当前上下文超过模型可接受范围，需要先压缩历史再继续。";
            }
            case "round_limit_exceeded", "run_budget_exhausted",
                 "model_output_continuation_limit" -> {
                category = "budget";
                message = "本次任务已经达到安全运行上限，Iris 已停止继续扩展步骤。";
            }
            case "process_interrupted" -> {
                category = "recovery";
                message = "Iris 在模型响应期间被中断；半截回答已失效，历史没有丢失。";
            }
            default -> {
                if (code.startsWith("provider_")) {
                    category = "model_provider";
                    source = "model_provider";
                } else if (code.startsWith("protocol:")
                        || code.contains("mismatch")
                        || code.contains("model_result")) {
                    category = "protocol";
                    source = "model_provider";
                }
            }
        }
        return new FailureView(
                code,
                category,
                message,
                "trace_" + UUID.randomUUID()
                        .toString()
                        .replace("-", ""),
                source,
                recovery,
                "n/a",
                null
        );
    }

    private RunAdvance completeRun(RunRow run) {
        RunRow verifying = states.transitionRun(
                run.runId(),
                run.version(),
                RunPhase.VERIFYING
        );
        RunRow succeeded = states.transitionRun(
                run.runId(),
                verifying.version(),
                RunPhase.SUCCEEDED
        );
        facts.settleTurn(run.turnId(), "settled", clock.instant());
        lifecycleEvents.turnUpdated(run.turnId());
        cancellations.clear(run.runId());
        return view(succeeded, false, null);
    }

    private RunAdvance stopRun(RunRow run, RoundRow latest) {
        if (latest != null && !latest.phase().terminal()) {
            states.transitionRound(
                    latest.roundId(),
                    latest.version(),
                    RoundPhase.STOPPED
            );
        }
        RunRow cancelledRun = states.transitionRun(
                run.runId(),
                run.version(),
                RunPhase.CANCELLED
        );
        Instant now = clock.instant();
        facts.settleTurn(run.turnId(), "stopped", now);
        stopRequests.complete(run.turnId(), now);
        lifecycleEvents.turnUpdated(run.turnId());
        cancellations.clear(run.runId());
        return view(cancelledRun, false, null);
    }

    private RunRow requireRun(String runId) {
        return facts.findRun(runId).orElseThrow(
                () -> new IllegalStateException("Run not found")
        );
    }

    private RunAdvance view(
            RunRow run,
            boolean waiting,
            String roundId
    ) {
        return view(run, waiting, roundId, null);
    }

    private RunAdvance view(
            RunRow run,
            boolean waiting,
            String roundId,
            String failure
    ) {
        return new RunAdvance(
                run.runId(),
                run.phase(),
                roundId,
                waiting,
                failure
        );
    }

    public record RunAdvance(
            String runId,
            RunPhase phase,
            String roundId,
            boolean waitingForAttention,
            String failure
    ) {
    }

    private record NextRound(
            RoundRow round,
            RunAdvance terminal,
            String failure
    ) {
    }
}
