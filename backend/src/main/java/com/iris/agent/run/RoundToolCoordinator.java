package com.iris.agent.run;

import com.iris.agent.model.ModelAttemptRepository;
import com.iris.agent.model.ModelAttemptRepository.ObservationSource;
import com.iris.agent.model.ModelAttemptRepository.RoundToolCall;
import com.iris.agent.model.ModelTokenEstimator;
import com.iris.agent.model.ToolObservationService;
import com.iris.agent.run.RunRoundRepository.RoundRow;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolExecutionViews.Invocation;
import com.iris.tools.core.ToolExecutionViews.RuntimeResult;
import com.iris.tools.core.ToolManifest.ConcurrencySemantics;
import com.iris.tools.core.ToolManifest.ContextRetention;
import com.iris.tools.core.ToolRegistry;
import com.iris.tools.core.ToolRegistry.ToolBinding;
import com.iris.tools.core.ToolRuntime;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.conversation.application.RunEventEmitter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.BooleanSupplier;

/**
 * 把已提交 Model ToolCall 交给唯一 ToolRuntime，并在全部终止后形成 observations。
 */
@Service
public class RoundToolCoordinator {
    private final ModelAttemptRepository modelFacts;
    private final ToolRuntime toolRuntime;
    private final ToolRegistry toolRegistry;
    private final ToolObservationService observations;
    private final RunRoundRepository runFacts;
    private final RunRoundService runRounds;
    private final ToolProjectionService projections;
    private final RunEventEmitter lifecycleEvents;
    private final RunCancellationRegistry cancellations;
    private final AgentRunContextRepository runContexts;
    private final ModelTokenEstimator tokenEstimator;
    private final int maxParallelReadTools;
    private final int roundToolResultBudgetTokens;

