package com.iris.agent.model;

import com.fasterxml.jackson.databind.ObjectMapper;
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

import java.time.Instant;
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
class ModelContextAssemblerSkillRosterTest {

    private static final String CONVERSATION_ID = "conv_1";
    private static final String BRANCH_ID = "branch_1";
    private static final String TURN_ID = "turn_1";
    private static final String RUN_ID = "run_1";
    private static final String ROUND_ID = "round_1";
    private static final String MESSAGE_ID = "msg_1";

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
        when(facts.branchFactsBeforeRound(CONVERSATION_ID, BRANCH_ID, ROUND_ID))
                .thenReturn(List.of(new ModelInputItem.UserText(
                        MESSAGE_ID,
                        "hello"
                )));
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
    void includesSkillDirectoryRosterWhenSkillsExist() {
        stubDependencies();
        when(skillRoster.build()).thenReturn(
                new ModelInputItem.SkillDirectoryRoster("- /skills/personal/x")
        );

        ModelContext context = assembler().assemble(run(), round(), seed());

        assertThat(context.items())
                .hasAtLeastOneElementOfType(ModelInputItem.SkillDirectoryRoster.class);
        assertThat(context.items().stream()
                .filter(ModelInputItem.SkillDirectoryRoster.class::isInstance)
                .map(ModelInputItem.SkillDirectoryRoster.class::cast)
                .findFirst().orElseThrow().content()
        ).contains("/skills/personal/x");
    }

    @Test
    void omitsRosterBlockWhenNoSkills() {
        stubDependencies();
        when(skillRoster.build()).thenReturn(null);

        ModelContext context = assembler().assemble(run(), round(), seed());

        assertThat(context.items())
                .noneMatch(ModelInputItem.SkillDirectoryRoster.class::isInstance);
    }

    @Test
    void rosterContentChangeProducesNewContextHashButStablePrefix() {
        stubDependencies();
        when(skillRoster.build())
                .thenReturn(new ModelInputItem.SkillDirectoryRoster("v1"))
                .thenReturn(new ModelInputItem.SkillDirectoryRoster("v2"));

        ModelContext first = assembler().assemble(run(), round(), seed());
        ModelContext second = assembler().assemble(run(), round(), seed());

        assertThat(first.contextHash()).isNotEqualTo(second.contextHash());
        assertThat(first.promptPrefix().prefixHash())
                .isEqualTo(second.promptPrefix().prefixHash());
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
