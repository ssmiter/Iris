package com.iris.agent.model;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.ModelContextWindowPlanner.ContextBudget;
import com.iris.agent.run.AgentRunContextRepository;
import com.iris.agent.run.RoundPhase;
import com.iris.agent.run.RunFinalizationPolicy;
import com.iris.agent.run.RunMailboxRepository;
import com.iris.agent.run.RunPhase;
import com.iris.agent.run.RunRoundRepository;
import com.iris.artifact.ArtifactService;
import com.iris.task.TaskLedgerService;
import com.iris.tools.core.CapabilityAvailabilityService;
import com.iris.tools.core.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ModelContextAssemblerStabilityTest {

    private static final String CONVERSATION_ID = "conv_stability";
    private static final String BRANCH_ID = "branch_stability";
    private static final String TURN_ID = "turn_stability";
    private static final String RUN_ID = "run_stability";
    private static final String ROUND_ID = "round_stability";
    private static final String MESSAGE_ID = "msg_stability";
    private static final String OBSERVATION_ID = "obs_stability";

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
    void staticItemsPrecedeDynamicItems() throws Exception {
        stubDependencies();
        when(facts.branchFactsBeforeRound(
                CONVERSATION_ID, BRANCH_ID, ROUND_ID
        )).thenReturn(List.of(new ModelInputItem.UserText(
                MESSAGE_ID,
                "hello"
        )));
        when(skillRoster.build()).thenReturn(
                new ModelInputItem.SkillDirectoryRoster("- /skills/personal/x")
        );

        ModelContext context = assembler().assemble(run(), round(), seed());

        List<ModelInputItem> items = context.items();
        int firstStatic = indexOfFirst(items, ModelInputItem.SkillDirectoryRoster.class);
        int firstDynamic = indexOfFirst(items, ModelInputItem.UserText.class);
        assertThat(firstStatic).isGreaterThanOrEqualTo(0);
        assertThat(firstDynamic).isGreaterThanOrEqualTo(0);
        assertThat(firstStatic).isLessThan(firstDynamic);
        assertThat(context.staticItems()).hasSize(1);
        assertThat(context.dynamicItems()).isNotEmpty();
    }

    @Test
    void dynamicChangeKeepsStaticPartitionStableAndChangesContextHash()
            throws Exception {
        stubDependencies();
        when(skillRoster.build()).thenReturn(
                new ModelInputItem.SkillDirectoryRoster("- /skills/personal/x")
        );
        ObjectNode toolContent = objectMapper.createObjectNode()
                .put("result", "ok");
        ObjectNode toolArguments = objectMapper.createObjectNode()
                .put("arg", "value");
        ModelInputItem.AssistantToolCall toolCall =
                new ModelInputItem.AssistantToolCall(
                        "attempt_1",
                        "tc_1",
                        "pc_1",
                        "test_tool",
                        toolArguments
                );
        ModelInputItem.ToolResult extraObservation =
                new ModelInputItem.ToolResult(
                        "attempt_1",
                        OBSERVATION_ID,
                        "tc_1",
                        "pc_1",
                        "exec_1",
                        "success",
                        "hash",
                        "payloadHash",
                        toolContent
                );
        when(facts.branchFactsBeforeRound(
                CONVERSATION_ID, BRANCH_ID, ROUND_ID
        )).thenReturn(
                List.of(new ModelInputItem.UserText(MESSAGE_ID, "hello")),
                List.of(
                        new ModelInputItem.UserText(MESSAGE_ID, "hello"),
                        toolCall,
                        extraObservation
                )
        );

        ModelContext first = assembler().assemble(run(), round(), seed());
        ModelContext second = assembler().assemble(run(), round(), seed());

        String firstStatic = objectMapper.writeValueAsString(first.staticItems());
        String secondStatic = objectMapper.writeValueAsString(second.staticItems());
        assertThat(firstStatic).isEqualTo(secondStatic);
        assertThat(first.contextHash()).isNotEqualTo(second.contextHash());
        assertThat(second.dynamicItems()).hasSizeGreaterThan(
                first.dynamicItems().size()
        );
    }

    private int indexOfFirst(
            List<ModelInputItem> items,
            Class<? extends ModelInputItem> type
    ) {
        for (int i = 0; i < items.size(); i++) {
            if (type.isInstance(items.get(i))) {
                return i;
            }
        }
        return -1;
    }

    private ModelContextAssembler.ContextSeed seed() {
        return new ModelContextAssembler.ContextSeed(
                "test instruction",
                List.of()
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