    public RoundToolCoordinator(
            ModelAttemptRepository modelFacts,
            ToolRuntime toolRuntime,
            ToolRegistry toolRegistry,
            ToolObservationService observations,
            RunRoundRepository runFacts,
            RunRoundService runRounds,
            ToolProjectionService projections,
            RunEventEmitter lifecycleEvents,
            RunCancellationRegistry cancellations,
            AgentRunContextRepository runContexts,
            ModelTokenEstimator tokenEstimator,
            @Value("${iris.agent.max-parallel-read-tools:4}")
            int maxParallelReadTools,
            @Value("${iris.agent.round-tool-result-budget-tokens:24000}")
            int roundToolResultBudgetTokens
    ) {
        this.modelFacts = modelFacts;
        this.toolRuntime = toolRuntime;
        this.toolRegistry = toolRegistry;
        this.observations = observations;
        this.runFacts = runFacts;
        this.runRounds = runRounds;
        this.projections = projections;
        this.lifecycleEvents = lifecycleEvents;
        this.cancellations = cancellations;
        this.runContexts = runContexts;
        this.tokenEstimator = tokenEstimator;
        if (maxParallelReadTools < 1 || maxParallelReadTools > 16) {
            throw new IllegalArgumentException(
                    "max-parallel-read-tools must be between 1 and 16"
            );
        }
        this.maxParallelReadTools = maxParallelReadTools;
        if (roundToolResultBudgetTokens < 0) {
            throw new IllegalArgumentException(
                    "round-tool-result-budget-tokens must be non-negative"
            );
        }
        this.roundToolResultBudgetTokens = roundToolResultBudgetTokens;
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
        Set<String> referenceOnlyExecutionIds = referenceOnlyExecutionIds(
                executions
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
                boolean referenceOnly = referenceOnlyExecutionIds.contains(
                        execution.executionId()
                );
                observations.capture(
                        call.toolCallId(),
                        execution.executionId(),
                        referenceOnly
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
            if (parallelSafe(
                    call,
                    run,
                    roundId,
                    workspaceRoot,
                    initiallyCancelled
            )) {
                parallelBatch.add(call);
                continue;
            }
            if (!flushParallel(
                    parallelBatch,
                    executions,
                    run,
                    roundId,
                    workspaceRoot,
                    initiallyCancelled
            )) {
                return List.copyOf(executions);
            }
            CallExecution serial = invoke(
                    call,
                    run,
                    roundId,
                    workspaceRoot,
                    initiallyCancelled
            );
            executions.add(serial);
            if (!serial.execution().terminal()) {
                return List.copyOf(executions);
            }
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

    private boolean flushParallel(
            List<RoundToolCall> batch,
            List<CallExecution> target,
            RunRow run,
            String roundId,
            Path workspaceRoot,
            boolean initiallyCancelled
    ) {
        if (batch.isEmpty()) {
            return true;
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
        return completed.stream()
                .allMatch(item -> item.execution().terminal());
    }

    private CallExecution invoke(
            RoundToolCall call,
            RunRow run,
            String roundId,
            Path workspaceRoot,
            boolean initiallyCancelled
    ) {
        ToolContext context = context(
                run,
                roundId,
                workspaceRoot,
                initiallyCancelled
        );
        try {
            RuntimeResult execution = toolRuntime.invoke(
                    new Invocation(call.toolCallId(), call.toolName()),
                    call.arguments(),
                    context
            );
            return new CallExecution(call, execution);
        } catch (ToolRuntimeException exception) {
            RuntimeResult synthetic = observations.recordSyntheticToolFailure(
                    call,
                    context,
                    exception
            );
            return new CallExecution(call, synthetic);
        }
    }

    private boolean parallelSafe(
            RoundToolCall call,
            RunRow run,
            String roundId,
            Path workspaceRoot,
            boolean initiallyCancelled
    ) {
        return toolRuntime.schedulingConcurrency(
                new Invocation(call.toolCallId(), call.toolName()),
                call.arguments(),
                context(
                        run,
                        roundId,
                        workspaceRoot,
                        initiallyCancelled
                )
        ) == ConcurrencySemantics.PARALLEL_SAFE;
    }

    private Set<String> referenceOnlyExecutionIds(
            List<CallExecution> executions
    ) {
        if (roundToolResultBudgetTokens <= 0) {
            return Set.of();
        }
        List<ExecutionSize> sizes = new ArrayList<>();
        for (CallExecution item : executions) {
            RuntimeResult execution = item.execution();
            if (!execution.terminal()) {
                continue;
            }
            // 与 ToolObservationMicroCompactor 对齐：PINNED 结果
            // 以及无法按稳定 executionId 读回的结果不能被引用替换。
            if (!canReplaceWithReference(execution)) {
                continue;
            }
            ObservationSource source = observations.observationSource(
                    item.call().toolCallId(),
                    execution.executionId()
            );
            String output = source.outputJson();
            int tokens = output == null
                    ? 0
                    : tokenEstimator.estimateText(output);
            sizes.add(new ExecutionSize(
                    execution.executionId(),
                    item.call().ordinal(),
                    tokens
            ));
        }
        int total = sizes.stream()
                .mapToInt(ExecutionSize::tokens)
                .sum();
        if (total <= roundToolResultBudgetTokens) {
            return Set.of();
        }
        List<ExecutionSize> candidates = new ArrayList<>(sizes);
        candidates.sort(Comparator.comparingInt(ExecutionSize::ordinal)
                .thenComparing(
                        Comparator.comparingInt(ExecutionSize::tokens)
                                .reversed()
                ));
        Set<String> referenceOnly = new HashSet<>();
        for (ExecutionSize candidate : candidates) {
            if (total <= roundToolResultBudgetTokens) {
                break;
            }
            total -= candidate.tokens();
            referenceOnly.add(candidate.executionId());
        }
        return referenceOnly;
    }

    private boolean canReplaceWithReference(RuntimeResult execution) {
        if (!"succeeded".equals(execution.outcomeKind())
                || execution.executionId() == null
                || execution.toolName() == null) {
            return false;
        }
        ToolBinding binding = toolRegistry.find(execution.toolName())
                .orElse(null);
        if (binding == null
                || binding.manifest().contextRetention()
                != ContextRetention.REFETCHABLE) {
            return false;
        }
        return modelFacts.payloadHash(execution.executionId()).isPresent();
    }

    private ToolContext context(
            RunRow run,
            String roundId,
            Path workspaceRoot,
            boolean initiallyCancelled
    ) {
        BooleanSupplier cancellation = () -> initiallyCancelled
                || cancellations.isCancelled(run.runId());
        boolean externalWritesAllowed = runContexts.find(run.runId())
                .map(AgentRunContextRepository.RunContext::externalWritesAllowed)
                .orElse(true);
        return new RoundToolContext(
                run.conversationId(),
                run.turnId(),
                run.runId(),
                roundId,
                workspaceRoot,
                cancellation,
                externalWritesAllowed
        );
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
            BooleanSupplier cancellation,
            boolean externalWritesAllowed
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

    private record ExecutionSize(
            String executionId,
            int ordinal,
            int tokens
    ) {
    }
}
