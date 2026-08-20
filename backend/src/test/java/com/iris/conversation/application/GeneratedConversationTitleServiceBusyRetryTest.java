package com.iris.conversation.application;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.agent.run.RunPhase;
import com.iris.agent.run.RunRoundRepository;
import com.iris.conversation.domain.ConversationEvent;
import com.iris.conversation.infrastructure.ConversationEventHub;
import com.iris.conversation.infrastructure.ConversationRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.transaction.support.TransactionCallback;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.SQLException;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * publishWithBusyRetry 只对 SQLite 瞬时写竞争重试（上限 2 次），
 * 成功路径事件只发一条；超上限或非 busy 异常直接上抛。
 */
class GeneratedConversationTitleServiceBusyRetryTest {

    private static final String CONVERSATION_ID = "conv_title";
    private static final String RUN_ID = "run_title";

    private final ConversationRepository conversations = mock(
            ConversationRepository.class
    );
    private final RunRoundRepository runs = mock(RunRoundRepository.class);
    private final TransactionTemplate transactions = mock(
            TransactionTemplate.class
    );
    private final ConversationEventHub eventHub = mock(
            ConversationEventHub.class
    );

    private GeneratedConversationTitleService service;

    @BeforeEach
    void setUp() {
        when(conversations.findConversationMetadata(CONVERSATION_ID))
                .thenReturn(Optional.of(
                        new ConversationRepository.ConversationMetadata(
                                "新对话",
                                1L
                        )
                ));
        when(conversations.updateConversationTitle(
                eq(CONVERSATION_ID),
                eq(1L),
                anyString(),
                any(Instant.class)
        )).thenReturn(2L);
        when(conversations.nextEventSequence(CONVERSATION_ID)).thenReturn(7L);
        when(runs.findRun(RUN_ID)).thenReturn(Optional.of(
                new RunRoundRepository.RunRow(
                        RUN_ID,
                        CONVERSATION_ID,
                        "branch_1",
                        "turn_1",
                        null,
                        RUN_ID,
                        "agentic",
                        "test",
                        RunPhase.RUNNING,
                        1L
                )
        ));
        service = new GeneratedConversationTitleService(
                conversations,
                runs,
                new ConversationLocks(),
                transactions,
                eventHub,
                new ObjectMapper()
        );
    }

    @Test
    void retriesTransientBusyAndPublishesExactlyOneEvent() {
        when(transactions.execute(any()))
                .thenThrow(sqliteBusy())
                .thenAnswer(invocation -> invokeCallback(invocation));

        GeneratedConversationTitleService.PublishResult result =
                service.publish(CONVERSATION_ID, RUN_ID, "  本周计划整理  ");

        assertThat(result.published()).isTrue();
        assertThat(result.reason()).isEqualTo("generated_title_published");
        assertThat(result.title()).isEqualTo("本周计划整理");
        verify(transactions, times(2)).execute(any());
        verify(conversations, times(1)).insertEvent(
                any(ConversationEvent.class)
        );
        ArgumentCaptor<List<ConversationEvent>> captor = eventsCaptor();
        verify(eventHub, times(1)).publish(captor.capture());
        assertThat(captor.getValue()).hasSize(1);
        ConversationEvent event = captor.getValue().get(0);
        assertThat(event.eventType()).isEqualTo("conversation.updated");
        assertThat(event.conversationId()).isEqualTo(CONVERSATION_ID);
        assertThat(event.sequence()).isEqualTo(7L);
        assertThat(event.payload().path("conversation").path("title").asText())
                .isEqualTo("本周计划整理");
    }

    @Test
    void rethrowsAfterBusyRetryBudgetIsExhausted() {
        when(transactions.execute(any())).thenThrow(sqliteBusy());

        assertThatThrownBy(() ->
                service.publish(CONVERSATION_ID, RUN_ID, "新标题")
        )
                .isInstanceOf(RuntimeException.class)
                .hasCauseInstanceOf(SQLException.class);

        // 首次尝试 + MAX_BUSY_RETRIES(2) 次重试 = 3 次 execute。
        verify(transactions, times(3)).execute(any());
        verify(conversations, never()).insertEvent(any(ConversationEvent.class));
        verify(eventHub, never()).publish(any());
    }

    @Test
    void doesNotRetryNonBusyFailures() {
        when(transactions.execute(any()))
                .thenThrow(new IllegalStateException("boom"));

        assertThatThrownBy(() ->
                service.publish(CONVERSATION_ID, RUN_ID, "新标题")
        ).isInstanceOf(IllegalStateException.class);

        verify(transactions, times(1)).execute(any());
        verify(eventHub, never()).publish(any());
    }

    private static RuntimeException sqliteBusy() {
        return new RuntimeException(
                new SQLException("database is locked", "HY000", 5)
        );
    }

    @SuppressWarnings("unchecked")
    private static Object invokeCallback(
            org.mockito.invocation.InvocationOnMock invocation
    ) {
        return ((TransactionCallback<Object>) invocation.getArgument(0))
                .doInTransaction(null);
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static ArgumentCaptor<List<ConversationEvent>> eventsCaptor() {
        return ArgumentCaptor.forClass((Class) List.class);
    }
}
