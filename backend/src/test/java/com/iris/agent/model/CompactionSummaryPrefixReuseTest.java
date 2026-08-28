package com.iris.agent.model;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.CompactionRepository.CompactionRow;
import com.iris.agent.model.ModelContextWindowPlanner.ContextBudget;
import com.iris.agent.run.AgentRunContextRepository;
import com.iris.agent.run.RoundPhase;
import com.iris.agent.run.RunFinalizationPolicy;
import com.iris.agent.run.RunMailboxRepository;
import com.iris.agent.run.RunPhase;
import com.iris.agent.run.RunRoundRepository;
import com.iris.artifact.ArtifactService;
import com.iris.task.TaskLedgerService;
import com.iris.tools.core.CapabilityAvailability;
import com.iris.tools.core.CapabilityAvailabilityService;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * docs/42 §5.1: the compaction summary request must reproduce the last routed
 * request's prefix verbatim and carry the summary instruction in a trailing
 * user message. Assertions run against the retained assembly product, never
 * against a real provider.
 */
@ExtendWith(MockitoExtension.class)
class CompactionSummaryPrefixReuseTest {

    private static final String CONVERSATION_ID = "conv_prefix";
    private static final String BRANCH_ID = "branch_prefix";
    private static final String TURN_ID = "turn_prefix";
    private static final String RUN_ID = "run_prefix";
    private static final String ROUND_ID = "round_prefix";
    private static final String MESSAGE_ID = "msg_prefix";
    private static final String OBSERVATION_ID = "obs_prefix";

    @Mock
    private ModelContextRepository facts;
    @Mock
    private ToolRegistry tools;
    @Mock
    private CapabilityAvailabilityService availability;
    @Mock
    private ToolObservationMicroCompactor microCompactor;
    @Mock
    private ModelContextSnapshotRepository snapshots;
    @Mock
    private TaskLedgerService taskLedger;
    @Mock
    private ArtifactService artifacts;
    @Mock
    private RunRoundRepository runs;
    @Mock
    private RunFinalizationPolicy finalizationPolicy;
    @Mock
    private AgentRunContextRepository runContexts;
    @Mock
    private RunMailboxRepository mailbox;
    @Mock
    private SkillRosterService skillRoster;

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final ModelTokenEstimator tokens = new ModelTokenEstimator(objectMapper);
    private final ModelContextWindowPlanner windows = new ModelContextWindowPlanner(tokens);
    private final ModelPromptPrefixService promptPrefixes =
            new ModelPromptPrefixService(objectMapper);
    private final CompactionSummaryContextFactory summaryContexts =
            new CompactionSummaryContextFactory(objectMapper, tokens, promptPrefixes);

    private ModelContextAssembler assembler() {
        return new ModelContextAssembler(
                facts,
                tools,
                availability,
                objectMapper,
                windows,
                microCompactor,
                snapshots,
                tokens,
                taskLedger,
                artifacts,
                runs,
                finalizationPolicy,
                promptPrefixes,
                runContexts,
                mailbox,
                skillRoster
        );
    }

