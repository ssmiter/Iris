package com.iris.conversation;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.agent.model.ModelAttemptService;
import com.iris.agent.model.ModelContextAssembler;
import com.iris.agent.model.ModelContextAssembler.ContextSeed;
import com.iris.agent.model.ModelStreamAssembler;
import com.iris.agent.model.ModelStreamEvent.BlockCompleted;
import com.iris.agent.model.ModelStreamEvent.BlockDelta;
import com.iris.agent.model.ModelStreamEvent.BlockKind;
import com.iris.agent.model.ModelStreamEvent.BlockStarted;
import com.iris.agent.model.ModelStreamEvent.FragmentMode;
import com.iris.agent.model.ModelStreamEvent.MessageCompleted;
import com.iris.agent.model.ModelStreamEvent.MessageStarted;
import com.iris.agent.model.ToolObservationService;
import com.iris.agent.run.RoundPhase;
import com.iris.agent.run.RunPhase;
import com.iris.agent.run.RunRoundService;
import com.iris.agent.run.RunRoundRepository;
import com.iris.conversation.application.ConversationCommandService;
import com.iris.conversation.application.ConversationEventStreamService;
import com.iris.conversation.application.ConversationQueryService;
import com.iris.conversation.domain.ApiProblemException;
import com.iris.conversation.domain.ConversationCommands.CreateConversationRequest;
import com.iris.conversation.domain.ConversationCommands.CreateTurnRequest;
import com.iris.conversation.domain.ConversationCommands.Entrypoint;
import com.iris.conversation.domain.ConversationCommands.TurnAcceptance;
import com.iris.conversation.domain.ConversationCommands.TurnInput;
import com.iris.conversation.domain.ConversationEvent;
import com.iris.conversation.domain.ConversationViews.ConversationView;
import com.iris.conversation.domain.ConversationViews.RenameConversationRequest;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolExecutionViews.ApprovalDecision;
import com.iris.tools.core.ToolExecutionViews.Invocation;
import com.iris.tools.core.ToolRuntime;
import com.iris.tools.core.ToolRuntimeException;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.OptionalLong;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@SpringBootTest
class ConversationFlowIntegrationTest {
    private static final Path DATABASE = Path.of(
            "target",
            "test-data",
            "conversation-flow.db"
    ).toAbsolutePath();
    private static final Path WORKSPACE = Path.of(
            "target",
            "test-workspace"
    ).toAbsolutePath();

    @Autowired
    private ConversationCommandService commands;

    @Autowired
    private ConversationQueryService queries;

    @Autowired
    private ConversationEventStreamService eventStream;

    @Autowired
    private ToolRuntime toolRuntime;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private RunRoundService runRoundService;

    @Autowired
    private ModelAttemptService modelAttempts;

    @Autowired
    private ToolObservationService observations;

    @Autowired
    private ModelContextAssembler modelContexts;

    @Autowired
    private RunRoundRepository runFacts;

    @DynamicPropertySource
    static void testProperties(DynamicPropertyRegistry registry)
            throws IOException {
        Files.createDirectories(DATABASE.getParent());
        Files.deleteIfExists(DATABASE);
        Files.deleteIfExists(Path.of(DATABASE + "-wal"));
        Files.deleteIfExists(Path.of(DATABASE + "-shm"));
        Files.createDirectories(WORKSPACE);
        Files.deleteIfExists(WORKSPACE.resolve("notes/runtime-test.md"));
        registry.add(
                "spring.datasource.url",
                () -> "jdbc:sqlite:" + DATABASE.toString().replace('\\', '/')
        );
        registry.add("iris.workspace", WORKSPACE::toString);
    }

