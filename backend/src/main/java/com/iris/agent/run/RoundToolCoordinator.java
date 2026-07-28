package com.iris.agent.run;

import com.iris.agent.model.ModelAttemptRepository;
import com.iris.agent.model.ModelAttemptRepository.RoundToolCall;
import com.iris.agent.model.ToolObservationService;
import com.iris.agent.run.RunRoundRepository.RoundRow;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolExecutionViews.Invocation;
import com.iris.tools.core.ToolExecutionViews.RuntimeResult;
import com.iris.tools.core.ToolManifest.ConcurrencySemantics;
import com.iris.tools.core.ToolRegistry;
import com.iris.tools.core.ToolRuntime;
import com.iris.conversation.application.RunEventEmitter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.function.BooleanSupplier;

/**
 * 把已提交 Model ToolCall 交给唯一 ToolRuntime，并在全部终止后形成 observations。
 */
@Service
public class RoundToolCoordinator {
    private final ModelAttemptRepository modelFacts;
    private final ToolRuntime toolRuntime;
    private final ToolObservationService observations;
    private final RunRoundRepository runFacts;
    private final RunRoundService runRounds;
    private final ToolProjectionService projections;
    private final RunEventEmitter lifecycleEvents;
    private final RunCancellationRegistry cancellations;
    private final ToolRegistry registry;
    private final int maxParallelReadTools;

    public RoundToolCoordinator(
            ModelAttemptRepository modelFacts,
            ToolRuntime toolRuntime,
            ToolObservationService observations,
            RunRoundRepository runFacts,
            RunRoundService runRounds,
            ToolProjectionService projections,
            RunEventEmitter lifecycleEvents,
            RunCancellationRegistry cancellations,
            ToolRegistry registry,
            @Value("${iris.agent.max-parallel-read-tools:4}")
            int maxParallelReadTools
    ) {
        this.modelFacts = modelFacts;
        this.toolRuntime = toolRuntime;
        this.observations = observations;
        this.runFacts = runFacts;
        this.runRounds = runRounds;
        this.projections = projections;
        this.lifecycleEvents = lifecycleEvents;
        this.cancellations = cancellations;
        this.registry = registry;
        if (maxParallelReadTools < 1 || maxParallelReadTools > 16) {
            throw new IllegalArgumentException(
                    "max-parallel-read-tools must be between 1 and 16"
            );
        }
        this.maxParallelReadTools = maxParallelReadTools;
    }

    public RoundToolProgress advance(
            String roundId,
            Path workspaceRoot,
            boolean cancelled
    ) {
        RoundRow round = runFacts.findRound(roundId).orElseThrow(
                () -> new IllegalStateException("找不到 Round")
        );
        if (round.phase() != RoundPhase.AWAITING_TOOLS) {
            throw new IllegalStateException(
                    "只有 awaiting_tools Round 可以推进工具"
            );
        }
        RunRow run = runFacts.findRun(round.runId()).orElseThrow();
        List<RoundToolCall> calls = modelFacts.roundToolCalls(roundId);
        if (calls.isEmpty()) {
            throw new IllegalStateException(
                    "awaiting_tools Round has no persisted ToolCall"
            );
        }
        List<CallExecution> executions = executeScheduled(
                calls,
                run,
                roundId,
                workspaceRoot,
                cancelled
        );
        List<RuntimeResult> results = new ArrayList<>();
        int observationCount = 0;
        boolean waiting = false;
        for (CallExecution item : executions) {
            RoundToolCall call = item.call();
            RuntimeResult execution = item.execution();
            results.add(execution);
            projections.project(roundId, call, execution);
            if (execution.terminal()) {
                observations.capture(
                        call.toolCallId(),
                        execution.executionId()
                );
                observationCount++;
            } else {
                waiting = true;
            }
        }

        RoundRow current = runFacts.findRound(roundId).orElseThrow();
        if (!waiting) {
            current = runRounds.transitionRound(
                    roundId,
                    current.version(),
                    RoundPhase.OBSERVATIONS_READY
            );
            current = runRounds.transitionRound(
                    roundId,
                    current.version(),
                    RoundPhase.COMPLETED
            );
        }
        if (waiting) {
            lifecycleEvents.roundUpdated(roundId);
        }
        lifecycleEvents.turnUpdated(run.turnId());
        return new RoundToolProgress(
                roundId,
                current.phase(),
                List.copyOf(results),
                observationCount,
                waiting
        );
    }