    private void stubDependencies() {
        ToolManifest manifest = mock(ToolManifest.class);
        when(manifest.name()).thenReturn("read_file");
        when(manifest.description()).thenReturn("读取工作区内文件。");
        when(manifest.inputSchema()).thenReturn(
                objectMapper.createObjectNode().put("type", "object")
        );
        when(tools.find("read_file")).thenReturn(Optional.of(
                new ToolRegistry.ToolBinding(
                        manifest,
                        "/fs",
                        "/fs/read_file",
                        "a".repeat(64),
                        null
                )
        ));
        CapabilityAvailability available = new CapabilityAvailability(
                CapabilityAvailability.Status.AVAILABLE,
                null,
                Instant.parse("2026-08-28T00:00:00Z")
        );
        when(availability.requireExecutable(any())).thenReturn(available);
        when(runContexts.find(RUN_ID)).thenReturn(Optional.empty());
        when(mailbox.injectedBeforeOrAt(RUN_ID, 0)).thenReturn(List.of());
        when(artifacts.modelContextIndex(CONVERSATION_ID, BRANCH_ID, 8))
                .thenReturn(List.of());
        when(taskLedger.activeForContext(CONVERSATION_ID, BRANCH_ID))
                .thenReturn(List.of());
        when(finalizationPolicy.evaluate(RUN_ID))
                .thenReturn(new RunFinalizationPolicy.Decision(
                        false, null, 0, null
                ));
        when(runs.runBudget(RUN_ID))
                .thenReturn(new RunRoundRepository.RunBudget(
                        0, 50, 0, 300_000
                ));
        when(runs.recentToolActivity(RUN_ID, 8))
                .thenReturn(List.of());
        doAnswer(invocation -> new ToolObservationMicroCompactor.Projection(
                invocation.getArgument(2),
                0,
                0,
                0
        )).when(microCompactor).project(
                anyString(),
                anyString(),
                any(),
                any(),
                any(ContextBudget.class)
        );
        when(facts.requiredUserFactIdsBeforeRound(TURN_ID, ROUND_ID))
                .thenReturn(List.of(MESSAGE_ID));
        when(facts.currentTurnObservationIdsBeforeRound(TURN_ID, ROUND_ID))
                .thenReturn(List.of());
        when(microCompactor.pinnedObservationIds(any()))
                .thenReturn(Set.of());
    }

    @Test
    void summaryRequestReusesLastRoutedPrefixVerbatim() throws Exception {
        stubDependencies();
        ObjectNode toolArguments = objectMapper.createObjectNode()
                .put("path", "README.md");
        ObjectNode toolContent = objectMapper.createObjectNode()
                .put("result", "ok");
        when(facts.branchFactsBeforeRound(
                CONVERSATION_ID, BRANCH_ID, ROUND_ID
        )).thenReturn(List.of(
                new ModelInputItem.UserText(MESSAGE_ID, "hello"),
                new ModelInputItem.AssistantToolCall(
                        "attempt_1", "tc_1", "pc_1", "read_file", toolArguments
                ),
                new ModelInputItem.ToolResult(
                        "attempt_1", OBSERVATION_ID, "tc_1", "pc_1",
                        "exec_1", "success", "hash", "payloadHash",
                        toolContent
                )
        ));
        when(skillRoster.build()).thenReturn(
                new ModelInputItem.SkillDirectoryRoster("- /skills/personal/x")
        );

        ModelContext routed = assembler().assemble(run(), round(), seed());
        ArgumentCaptor<String> payloadCaptor =
                ArgumentCaptor.forClass(String.class);
        verify(snapshots).save(
                any(), anyString(), anyString(), anyString(), anyString(),
                payloadCaptor.capture(), any()
        );

        Optional<RoutedRequestPrefix> restored = RoutedRequestPrefix.restore(
                objectMapper,
                routed.contextHash(),
                payloadCaptor.getValue()
        );
        assertThat(restored).isPresent();
        RoutedRequestPrefix prefix = restored.get();
        assertThat(prefix.systemInstruction())
                .isEqualTo(routed.systemInstruction());
        assertThat(objectMapper.writeValueAsString(prefix.items()))
                .isEqualTo(objectMapper.writeValueAsString(routed.items()));
        assertThat(objectMapper.writeValueAsString(prefix.tools()))
                .isEqualTo(objectMapper.writeValueAsString(routed.tools()));
        assertThat(prefix.promptPrefix()).isEqualTo(routed.promptPrefix());
        assertThat(prefix.capabilityLeaseHash())
                .isEqualTo(routed.capabilityLeaseHash());
        assertThat(prefix.estimatedInputTokens())
                .isEqualTo(routed.estimatedInputTokens());

        CompactionSummaryContextFactory.SummaryContext built =
                summaryContexts.build(row(), Optional.of(prefix));
        ModelContext summary = built.context();
        assertThat(summary.systemInstruction())
                .isEqualTo(routed.systemInstruction());
        assertThat(objectMapper.writeValueAsString(summary.tools()))
                .isEqualTo(objectMapper.writeValueAsString(routed.tools()));
        assertThat(summary.promptPrefix()).isEqualTo(routed.promptPrefix());
        assertThat(summary.items())
                .hasSize(routed.items().size() + 1);
        for (int i = 0; i < routed.items().size(); i++) {
            assertThat(
                    objectMapper.writeValueAsString(summary.items().get(i))
            ).isEqualTo(
                    objectMapper.writeValueAsString(routed.items().get(i))
            );
        }
        ModelInputItem tail = summary.items().get(summary.items().size() - 1);
        assertThat(tail).isInstanceOf(ModelInputItem.UserText.class);
        ModelInputItem.UserText directive = (ModelInputItem.UserText) tail;
        assertThat(directive.messageId()).isEqualTo("compact_source_1");
        assertThat(directive.text())
                .contains(CompactionSummaryContextFactory.SYSTEM_INSTRUCTION)
                .contains("{\"facts\":[]}");
    }

