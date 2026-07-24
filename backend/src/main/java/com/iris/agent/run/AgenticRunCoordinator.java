package com.iris.agent.run;

import com.iris.agent.model.ModelContextAssembler.ContextSeed;
import com.iris.agent.model.AnswerProjectionService;
import com.iris.agent.model.AgentContextPolicy;
import com.iris.agent.run.AgenticRoundCoordinator.RoundAdvance;
import com.iris.agent.run.RunRoundRepository.RoundRow;
import com.iris.agent.run.RunRoundRepository.RunBudget;
import com.iris.agent.run.RunRoundRepository.RunRow;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.nio.file.Path;
import java.time.Clock;

/**
 * Drives durable Rounds until a user-attention or terminal boundary is reached.
 */
@Service
public class AgenticRunCoordinator {
    private static final int MAX_ROUNDS_PER_ADVANCE = 64;

    private final RunRoundRepository facts;
    private final RunRoundService states;
    private final AgenticRoundCoordinator rounds;
    private final AnswerProjectionService answers;
    private final AgentContextPolicy contextPolicy;
    private final Clock clock = Clock.systemUTC();

    public AgenticRunCoordinator(
            RunRoundRepository facts,
            RunRoundService states,
            AgenticRoundCoordinator rounds,
            AnswerProjectionService answers,
            AgentContextPolicy contextPolicy
    ) {
        this.facts = facts;
        this.states = states;
        this.rounds = rounds;
        this.answers = answers;
        this.contextPolicy = contextPolicy;
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
                            ? contextPolicy.seedFor(runId)
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
                                    "round_advance_failed"
                            ));
                });
    }

    private NextRound next(String runId) {
        RunRow run = requireRun(runId);
        if (run.phase().terminal()) {
            return new NextRound(null, view(run, false, null), null);
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
            return new NextRound(null, null, "round_failed");
        }
        if (latest.phase() == RoundPhase.COMPLETED) {
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
                        return view(run, false, null);
                    }
                    RunRow failed = states.transitionRun(
                            runId,
                            run.version(),
                            RunPhase.FAILED
                    );
                    facts.settleTurn(run.turnId(), "failed", clock.instant());
                    return view(failed, false, null, reason);
                })
                .subscribeOn(Schedulers.boundedElastic());
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
        return view(succeeded, false, null);
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
