package com.iris.agent.run;

import com.iris.agent.model.AgentContextPolicy;
import com.iris.agent.model.AnswerProjectionService;
import com.iris.agent.model.ToolObservationService;
import com.iris.agent.run.RunRoundRepository.RoundRow;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.conversation.application.RunEventEmitter;
import com.iris.conversation.application.ConversationLocks;
import com.iris.conversation.infrastructure.SupplementRepository;
import com.iris.conversation.infrastructure.TurnStopRepository;
import com.iris.tools.core.ToolRuntime;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import reactor.core.publisher.Mono;

import java.nio.file.Path;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class AgenticRunCoordinatorTest {

    private static final String CONVERSATION_ID = "conv_" + UUID.randomUUID();
    private static final String TURN_ID = "turn_" + UUID.randomUUID();
    private static final String RUN_ID = "run_" + UUID.randomUUID();
    private static final String ROUND_ID = "round_" + UUID.randomUUID();
    private static final Path WORKSPACE = Path.of("target", "test-workspace")
            .toAbsolutePath();

    @Mock
    private RunRoundRepository facts;
    @Mock
    private RunRoundService states;
    @Mock
    private AgenticRoundCoordinator rounds;
    @Mock
    private AnswerProjectionService answers;
    @Mock
    private AgentContextPolicy contextPolicy;
    @Mock
    private RunEventEmitter lifecycleEvents;
    @Mock
    private TurnStopRepository stopRequests;
    @Mock
    private ToolRuntime toolRuntime;
    @Mock
    private RunCancellationRegistry cancellations;
    @Mock
    private ConversationLocks conversationLocks;
    @Mock
    private SupplementRepository supplements;
    @Mock
    private RunFinalizationPolicy finalizationPolicy;
    @Mock
    private ToolObservationService toolObservations;

    private AgenticRunCoordinator coordinator() {
        return new AgenticRunCoordinator(
                facts,
                states,
                rounds,
                answers,
                contextPolicy,
                lifecycleEvents,
                stopRequests,
                toolRuntime,
                cancellations,
                conversationLocks,
                supplements,
                finalizationPolicy,
                toolObservations
        );
    }

    @Test
    void stopRunCreatesPlaceholderObservationsForPendingToolCalls() {
        AgenticRunCoordinator coordinator = coordinator();
        RunRow run = new RunRow(
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
        RoundRow latest = new RoundRow(
                ROUND_ID,
                RUN_ID,
                0,
                RoundPhase.AWAITING_TOOLS,
                1,
                1
        );
        when(facts.findRun(RUN_ID)).thenReturn(Optional.of(run));
        when(stopRequests.requested(TURN_ID)).thenReturn(true);
        when(facts.latestRound(RUN_ID)).thenReturn(Optional.of(latest));
        when(toolRuntime.hasCommittedActivity(RUN_ID)).thenReturn(false);
        when(states.transitionRound(
                eq(ROUND_ID),
                eq(1L),
                eq(RoundPhase.STOPPED)
        )).thenReturn(latest);
        RunRow cancelledRun = new RunRow(
                RUN_ID,
                CONVERSATION_ID,
                "branch_1",
                TURN_ID,
                null,
                null,
                "agentic",
                "test",
                RunPhase.CANCELLED,
                2
        );
        when(states.cancelRun(
                eq(RUN_ID),
                eq(1L),
                eq("user_cancelled")
        )).thenReturn(cancelledRun);
        doNothing().when(facts)
                .settleTurn(anyString(), anyString(), any(Instant.class));
        doNothing().when(stopRequests)
                .complete(anyString(), any(Instant.class));

        AgenticRunCoordinator.RunAdvance advance = coordinator.advance(
                RUN_ID,
                "test-profile",
                WORKSPACE,
                false
        ).block();

        assertThat(advance).isNotNull();
        assertThat(advance.phase()).isEqualTo(RunPhase.CANCELLED);
        verify(toolRuntime).cancelBeforeExecution(RUN_ID);
        verify(toolObservations).recordCancelledPendingCalls(
                eq(CONVERSATION_ID),
                eq(TURN_ID),
                eq(RUN_ID),
                eq(ROUND_ID),
                any(Instant.class)
        );
    }
}
