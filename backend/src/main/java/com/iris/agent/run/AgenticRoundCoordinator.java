package com.iris.agent.run;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.agent.model.ModelAttemptRepository.AttemptRow;
import com.iris.agent.model.ModelAttemptService;
import com.iris.agent.model.ModelContext;
import com.iris.agent.model.ModelContextAssembler;
import com.iris.agent.model.ModelContextAssembler.ContextSeed;
import com.iris.agent.model.ModelProtocolException;
import com.iris.agent.model.ModelRequest;
import com.iris.agent.model.ModelStreamAssembler;
import com.iris.agent.model.provider.ModelProvider;
import com.iris.agent.model.provider.ModelProviderRegistry;
import com.iris.agent.model.provider.ModelProviderException;
import com.iris.agent.run.RoundToolCoordinator.RoundToolProgress;
import com.iris.agent.run.RunRoundRepository.RoundRow;
import com.iris.agent.run.RunRoundRepository.RunRow;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.nio.file.Path;
import java.util.Map;

/**
 * Advances one durable Agentic Round without owning a long-lived Java loop.
 */
@Service
public class AgenticRoundCoordinator {
    private final RunRoundRepository runFacts;
    private final ModelContextAssembler contexts;
    private final ModelProviderRegistry providers;
    private final ModelAttemptService attempts;
    private final RoundToolCoordinator tools;
    private final ObjectMapper objectMapper;

    public AgenticRoundCoordinator(
            RunRoundRepository runFacts,
            ModelContextAssembler contexts,
            ModelProviderRegistry providers,
            ModelAttemptService attempts,
            RoundToolCoordinator tools,
            ObjectMapper objectMapper
    ) {
        this.runFacts = runFacts;
        this.contexts = contexts;
        this.providers = providers;
        this.attempts = attempts;
        this.tools = tools;
        this.objectMapper = objectMapper;
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
                    case COMPLETED, FAILED -> Mono.just(new RoundAdvance(
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
                    ModelContext context = contexts.assemble(
                            loaded.run(),
                            loaded.round(),
                            contextSeed
                    );
                    AttemptRow attempt = attempts.begin(
                            loaded.round().roundId(),
                            loaded.round().version(),
                            provider.profileId(),
                            provider.modelId(),
                            context.contextHash(),
                            context.capabilityLeaseHash()
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
                                    "providerKind", provider.providerKind(),
                                    "contextHash", context.contextHash(),
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
                    return new StartedAttempt(attempt, request);
                })
                .subscribeOn(Schedulers.boundedElastic())
                .flatMap(started -> consume(
                        provider,
                        started,
                        workspaceRoot,
                        cancelled
                ));
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
        Mono<RoundRow> committed = provider.stream(started.request())
                .timeout(provider.timeout())
                .doOnNext(assembler::accept)
                .then(Mono.fromCallable(() -> attempts.commit(
                        started.attempt().attemptId(),
                        started.attempt().version(),
                        assembler.finish()
                )).subscribeOn(Schedulers.boundedElastic()))
                .onErrorResume(error -> failAttempt(started.attempt(), error));

        return committed.flatMap(round -> {
            if (round.phase() == RoundPhase.AWAITING_TOOLS) {
                return advanceTools(round, workspaceRoot, cancelled);
            }
            return Mono.just(new RoundAdvance(
                    round.roundId(),
                    round.phase(),
                    started.attempt().attemptId(),
                    false
            ));
        });
    }

    private Mono<RoundRow> failAttempt(AttemptRow attempt, Throwable error) {
        return Mono.<RoundRow>fromCallable(() -> {
                    attempts.fail(attempt.attemptId(), category(error));
                    throw propagate(error);
                })
                .subscribeOn(Schedulers.boundedElastic());
    }

    private Mono<RoundAdvance> advanceTools(
            RoundRow round,
            Path workspaceRoot,
            boolean cancelled
    ) {
        return Mono.fromCallable(() -> {
                    RoundToolProgress progress = tools.advance(
                            round.roundId(),
                            workspaceRoot,
                            cancelled
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
        return error instanceof RuntimeException runtime
                ? runtime
                : new IllegalStateException("Model provider failed", error);
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
            AttemptRow attempt,
            ModelRequest request
    ) {
    }
}