    private List<CallExecution> executeScheduled(
            List<RoundToolCall> calls,
            RunRow run,
            String roundId,
            Path workspaceRoot,
            boolean initiallyCancelled
    ) {
        List<CallExecution> executions = new ArrayList<>();
        List<RoundToolCall> parallelBatch = new ArrayList<>();
        for (RoundToolCall call : calls) {
            if (parallelSafe(call)) {
                parallelBatch.add(call);
                continue;
            }
            flushParallel(
                    parallelBatch,
                    executions,
                    run,
                    roundId,
                    workspaceRoot,
                    initiallyCancelled
            );
            executions.add(invoke(
                    call,
                    run,
                    roundId,
                    workspaceRoot,
                    initiallyCancelled
            ));
        }
        flushParallel(
                parallelBatch,
                executions,
                run,
                roundId,
                workspaceRoot,
                initiallyCancelled
        );
        return List.copyOf(executions);
    }

    private void flushParallel(
            List<RoundToolCall> batch,
            List<CallExecution> target,
            RunRow run,
            String roundId,
            Path workspaceRoot,
            boolean initiallyCancelled
    ) {
        if (batch.isEmpty()) {
            return;
        }
        List<CallExecution> completed = Flux.fromIterable(
                        List.copyOf(batch)
                )
                .flatMapSequential(
                        call -> Mono.fromCallable(() -> invoke(
                                        call,
                                        run,
                                        roundId,
                                        workspaceRoot,
                                        initiallyCancelled
                                ))
                                .subscribeOn(Schedulers.boundedElastic()),
                        maxParallelReadTools,
                        1
                )
                .collectList()
                .block();
        if (completed == null || completed.size() != batch.size()) {
            throw new IllegalStateException(
                    "Parallel Tool batch did not complete deterministically"
            );
        }
        target.addAll(completed);
        batch.clear();
    }

    private CallExecution invoke(
            RoundToolCall call,
            RunRow run,
            String roundId,
            Path workspaceRoot,
            boolean initiallyCancelled
    ) {
        BooleanSupplier cancellation = () -> initiallyCancelled
                || cancellations.isCancelled(run.runId());
        ToolContext context = new RoundToolContext(
                run.conversationId(),
                run.turnId(),
                run.runId(),
                roundId,
                workspaceRoot,
                cancellation
        );
        RuntimeResult execution = toolRuntime.invoke(
                new Invocation(call.toolCallId(), call.toolName()),
                call.arguments(),
                context
        );
        return new CallExecution(call, execution);
    }

    private boolean parallelSafe(RoundToolCall call) {
        return registry.find(call.toolName())
                .map(binding -> binding.manifest().concurrency()
                        == ConcurrencySemantics.PARALLEL_SAFE)
                .orElse(false);
    }

    public record RoundToolProgress(
            String roundId,
            RoundPhase phase,
            List<RuntimeResult> executions,
            int observationCount,
            boolean waitingForAttention
    ) {
    }

    private record RoundToolContext(
            String conversationId,
            String turnId,
            String runId,
            String roundId,
            Path workspaceRoot,
            BooleanSupplier cancellation
    ) implements ToolContext {
        @Override
        public boolean cancelled() {
            return cancellation.getAsBoolean();
        }
    }

    private record CallExecution(
            RoundToolCall call,
            RuntimeResult execution
    ) {
    }
}