    @Test
    void fallsBackToStandaloneShapeWithoutRoutedPrefix() {
        CompactionSummaryContextFactory.SummaryContext built =
                summaryContexts.build(row(), Optional.empty());

        assertThat(built.context().systemInstruction())
                .isEqualTo(CompactionSummaryContextFactory.SYSTEM_INSTRUCTION);
        assertThat(built.context().items()).hasSize(1);
        assertThat(built.context().items().getFirst())
                .isInstanceOf(ModelInputItem.UserText.class);
        assertThat(built.context().tools()).isEmpty();
    }

    @Test
    void fallsBackWhenReusedPrefixPlusSourceExceedsBudget() {
        RoutedRequestPrefix oversized = new RoutedRequestPrefix(
                "b".repeat(64),
                "agent instruction",
                List.of(new ModelInputItem.UserText(MESSAGE_ID, "hello")),
                List.of(),
                promptPrefixes.capture(
                        "iris.agent.adhoc", 1, "agent instruction", List.of()
                ),
                "c".repeat(64),
                CompactionSummaryContextFactory.MAX_INPUT_TOKENS
        );

        CompactionSummaryContextFactory.SummaryContext built =
                summaryContexts.build(row(), Optional.of(oversized));

        assertThat(built.context().systemInstruction())
                .isEqualTo(CompactionSummaryContextFactory.SYSTEM_INSTRUCTION);
        assertThat(built.context().items()).hasSize(1);
        assertThat(built.context().tools()).isEmpty();
    }

    @Test
    void restoreRejectsPayloadWithoutTypedItemEnvelopes() {
        String legacyPayload = """
                {
                  "systemInstruction": "agent instruction",
                  "items": [{"messageId": "m1", "text": "hello"}],
                  "tools": [],
                  "capabilityLeaseHash": "%s",
                  "estimatedInputTokens": 10,
                  "promptPrefix": null
                }
                """.formatted("c".repeat(64));

        assertThat(RoutedRequestPrefix.restore(
                objectMapper,
                "b".repeat(64),
                legacyPayload
        )).isEmpty();
    }

    private ModelContextAssembler.ContextSeed seed() {
        return new ModelContextAssembler.ContextSeed(
                "test instruction",
                List.of("read_file")
        );
    }

    private CompactionRow row() {
        return new CompactionRow(
                "run_compact",
                CONVERSATION_ID,
                BRANCH_ID,
                "accepted",
                "auto",
                "frame_parent",
                1,
                10,
                "turn_before",
                "compact_source_1",
                "d".repeat(64),
                "{\"facts\":[]}",
                0,
                2,
                "round_compact",
                null,
                null,
                1,
                Instant.parse("2026-08-28T00:00:00Z"),
                null
        );
    }

    private RunRoundRepository.RunRow run() {
        return new RunRoundRepository.RunRow(
                RUN_ID,
                CONVERSATION_ID,
                BRANCH_ID,
                TURN_ID,
                null,
                null,
                "agentic",
                "test",
                RunPhase.RUNNING,
                1
        );
    }

    private RunRoundRepository.RoundRow round() {
        return new RunRoundRepository.RoundRow(
                ROUND_ID,
                RUN_ID,
                0,
                RoundPhase.ACCEPTED,
                0,
                1
        );
    }
}
