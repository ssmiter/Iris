package com.iris.agent.run;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.ModelAttemptRepository;
import com.iris.agent.model.ModelAttemptRepository.ObservationSource;
import com.iris.agent.model.ModelAttemptRepository.RoundToolCall;
import com.iris.agent.model.ModelTokenEstimator;
import com.iris.agent.model.ToolObservationService;
import com.iris.agent.run.RunRoundRepository.RoundRow;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.conversation.application.RunEventEmitter;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolExecutionViews.Invocation;
import com.iris.tools.core.ToolExecutionViews.RuntimeResult;
import com.iris.tools.core.ToolManifest.ConcurrencySemantics;
import com.iris.tools.core.ToolRuntime;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class RoundToolCoordinatorTest {
    private static final Path WORKSPACE = Path.of("target", "test-workspace")
            .toAbsolutePath();
    private static final String CONVERSATION_ID = "conv_" + UUID.randomUUID();
    private static final String TURN_ID = "turn_" + UUID.randomUUID();
    private static final String RUN_ID = "run_" + UUID.randomUUID();
    private static final String ROUND_ID = "round_" + UUID.randomUUID();

    @Mock
    private ModelAttemptRepository modelFacts;
    @Mock
    private ToolRuntime toolRuntime;
    @Mock
    private ToolObservationService observations;
    @Mock
    private RunRoundRepository runFacts;
    @Mock
    private RunRoundService runRounds;
    @Mock
    private ToolProjectionService projections;
    @Mock
    private RunEventEmitter lifecycleEvents;
    @Mock
    private RunCancellationRegistry cancellations;
    @Mock
    private AgentRunContextRepository runContexts;
    @Mock
    private ModelTokenEstimator tokenEstimator;

    private RoundToolCoordinator coordinator(int budgetTokens) {
        return new RoundToolCoordinator(
                modelFacts,
                toolRuntime,
                observations,
                runFacts,
                runRounds,
                projections,
                lifecycleEvents,
                cancellations,
                runContexts,
                tokenEstimator,
                4,
                budgetTokens
        );
    }

    private RunRow run() {
        return new RunRow(
                RUN_ID,
                CONVERSATION_ID,
                "branch_1",
                TURN_ID,
                null,
                null,
                "agentic",
                "test",
                RunPhase.RUNNING,
                1
        );
    }

    private RoundRow awaitingToolsRound() {
        return new RoundRow(
                ROUND_ID,
                RUN_ID,
                0,
                RoundPhase.AWAITING_TOOLS,
                3,
                1
        );
    }

    private RoundRow completedRound() {
        return new RoundRow(
                ROUND_ID,
                RUN_ID,
                0,
                RoundPhase.COMPLETED,
                3,
                2
        );
    }

    private RoundToolCall call(int ordinal, String name) {
        ObjectMapper mapper = new ObjectMapper();
        return new RoundToolCall(
                "tool-call-" + ordinal,
                "provider-call-" + ordinal,
                name,
                mapper.createObjectNode(),
                ordinal,
                null
        );
    }

    private RuntimeResult execution(int ordinal, String outputJson) {
        return new RuntimeResult(
                "execution-" + ordinal,
                "tool-call-" + ordinal,
                "tool-" + ordinal,
                "succeeded",
                "snapshot-" + ordinal,
                null,
                "hash-" + ordinal,
                "impact",
                "succeeded",
                null,
                null,
                1,
                Instant.now(),
                Instant.now()
        );
    }

    private ObservationSource source(int ordinal, String outputJson) {
        return new ObservationSource(
                "tool-call-" + ordinal,
                "provider-call-" + ordinal,
                "tool-" + ordinal,
                null,
                "execution-" + ordinal,
                "tool-call-" + ordinal,
                "tool-" + ordinal,
                "succeeded",
                "succeeded",
                outputJson,
                null,
                null
        );
    }

    @Test
    void projectsOldestLargestResultsWhenAggregateBudgetExceeded() {
        RoundToolCoordinator coordinator = coordinator(1_500);
        when(runFacts.findRound(ROUND_ID))
                .thenReturn(java.util.Optional.of(awaitingToolsRound()));
        when(runFacts.findRun(RUN_ID))
                .thenReturn(java.util.Optional.of(run()));
        List<RoundToolCall> calls = List.of(
                call(0, "read_a"),
                call(1, "read_b"),
                call(2, "read_c")
        );
        when(modelFacts.roundToolCalls(ROUND_ID)).thenReturn(calls);
        for (RoundToolCall call : calls) {
            when(toolRuntime.schedulingConcurrency(
                    eq(new Invocation(call.toolCallId(), call.toolName())),
                    eq(call.arguments()),
                    any(ToolContext.class)
            )).thenReturn(ConcurrencySemantics.SERIAL);
        }
        String largeOutput = "x".repeat(1_000);
        String mediumOutput = "x".repeat(800);
        String smallOutput = "x".repeat(100);
        when(toolRuntime.invoke(any(Invocation.class), any(), any(ToolContext.class)))
                .thenReturn(execution(0, largeOutput))
                .thenReturn(execution(1, mediumOutput))
                .thenReturn(execution(2, smallOutput));
        when(observations.observationSource("tool-call-0", "execution-0"))
                .thenReturn(source(0, largeOutput));
        when(observations.observationSource("tool-call-1", "execution-1"))
                .thenReturn(source(1, mediumOutput));
        when(observations.observationSource("tool-call-2", "execution-2"))
                .thenReturn(source(2, smallOutput));
        when(tokenEstimator.estimateText(largeOutput)).thenReturn(1_000);
        when(tokenEstimator.estimateText(mediumOutput)).thenReturn(800);
        when(tokenEstimator.estimateText(smallOutput)).thenReturn(100);
        when(runRounds.transitionRound(ROUND_ID, 1, RoundPhase.OBSERVATIONS_READY))
                .thenReturn(completedRound());
        when(runRounds.transitionRound(ROUND_ID, 2, RoundPhase.COMPLETED))
                .thenReturn(completedRound());

        RoundToolCoordinator.RoundToolProgress progress = coordinator.advance(
                ROUND_ID,
                WORKSPACE,
                false
        );

        assertThat(progress.phase()).isEqualTo(RoundPhase.COMPLETED);
        assertThat(progress.observationCount()).isEqualTo(3);

        ArgumentCaptor<Boolean> referenceOnlyCaptor =
                ArgumentCaptor.forClass(Boolean.class);
        verify(observations, times(3)).capture(
                anyString(),
                anyString(),
                referenceOnlyCaptor.capture()
        );
        List<Boolean> referenceOnlyFlags = referenceOnlyCaptor.getAllValues();
        // Oldest/largest (ordinal 0, 1000 tokens) is projected to reference.
        // Then total drops from 1900 to 900, which is under the 1500 budget.
        assertThat(referenceOnlyFlags.get(0)).isTrue();
        assertThat(referenceOnlyFlags.get(1)).isFalse();
        assertThat(referenceOnlyFlags.get(2)).isFalse();
    }

    @Test
    void keepsFullOutputWhenAggregateBudgetNotExceeded() {
        RoundToolCoordinator coordinator = coordinator(10_000);
        when(runFacts.findRound(ROUND_ID))
                .thenReturn(java.util.Optional.of(awaitingToolsRound()));
        when(runFacts.findRun(RUN_ID))
                .thenReturn(java.util.Optional.of(run()));
        List<RoundToolCall> calls = List.of(call(0, "read_a"));
        when(modelFacts.roundToolCalls(ROUND_ID)).thenReturn(calls);
        when(toolRuntime.schedulingConcurrency(any(), any(), any(ToolContext.class)))
                .thenReturn(ConcurrencySemantics.SERIAL);
        when(toolRuntime.invoke(any(Invocation.class), any(), any(ToolContext.class)))
                .thenReturn(execution(0, "small output"));
        when(observations.observationSource("tool-call-0", "execution-0"))
                .thenReturn(source(0, "small output"));
        when(tokenEstimator.estimateText("small output")).thenReturn(2);
        when(runRounds.transitionRound(ROUND_ID, 1, RoundPhase.OBSERVATIONS_READY))
                .thenReturn(completedRound());
        when(runRounds.transitionRound(ROUND_ID, 2, RoundPhase.COMPLETED))
                .thenReturn(completedRound());

        RoundToolCoordinator.RoundToolProgress progress = coordinator.advance(
                ROUND_ID,
                WORKSPACE,
                false
        );

        assertThat(progress.observationCount()).isEqualTo(1);
        verify(observations).capture("tool-call-0", "execution-0", false);
    }
}
