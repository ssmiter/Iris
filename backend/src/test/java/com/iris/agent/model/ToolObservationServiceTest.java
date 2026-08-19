package com.iris.agent.model;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.ModelAttemptRepository.RoundToolCall;
import com.iris.tools.core.ToolExecutionViews;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolRegistry;
import com.iris.tools.core.ToolRuntimeRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ToolObservationServiceTest {

    private static final String CONVERSATION_ID = "conv_" + UUID.randomUUID();
    private static final String TURN_ID = "turn_" + UUID.randomUUID();
    private static final String RUN_ID = "run_" + UUID.randomUUID();
    private static final String ROUND_ID = "round_" + UUID.randomUUID();
    private static final String TOOL_CALL_ID = "tc_" + UUID.randomUUID();

    @Mock
    private ModelAttemptRepository repository;
    @Mock
    private TransactionTemplate transactions;
    @Mock
    private ToolResultContextProjector contextProjector;
    @Mock
    private ToolRuntimeRepository toolExecutions;
    @Mock
    private ToolRegistry toolRegistry;

    private final ObjectMapper objectMapper = new ObjectMapper();

    private ToolObservationService service() {
        return new ToolObservationService(
                repository,
                transactions,
                objectMapper,
                contextProjector,
                toolExecutions,
                toolRegistry
        );
    }

    @Test
    void insertsSyntheticExecutionAndObservationForPendingToolCall() {
        ToolObservationService service = service();
        ObjectNode arguments = objectMapper.createObjectNode();
        arguments.put("path", "test.txt");
        RoundToolCall pending = new RoundToolCall(
                TOOL_CALL_ID,
                null,
                "write_file",
                arguments,
                0,
                null
        );
        when(repository.roundToolCalls(ROUND_ID))
                .thenReturn(List.of(pending));
        ToolRegistry.ToolBinding binding = binding("write_file");
        when(toolRegistry.find("write_file")).thenReturn(Optional.of(binding));
        when(repository.observationSource(anyString(), anyString()))
                .thenReturn(Optional.of(new ModelAttemptRepository.ObservationSource(
                        TOOL_CALL_ID,
                        null,
                        "write_file",
                        null,
                        "exec_synthetic",
                        TOOL_CALL_ID,
                        null,
                        "failed",
                        "failed",
                        null,
                        "run_stopped",
                        "运行已停止，该调用未执行。"
                )));
        when(repository.executionEvidence(anyString()))
                .thenReturn(List.of());
        doAnswer(invocation -> {
            invocation.getArgument(0, java.util.function.Consumer.class).accept(null);
            return null;
        }).when(transactions).executeWithoutResult(any());

        int recorded = service.recordCancelledPendingCalls(
                CONVERSATION_ID,
                TURN_ID,
                RUN_ID,
                ROUND_ID,
                Instant.now()
        );

        assertThat(recorded).isEqualTo(1);
        verify(toolExecutions).insertSyntheticTerminalExecution(
                anyString(),
                eq(TOOL_CALL_ID),
                eq(CONVERSATION_ID),
                eq(TURN_ID),
                eq(RUN_ID),
                eq(ROUND_ID),
                eq(binding),
                anyString(),
                eq("failed"),
                eq("failed"),
                eq("run_stopped"),
                eq("运行已停止，该调用未执行。"),
                any(Instant.class)
        );
    }

    @Test
    void skipsCallsWithNonTerminalExecution() {
        ToolObservationService service = service();
        RoundToolCall running = new RoundToolCall(
                TOOL_CALL_ID,
                null,
                "browser_click",
                objectMapper.createObjectNode(),
                0,
                "exec_1"
        );
        when(repository.roundToolCalls(ROUND_ID))
                .thenReturn(List.of(running));
        when(toolExecutions.findByExecutionId("exec_1"))
                .thenReturn(Optional.of(result("executing")));

        int recorded = service.recordCancelledPendingCalls(
                CONVERSATION_ID,
                TURN_ID,
                RUN_ID,
                ROUND_ID,
                Instant.now()
        );

        assertThat(recorded).isEqualTo(0);
        verify(toolExecutions, never())
                .insertSyntheticTerminalExecution(any(), any(), any(), any(),
                        any(), any(), any(), any(), any(), any(), any(), any(), any());
    }

    private ToolRegistry.ToolBinding binding(String name) {
        ToolManifest manifest = mock(ToolManifest.class);
        lenient().when(manifest.id()).thenReturn("tool:" + name);
        lenient().when(manifest.version()).thenReturn("1");
        lenient().when(manifest.name()).thenReturn(name);
        return new ToolRegistry.ToolBinding(
                manifest,
                "tools/fs/" + name,
                "tools/fs/" + name,
                "hash_" + name,
                null
        );
    }

    private ToolExecutionViews.RuntimeResult result(String phase) {
        return new ToolExecutionViews.RuntimeResult(
                "exec_1",
                TOOL_CALL_ID,
                "browser_click",
                phase,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                1,
                Instant.now(),
                Instant.now()
        );
    }
}
