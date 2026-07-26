package com.iris.agent.run;

import com.iris.agent.model.ModelAttemptRepository;
import com.iris.agent.model.ModelAttemptRepository.RoundToolCall;
import com.iris.agent.model.ToolObservationService;
import com.iris.agent.run.RunRoundRepository.RoundRow;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolExecutionViews.Invocation;
import com.iris.tools.core.ToolExecutionViews.RuntimeResult;
import com.iris.tools.core.ToolRuntime;
import com.iris.conversation.application.RunEventEmitter;
import com.iris.conversation.infrastructure.TurnStopRepository;
import org.springframework.stereotype.Service;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

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
    private final TurnStopRepository stopRequests;

    public RoundToolCoordinator(
            ModelAttemptRepository modelFacts,
            ToolRuntime toolRuntime,
            ToolObservationService observations,
            RunRoundRepository runFacts,
            RunRoundService runRounds,
            ToolProjectionService projections,
            RunEventEmitter lifecycleEvents,
            TurnStopRepository stopRequests
    ) {
        this.modelFacts = modelFacts;
        this.toolRuntime = toolRuntime;
        this.observations = observations;
        this.runFacts = runFacts;
        this.runRounds = runRounds;
        this.projections = projections;
        this.lifecycleEvents = lifecycleEvents;
        this.stopRequests = stopRequests;
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
        List<RuntimeResult> results = new ArrayList<>();
        int observationCount = 0;
        boolean waiting = false;
        for (RoundToolCall call : calls) {
            ToolContext context = new RoundToolContext(
                    run.conversationId(),
                    run.turnId(),
                    run.runId(),
                    roundId,
                    workspaceRoot,
                    cancelled || stopRequests.requested(run.turnId())
            );
            RuntimeResult execution = toolRuntime.invoke(
                    new Invocation(call.toolCallId(), call.toolName()),
                    call.arguments(),
                    context
            );
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
            boolean cancelled
    ) implements ToolContext {
    }
}
