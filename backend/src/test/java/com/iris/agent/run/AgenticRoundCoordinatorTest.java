package com.iris.agent.run;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.agent.model.AnswerStreamProjector;
import com.iris.agent.model.ModelAttemptRepository;
import com.iris.agent.model.ModelAttemptResult;
import com.iris.agent.model.AutoCompactionService;
import com.iris.agent.model.ModelAttemptService;
import com.iris.agent.model.ModelContext;
import com.iris.agent.model.ModelContextAssembler;
import com.iris.agent.model.ModelContextWindowPlanner;
import com.iris.agent.model.ModelPromptPrefix;
import com.iris.agent.model.ModelRequestSnapshotService;
import com.iris.agent.model.ModelStreamEvent;
import com.iris.agent.model.PromptTooLargeException;
import com.iris.agent.model.ToolObservationService;
import com.iris.agent.model.provider.ModelProvider;
import com.iris.agent.model.provider.ModelProviderException;
import com.iris.agent.model.provider.ModelProviderRegistry;
import com.iris.conversation.application.RunEventEmitter;
import com.iris.conversation.infrastructure.TurnStopRepository;
import com.iris.tools.core.ToolRuntime;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class AgenticRoundCoordinatorTest {
    private static final Path WORKSPACE = Path.of("target", "test-workspace")
            .toAbsolutePath();
    private static final String PROFILE = "test-profile";
    private static final String MODEL_ID = "test-model";
    private static final String CONVERSATION_ID = "conv_" + UUID.randomUUID();
    private static final String TURN_ID = "turn_" + UUID.randomUUID();
    private static final String RUN_ID = "run_" + UUID.randomUUID();
    private static final String ROUND_ID = "round_" + UUID.randomUUID();

    @Mock
    private RunRoundRepository runFacts;
    @Mock
    private ModelContextAssembler contexts;
    @Mock
    private ModelProviderRegistry providers;
    @Mock
    private ModelAttemptService attempts;
    @Mock
    private RoundToolCoordinator tools;
    @Mock
    private ObjectMapper objectMapper;
    @Mock
    private AnswerStreamProjector answerStreams;
    @Mock
    private RunEventEmitter lifecycleEvents;
    @Mock
    private SupplementInjectionService supplementInjections;
    @Mock
    private RunMailboxInjectionService mailboxInjections;
    @Mock
    private TurnStopRepository stopRequests;
    @Mock
    private RunCancellationRegistry cancellations;
    @Mock
    private RunFinalizationPolicy finalizationPolicy;
    @Mock
    private AutoCompactionService autoCompactions;
    @Mock
    private ToolObservationService toolObservations;
    @Mock
    private ModelRequestSnapshotService requestSnapshots;
    @Mock
    private ToolRuntime toolRuntime;
    @Mock
    private AgentRunContextRepository runContexts;

    private AgenticRoundCoordinator coordinator() {
        return new AgenticRoundCoordinator(
                runFacts,
                contexts,
                providers,
                attempts,
                tools,
                objectMapper,
                answerStreams,
                lifecycleEvents,
                supplementInjections,
                mailboxInjections,
                stopRequests,
                cancellations,
                finalizationPolicy,
                autoCompactions,
                toolObservations,
                requestSnapshots,
                toolRuntime,
                runContexts,
                0.85,
                0.95,
                true,
                2
        );
    }

    private ModelProvider provider() {
        ModelProvider provider = mock(ModelProvider.class);
        when(provider.profileId()).thenReturn(PROFILE);
        // providerKind/timeout 只在 assemble 成功后的请求元数据与 consume
        // 段使用；assemble 恒失败的用例触达不到，放宽避免严格 stub 误报
        lenient().when(provider.providerKind()).thenReturn("test");
        when(provider.modelId()).thenReturn(MODEL_ID);
        lenient().when(provider.timeout()).thenReturn(Duration.ofSeconds(30));
        when(providers.require(PROFILE)).thenReturn(provider);
        return provider;
    }

    private RunRoundRepository.RunRow rootRun() {
        return new RunRoundRepository.RunRow(
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

    private RunRoundRepository.RunRow childRun() {
        return new RunRoundRepository.RunRow(
                RUN_ID,
                CONVERSATION_ID,
                "branch_1",
                TURN_ID,
                "parent_" + UUID.randomUUID(),
                RUN_ID,
                "agentic",
                "test",
                RunPhase.RUNNING,
                1
        );
    }

    private RunRoundRepository.RoundRow acceptedRound() {
        return new RunRoundRepository.RoundRow(
                ROUND_ID,
                RUN_ID,
                0,
                RoundPhase.ACCEPTED,
                0,
                1
        );
    }

    private RunRoundRepository.RoundRow modelStreamingRound() {
        return new RunRoundRepository.RoundRow(
                ROUND_ID,
                RUN_ID,
                0,
                RoundPhase.MODEL_STREAMING,
                0,
                2
        );
    }

    private RunRoundRepository.RoundRow completedRound() {
        return new RunRoundRepository.RoundRow(
                ROUND_ID,
                RUN_ID,
                0,
                RoundPhase.COMPLETED,
                0,
                3
        );
    }

    private ModelAttemptRepository.AttemptRow attempt(int index) {
        return new ModelAttemptRepository.AttemptRow(
                "attempt_" + index,
                CONVERSATION_ID,
                TURN_ID,
                RUN_ID,
                ROUND_ID,
                index,
                PROFILE,
                MODEL_ID,
                hash(),
                hash(),
                "streaming",
                1
        );
    }

    private ModelContext context(ModelContextWindowPlanner.ContextBudget budget) {
        ModelPromptPrefix prefix = new ModelPromptPrefix(
                "iris.agent.adhoc",
                1,
                hash(),
                hash(),
                hash()
        );
        return new ModelContext(
                "test instruction",
                List.of(),
                List.of(),
                prefix,
                hash(),
                hash(),
                100,
                budget.maxInputTokens(),
                budget.reservedOutputTokens(),
                0
        );
    }

    private ModelContext context(
            int estimatedInputTokens,
            int maxInputTokens,
            int reservedOutputTokens
    ) {
        ModelPromptPrefix prefix = new ModelPromptPrefix(
                "iris.agent.adhoc",
                1,
                hash(),
                hash(),
                hash()
        );
        return new ModelContext(
                "test instruction",
                List.of(),
                List.of(),
                prefix,
                hash(),
                hash(),
                estimatedInputTokens,
                maxInputTokens,
                reservedOutputTokens,
                0
        );
    }

    private ModelContextAssembler.ContextSeed seed() {
        return new ModelContextAssembler.ContextSeed(
                "test instruction",
                List.of()
        );
    }

    private Flux<ModelStreamEvent> successStream() {
        return Flux.just(
                new ModelStreamEvent.MessageStarted("msg_1", MODEL_ID),
                new ModelStreamEvent.MessageCompleted("end_turn", 10, 5)
        );
    }

    private Flux<ModelStreamEvent> textStream() {
        return Flux.just(
                new ModelStreamEvent.MessageStarted("msg_1", MODEL_ID),
                new ModelStreamEvent.BlockStarted(
                        0,
                        ModelStreamEvent.BlockKind.TEXT,
                        null,
                        null
                ),
                new ModelStreamEvent.BlockDelta(
                        0,
                        "hello",
                        ModelStreamEvent.FragmentMode.APPEND
                ),
                new ModelStreamEvent.BlockCompleted(0),
                new ModelStreamEvent.MessageCompleted("end_turn", 10, 5)
        );
    }

    private RunRoundRepository.RoundRow failedRound() {
        return new RunRoundRepository.RoundRow(
                ROUND_ID,
                RUN_ID,
                0,
                RoundPhase.FAILED,
                0,
                2
        );
    }

    @Test
    void recoversFromAssemblePromptTooLargeWithTighterBudget() {
        AgenticRoundCoordinator coordinator = coordinator();
        ModelProvider provider = provider();
        when(runFacts.findRound(ROUND_ID))
                .thenReturn(java.util.Optional.of(acceptedRound()));
        when(runFacts.findRun(RUN_ID))
                .thenReturn(java.util.Optional.of(rootRun()));
        when(contexts.assemble(any(), any(), any()))
                .thenThrow(new PromptTooLargeException("too large"))
                .thenReturn(context(ModelContextWindowPlanner.ContextBudget.defaults()));
        when(attempts.begin(anyString(), anyLong(), anyString(), anyString(),
                anyString(), anyString()))
                .thenReturn(attempt(0));
        when(attempts.commit(anyString(), anyLong(), any(ModelAttemptResult.class)))
                .thenReturn(completedRound());
        when(cancellations.whenCancelled(RUN_ID))
                .thenReturn(Mono.never());
        when(provider.stream(any()))
                .thenReturn(successStream());

        AgenticRoundCoordinator.RoundAdvance advance = coordinator.advance(
                ROUND_ID,
                PROFILE,
                seed(),
                WORKSPACE,
                false
        ).block(Duration.ofSeconds(5));

        assertThat(advance).isNotNull();
        assertThat(advance.phase()).isEqualTo(RoundPhase.COMPLETED);

        verify(contexts, times(2)).assemble(any(), any(), any());
        verify(attempts).begin(anyString(), anyLong(), anyString(),
                anyString(), anyString(), anyString());
        verify(attempts, never()).failAndResetForOverflow(anyString(), anyString(),
                any());
    }

    @Test
    void failsRoundAfterMaxAssemblePromptTooLargeRecoveries() {
        AgenticRoundCoordinator coordinator = coordinator();
        ModelProvider provider = provider();
        when(runFacts.findRound(ROUND_ID))
                .thenReturn(java.util.Optional.of(acceptedRound()));
        when(runFacts.findRun(RUN_ID))
                .thenReturn(java.util.Optional.of(rootRun()));
        when(contexts.assemble(any(), any(), any()))
                .thenThrow(new PromptTooLargeException("too large"));
        when(attempts.failAcceptedRoundForOverflow(
                anyString(), anyString(), anyString(), anyString(), any()
        )).thenReturn(failedRound());

        assertThatThrownBy(() -> coordinator.advance(
                ROUND_ID,
                PROFILE,
                seed(),
                WORKSPACE,
                false
        ).block(Duration.ofSeconds(5)))
                .isInstanceOf(PromptTooLargeException.class);

        verify(contexts, times(3)).assemble(any(), any(), any());
        verify(attempts).failAcceptedRoundForOverflow(
                eq(ROUND_ID),
                eq(PROFILE),
                eq(MODEL_ID),
                eq("protocol:prompt_too_large"),
                any()
        );
        verify(attempts, never()).begin(anyString(), anyLong(), anyString(),
                anyString(), anyString(), anyString());
    }

    @Test
    void recoversFromPromptTooLargeWithTighterBudget() {
        AgenticRoundCoordinator coordinator = coordinator();
        ModelProvider provider = provider();
        when(runFacts.findRound(ROUND_ID))
                .thenReturn(java.util.Optional.of(acceptedRound()));
        when(runFacts.findRun(RUN_ID))
                .thenReturn(java.util.Optional.of(rootRun()));
        when(contexts.assemble(any(), any(), any()))
                .thenReturn(context(ModelContextWindowPlanner.ContextBudget.defaults()));
        when(attempts.begin(anyString(), anyLong(), anyString(), anyString(),
                anyString(), anyString()))
                .thenReturn(attempt(0))
                .thenReturn(attempt(1));
        when(attempts.failAndResetForOverflow(anyString(), anyString(), any()))
                .thenReturn(acceptedRound());
        when(attempts.commit(anyString(), anyLong(), any(ModelAttemptResult.class)))
                .thenReturn(completedRound());
        when(cancellations.whenCancelled(RUN_ID))
                .thenReturn(Mono.never());
        when(provider.stream(any()))
                .thenReturn(Flux.error(new PromptTooLargeException("too large")))
                .thenReturn(successStream());

        AgenticRoundCoordinator.RoundAdvance advance = coordinator.advance(
                ROUND_ID,
                PROFILE,
                seed(),
                WORKSPACE,
                false
        ).block(Duration.ofSeconds(5));

        assertThat(advance).isNotNull();
        assertThat(advance.phase()).isEqualTo(RoundPhase.COMPLETED);

        verify(attempts).failAndResetForOverflow(
                eq("attempt_0"),
                eq("protocol:prompt_too_large"),
                any()
        );
        verify(attempts, times(2)).begin(anyString(), anyLong(), anyString(),
                anyString(), anyString(), anyString());
    }

    @Test
    void failsRoundAfterMaxPromptTooLargeRecoveries() {
        AgenticRoundCoordinator coordinator = coordinator();
        ModelProvider provider = provider();
        when(runFacts.findRound(ROUND_ID))
                .thenReturn(java.util.Optional.of(acceptedRound()));
        when(runFacts.findRun(RUN_ID))
                .thenReturn(java.util.Optional.of(rootRun()));
        when(contexts.assemble(any(), any(), any()))
                .thenReturn(context(ModelContextWindowPlanner.ContextBudget.defaults()));
        when(attempts.begin(anyString(), anyLong(), anyString(), anyString(),
                anyString(), anyString()))
                .thenReturn(attempt(0))
                .thenReturn(attempt(1))
                .thenReturn(attempt(2));
        when(attempts.failAndResetForOverflow(anyString(), anyString(), any()))
                .thenReturn(acceptedRound());
        doAnswer(invocation -> null).when(attempts)
                .fail(anyString(), anyString(), any());
        when(cancellations.whenCancelled(RUN_ID))
                .thenReturn(Mono.never());
        when(provider.stream(any()))
                .thenReturn(Flux.error(new PromptTooLargeException("too large")));

        assertThatThrownBy(() -> coordinator.advance(
                ROUND_ID,
                PROFILE,
                seed(),
                WORKSPACE,
                false
        ).block(Duration.ofSeconds(5)))
                .isInstanceOf(PromptTooLargeException.class);

        verify(attempts, times(2)).failAndResetForOverflow(anyString(), anyString(),
                any());
        verify(attempts).fail(anyString(), eq("protocol:prompt_too_large"), any());
    }

    @Test
    void retriesChildRunWithRetryAfter() {
        AgenticRoundCoordinator coordinator = coordinator();
        ModelProvider provider = provider();
        when(runFacts.findRound(ROUND_ID))
                .thenReturn(java.util.Optional.of(acceptedRound()));
        when(runFacts.findRun(RUN_ID))
                .thenReturn(java.util.Optional.of(childRun()));
        when(contexts.assemble(any(), any(), any()))
                .thenReturn(context(ModelContextWindowPlanner.ContextBudget.defaults()));
        when(attempts.begin(anyString(), anyLong(), anyString(), anyString(),
                anyString(), anyString()))
                .thenReturn(attempt(0))
                .thenReturn(attempt(1));
        when(attempts.retry(anyString(), anyLong(), anyString(), any()))
                .thenReturn(attempt(1));
        when(attempts.commit(anyString(), anyLong(), any(ModelAttemptResult.class)))
                .thenReturn(completedRound());
        when(cancellations.whenCancelled(RUN_ID))
                .thenReturn(Mono.never());
        when(provider.stream(any()))
                .thenReturn(Flux.error(rateLimited(Duration.ofSeconds(1))))
                .thenReturn(successStream());

        AgenticRoundCoordinator.RoundAdvance advance = coordinator.advance(
                ROUND_ID,
                PROFILE,
                seed(),
                WORKSPACE,
                false
        ).block(Duration.ofSeconds(5));

        assertThat(advance).isNotNull();
        assertThat(advance.phase()).isEqualTo(RoundPhase.COMPLETED);

        verify(attempts).retry(anyString(), anyLong(), anyString(), any());
    }

    @Test
    void retryAfterDecisionHonorsRunKind() {
        AgenticRoundCoordinator coordinator = coordinator();
        ModelProviderException childRateLimit = rateLimited(Duration.ofSeconds(60));

        assertThat(coordinator.retryableWithinInteractiveBudget(
                childRateLimit,
                false
        )).isTrue();
        assertThat(coordinator.retryableWithinInteractiveBudget(
                childRateLimit,
                true
        )).isFalse();

        ModelProviderException rootRateLimit = rateLimited(Duration.ofSeconds(10));
        assertThat(coordinator.retryableWithinInteractiveBudget(
                rootRateLimit,
                true
        )).isTrue();
    }

    @Test
    void rejectsRetryAfter60sForRootRun() {
        AgenticRoundCoordinator coordinator = coordinator();
        ModelProvider provider = provider();
        when(runFacts.findRound(ROUND_ID))
                .thenReturn(java.util.Optional.of(acceptedRound()));
        when(runFacts.findRun(RUN_ID))
                .thenReturn(java.util.Optional.of(rootRun()));
        when(contexts.assemble(any(), any(), any()))
                .thenReturn(context(ModelContextWindowPlanner.ContextBudget.defaults()));
        when(attempts.begin(anyString(), anyLong(), anyString(), anyString(),
                anyString(), anyString()))
                .thenReturn(attempt(0));
        doAnswer(invocation -> null).when(attempts)
                .fail(anyString(), anyString(), any());
        when(cancellations.whenCancelled(RUN_ID))
                .thenReturn(Mono.never());
        when(provider.stream(any()))
                .thenReturn(Flux.error(rateLimited(Duration.ofSeconds(60))));

        assertThatThrownBy(() -> coordinator.advance(
                ROUND_ID,
                PROFILE,
                seed(),
                WORKSPACE,
                false
        ).block(Duration.ofSeconds(5)))
                .isInstanceOf(ModelProviderException.class);

        verify(attempts, never()).retry(anyString(), anyLong(), anyString(), any());
        verify(attempts).fail(anyString(), eq("provider_rate_limited"), any());
    }

    private ModelProviderException rateLimited(Duration retryAfter) {
        return new ModelProviderException(
                "provider_rate_limited",
                true,
                "rate limited",
                429,
                "rate_limit",
                "test",
                "too many requests",
                retryAfter
        );
    }

    @Test
    void emitsWarningContextUsageEventWhenPressureAboveWarning() {
        AgenticRoundCoordinator coordinator = coordinator();
        ModelProvider provider = provider();
        when(runFacts.findRound(ROUND_ID))
                .thenReturn(java.util.Optional.of(acceptedRound()));
        when(runFacts.findRun(RUN_ID))
                .thenReturn(java.util.Optional.of(rootRun()));
        // ratio = 88 / (100 - 4) = 0.917 -> warning, below blocking
        when(contexts.assemble(any(), any(), any()))
                .thenReturn(context(88, 100, 4));
        when(attempts.begin(anyString(), anyLong(), anyString(), anyString(),
                anyString(), anyString()))
                .thenReturn(attempt(0));
        when(attempts.commit(anyString(), anyLong(), any(ModelAttemptResult.class)))
                .thenReturn(completedRound());
        when(cancellations.whenCancelled(RUN_ID))
                .thenReturn(Mono.never());
        when(provider.stream(any()))
                .thenReturn(successStream());

        coordinator.advance(
                ROUND_ID,
                PROFILE,
                seed(),
                WORKSPACE,
                false
        ).block(Duration.ofSeconds(5));

        verify(lifecycleEvents).contextUsageUpdated(
                any(),
                any(),
                eq("warning")
        );
        verify(autoCompactions, never()).requestCompaction(anyString());
        verify(contexts).assemble(any(), any(), any());
    }

    @Test
    void requestsCompactionAndReassemblesWhenPressureAboveBlocking() {
        AgenticRoundCoordinator coordinator = coordinator();
        ModelProvider provider = provider();
        when(runFacts.findRound(ROUND_ID))
                .thenReturn(java.util.Optional.of(acceptedRound()));
        when(runFacts.findRun(RUN_ID))
                .thenReturn(java.util.Optional.of(rootRun()));
        // first ratio = 96 / (100 - 4) = 1.0 -> blocking
        when(contexts.assemble(any(), any(), any()))
                .thenReturn(context(96, 100, 4))
                .thenReturn(context(70, 100, 4));
        when(attempts.begin(anyString(), anyLong(), anyString(), anyString(),
                anyString(), anyString()))
                .thenReturn(attempt(0));
        when(attempts.commit(anyString(), anyLong(), any(ModelAttemptResult.class)))
                .thenReturn(completedRound());
        when(cancellations.whenCancelled(RUN_ID))
                .thenReturn(Mono.never());
        when(provider.stream(any()))
                .thenReturn(successStream());

        coordinator.advance(
                ROUND_ID,
                PROFILE,
                seed(),
                WORKSPACE,
                false
        ).block(Duration.ofSeconds(5));

        verify(autoCompactions).requestCompaction(eq(RUN_ID));
        verify(contexts, times(2)).assemble(any(), any(), any());
        verify(lifecycleEvents).contextUsageUpdated(
                any(),
                any(),
                eq("blocking")
        );
    }

    @Test
    void recordsPlaceholderObservationsWhenDrainingCancelledTools() {
        AgenticRoundCoordinator coordinator = coordinator();
        RunRoundRepository.RoundRow awaiting = new RunRoundRepository.RoundRow(
                ROUND_ID,
                RUN_ID,
                0,
                RoundPhase.AWAITING_TOOLS,
                1,
                1
        );
        when(runFacts.findRound(ROUND_ID))
                .thenReturn(java.util.Optional.of(awaiting));
        when(runFacts.findRun(RUN_ID))
                .thenReturn(java.util.Optional.of(rootRun()));
        when(stopRequests.requested(TURN_ID))
                .thenReturn(true);
        RoundToolCoordinator.RoundToolProgress progress =
                new RoundToolCoordinator.RoundToolProgress(
                        ROUND_ID,
                        RoundPhase.COMPLETED,
                        List.of(),
                        1,
                        false
                );
        when(tools.advance(ROUND_ID, WORKSPACE, true))
                .thenReturn(progress);

        AgenticRoundCoordinator.RoundAdvance advance = coordinator.advance(
                ROUND_ID,
                PROFILE,
                null,
                WORKSPACE,
                false
        ).block(Duration.ofSeconds(5));

        assertThat(advance).isNotNull();
        assertThat(advance.phase()).isEqualTo(RoundPhase.COMPLETED);
        verify(toolObservations).recordCancelledPendingCalls(
                eq(CONVERSATION_ID),
                eq(TURN_ID),
                eq(RUN_ID),
                eq(ROUND_ID),
                any()
        );
    }

    @Test
    void invalidatesStreamingNodeWhenCommitSucceedsButCompletionFails() {
        AgenticRoundCoordinator coordinator = coordinator();
        ModelProvider provider = provider();
        when(runFacts.findRound(ROUND_ID))
                .thenReturn(java.util.Optional.of(acceptedRound()));
        when(runFacts.findRun(RUN_ID))
                .thenReturn(java.util.Optional.of(rootRun()));
        when(contexts.assemble(any(), any(), any()))
                .thenReturn(context(ModelContextWindowPlanner.ContextBudget.defaults()));
        when(attempts.begin(anyString(), anyLong(), anyString(), anyString(),
                anyString(), anyString()))
                .thenReturn(attempt(0));
        when(attempts.commit(anyString(), anyLong(), any(ModelAttemptResult.class)))
                .thenReturn(completedRound());
        when(cancellations.whenCancelled(RUN_ID))
                .thenReturn(Mono.never());
        when(provider.stream(any()))
                .thenReturn(textStream());
        when(finalizationPolicy.evaluate(RUN_ID))
                .thenReturn(new RunFinalizationPolicy.Decision(
                        false, null, 0, null));
        doThrow(new IllegalStateException("completion boom"))
                .when(answerStreams)
                .complete(any(), any(), anyString(), anyString(), anyString());

        assertThatThrownBy(() -> coordinator.advance(
                ROUND_ID,
                PROFILE,
                seed(),
                WORKSPACE,
                false
        ).block(Duration.ofSeconds(5)))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("completion boom");

        verify(answerStreams).invalidateIfStreaming(
                CONVERSATION_ID,
                "attempt_0"
        );
        verify(answerStreams, never()).discard(anyString());
    }

    private String hash() {
        return "0".repeat(64);
    }
}
