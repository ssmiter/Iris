package com.iris.agent.run;

import com.iris.agent.model.AgentContextPolicy;
import com.iris.agent.model.AnswerProjectionService;
import com.iris.agent.model.ToolObservationService;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.conversation.application.ConversationLocks;
import com.iris.conversation.application.RunEventEmitter;
import com.iris.conversation.domain.ConversationViews.FailureView;
import com.iris.conversation.infrastructure.SupplementRepository;
import com.iris.conversation.infrastructure.TurnStopRepository;
import com.iris.tools.core.ToolRuntime;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** 失败码表：model_not_configured 必须是可由用户修复的配置类失败。 */
@ExtendWith(MockitoExtension.class)
class AgenticRunCoordinatorFailureTableTest {

    private static final String CONVERSATION_ID = "conv_" + UUID.randomUUID();
    private static final String TURN_ID = "turn_" + UUID.randomUUID();
    private static final String RUN_ID = "run_" + UUID.randomUUID();

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
    void modelNotConfiguredIsActionableConfigurationFailure() {
        AgenticRunCoordinator coordinator = coordinator();
        RunRow run = new RunRow(
                RUN_ID,
                CONVERSATION_ID,
                "branch_1",
                TURN_ID,
                null,
                RUN_ID,
                "agentic",
                "test",
                RunPhase.RUNNING,
                1
        );
        RunRow failed = new RunRow(
                RUN_ID,
                CONVERSATION_ID,
                "branch_1",
                TURN_ID,
                null,
                RUN_ID,
                "agentic",
                "test",
                RunPhase.FAILED,
                2
        );
        when(facts.findRun(RUN_ID)).thenReturn(Optional.of(run));
        when(states.failRun(eq(RUN_ID), eq(1L), any())).thenReturn(failed);

        AgenticRunCoordinator.RunAdvance advance = coordinator
                .failForMissingProvider(RUN_ID)
                .block();

        assertThat(advance).isNotNull();
        assertThat(advance.phase()).isEqualTo(RunPhase.FAILED);
        assertThat(advance.failure()).isEqualTo("model_not_configured");
        ArgumentCaptor<FailureView> captor = ArgumentCaptor.forClass(
                FailureView.class
        );
        verify(states).failRun(eq(RUN_ID), eq(1L), captor.capture());
        FailureView failure = captor.getValue();
        assertThat(failure.code()).isEqualTo("model_not_configured");
        assertThat(failure.category()).isEqualTo("configuration");
        assertThat(failure.source()).isEqualTo("model_provider");
        assertThat(failure.recoveryAction()).isEqualTo("user_input");
        assertThat(failure.userMessage()).contains("尚未配置模型服务");
        assertThat(failure.traceId()).startsWith("trace_");
        verify(facts).settleTurn(eq(TURN_ID), eq("failed"), any(Instant.class));
        verify(lifecycleEvents).turnUpdated(TURN_ID);
    }
}