    @Test
    void preservesIdempotentCommandsAndBuildsACompleteConversationView()
            throws Exception {
        String createKey = uniqueKey("create");
        var created = commands.createConversation(
                createKey,
                new CreateConversationRequest("初始标题")
        );
        var replayedCreate = commands.createConversation(
                createKey,
                new CreateConversationRequest("初始标题")
        );

        assertThat(replayedCreate).isEqualTo(created);
        assertThatThrownBy(() -> commands.createConversation(
                createKey,
                new CreateConversationRequest("另一个标题")
        ))
                .isInstanceOf(ApiProblemException.class)
                .extracting("status.value")
                .isEqualTo(409);

        String turnKey = uniqueKey("turn");
        CreateTurnRequest request = new CreateTurnRequest(
                created.rootBranchId(),
                uniqueKey("client"),
                new TurnInput(
                        "帮我整理今天的计划",
                        List.of("artifact://notes/today")
                ),
                new Entrypoint("agentic")
        );
        TurnAcceptance accepted = commands.acceptTurn(
                created.conversationId(),
                turnKey,
                request
        );
        TurnAcceptance replayedTurn = commands.acceptTurn(
                created.conversationId(),
                turnKey,
                request
        );

        assertThat(replayedTurn).isEqualTo(accepted);

        ConversationView view = queries.view(
                created.conversationId(),
                null,
                null,
                50
        ).block(Duration.ofSeconds(5));

        assertThat(view).isNotNull();
        assertThat(view.turnOrder()).containsExactly(accepted.turnId());
        assertThat(view.turnsById().get(accepted.turnId()).request().text())
                .isEqualTo("帮我整理今天的计划");
        assertThat(view.turnsById().get(accepted.turnId())
                .request().attachmentRefs())
                .containsExactly("artifact://notes/today");
        assertThat(view.runsById()).containsKey(accepted.rootRunId());
        assertThat(view.eventCursor()).isNotBlank();
        assertThat(view.version()).isEqualTo(2);

        OptionalLong cursor = eventStream.resolveStart(
                created.conversationId(),
                accepted.eventCursor()
        ).block(Duration.ofSeconds(5));
        ConversationEvent nextEvent = eventStream.stream(
                created.conversationId(),
                cursor
        ).next().block(Duration.ofSeconds(5));

        assertThat(nextEvent).isNotNull();
        assertThat(nextEvent.eventType()).isEqualTo("run.started");
        assertThat(nextEvent.sequence()).isEqualTo(2);

        String renameKey = uniqueKey("rename");
        var renamed = commands.renameConversation(
                created.conversationId(),
                renameKey,
                new RenameConversationRequest(view.version(), "今天的计划")
        );
        var replayedRename = commands.renameConversation(
                created.conversationId(),
                renameKey,
                new RenameConversationRequest(view.version(), "今天的计划")
        );

        assertThat(replayedRename).isEqualTo(renamed);
        assertThat(renamed.version()).isEqualTo(3);
        assertThat(queries.view(
                created.conversationId(),
                null,
                null,
                50
        ).block(Duration.ofSeconds(5)).title()).isEqualTo("今天的计划");
        assertThat(queries.list(null, 30).block(Duration.ofSeconds(5)).items())
                .anySatisfy(summary -> {
                    assertThat(summary.conversationId())
                            .isEqualTo(created.conversationId());
                    assertThat(summary.title()).isEqualTo("今天的计划");
                    assertThat(summary.activeTurnCount()).isEqualTo(1);
                });

        ToolContext toolContext = new TestToolContext(
                created.conversationId(),
                accepted.turnId(),
                accepted.rootRunId(),
                null,
                WORKSPACE,
                false
        );
        var round = runRoundService.openRound(accepted.rootRunId());
        var run = runFacts.findRun(accepted.rootRunId()).orElseThrow();
        var context = modelContexts.assemble(
                run,
                round,
                new ContextSeed(
                        "Integration test agent",
                        List.of("current_time")
                )
        );
        var attempt = modelAttempts.begin(
                round.roundId(),
                round.version(),
                "integration-openai-compatible",
                "integration-model",
                context.contextHash(),
                context.capabilityLeaseHash()
        );
        ModelStreamAssembler assembler = new ModelStreamAssembler(
                attempt.attemptId(),
                objectMapper
        );
        assembler.accept(new MessageStarted(
                "provider-message-1",
                "integration-model"
        ));
        assembler.accept(new BlockStarted(
                0,
                BlockKind.TEXT,
                null,
                null
        ));
        assembler.accept(new BlockDelta(
                0,
                "我先读取可靠时间。",
                FragmentMode.APPEND
        ));
        assembler.accept(new BlockCompleted(0));
        assembler.accept(new BlockStarted(
                1,
                BlockKind.TOOL_CALL,
                "provider-call-time",
                "current_time"
        ));
        assembler.accept(new BlockDelta(
                1,
                "{\"zone\":",
                FragmentMode.APPEND
        ));
        assembler.accept(new BlockDelta(
                1,
                "{\"zone\":\"Asia/Hong_Kong\"}",
                FragmentMode.CUMULATIVE
        ));
        assembler.accept(new BlockCompleted(1));
        assembler.accept(new MessageCompleted("tool_calls", 120, 24));
        var modelResult = assembler.finish();
        var awaitingTools = modelAttempts.commit(
                attempt.attemptId(),
                attempt.version(),
                modelResult
        );

        assertThat(awaitingTools.phase()).isEqualTo(RoundPhase.AWAITING_TOOLS);
        assertThatThrownBy(() -> runRoundService.transitionRun(
                accepted.rootRunId(),
                1,
                RunPhase.SUCCEEDED
        )).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("非法 Run 状态跳转");

        var modelToolCall = modelResult.toolCalls().getFirst();
        ToolContext roundToolContext = new TestToolContext(
                created.conversationId(),
                accepted.turnId(),
                accepted.rootRunId(),
                round.roundId(),
                WORKSPACE,
                false
        );
        var currentTime = toolRuntime.invoke(
                new Invocation(
                        modelToolCall.toolCallId(),
                        modelToolCall.name()
                ),
                modelToolCall.arguments(),
                roundToolContext
        );
        assertThat(currentTime.phase()).isEqualTo("succeeded");
        assertThat(currentTime.approvalId()).isNull();
        var observation = observations.capture(
                modelToolCall.toolCallId(),
                currentTime.executionId()
        );
        assertThat(observation.content().path("toolCallId").asText())
                .isEqualTo("provider-call-time");
        assertThat(observation.content().path("isError").asBoolean()).isFalse();

        String toolCallId = uniqueKey("tool-call");
        var toolInput = objectMapper.createObjectNode()
                .put("path", "notes/runtime-test.md")
                .put("line", "只在批准后写入");
        var awaiting = toolRuntime.invoke(
                new Invocation(toolCallId, "append_note"),
                toolInput,
                toolContext
        );
        var replayedInvocation = toolRuntime.invoke(
                new Invocation(toolCallId, "append_note"),
                toolInput,
                toolContext
        );

        assertThat(awaiting.phase()).isEqualTo("awaiting_approval");
        assertThat(replayedInvocation.executionId())
                .isEqualTo(awaiting.executionId());
        assertThat(Files.exists(WORKSPACE.resolve("notes/runtime-test.md")))
                .isFalse();

        assertThatThrownBy(() -> toolRuntime.decideApproval(
                new ApprovalDecision(
                        awaiting.approvalId(),
                        uniqueKey("decision"),
                        "wrong-snapshot",
                        1,
                        true,
                        "integration-test"
                ),
                toolContext
        ))
                .isInstanceOf(ToolRuntimeException.class)
                .hasMessageContaining("审批版本、快照或状态");

        String decisionKey = uniqueKey("decision");
        ApprovalDecision approve = new ApprovalDecision(
                awaiting.approvalId(),
                decisionKey,
                awaiting.snapshotHash(),
                1,
                true,
                "integration-test"
        );
        var completed = toolRuntime.decideApproval(approve, toolContext);
        var replayedDecision = toolRuntime.decideApproval(
                approve,
                toolContext
        );

        assertThat(completed.phase()).isEqualTo("succeeded");
        assertThat(replayedDecision.executionId())
                .isEqualTo(completed.executionId());
        assertThat(Files.readString(
                WORKSPACE.resolve("notes/runtime-test.md")
        )).endsWith("只在批准后写入" + System.lineSeparator());

        assertThatThrownBy(() -> toolRuntime.invoke(
                new Invocation(toolCallId, "append_note"),
                objectMapper.createObjectNode()
                        .put("path", "notes/runtime-test.md")
                        .put("line", "不同输入"),
                toolContext
        ))
                .isInstanceOf(ToolRuntimeException.class)
                .hasMessageContaining("不同输入");
    }

    private static String uniqueKey(String prefix) {
        return prefix + "-" + UUID.randomUUID();
    }

    private record TestToolContext(
            String conversationId,
            String turnId,
            String runId,
            String roundId,
            Path workspaceRoot,
            boolean cancelled
    ) implements ToolContext {
    }
}
