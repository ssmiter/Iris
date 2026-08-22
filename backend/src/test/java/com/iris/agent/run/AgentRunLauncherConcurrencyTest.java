package com.iris.agent.run;

import com.iris.agent.model.provider.ModelProfileCatalog;
import com.iris.agent.model.provider.ModelProviderRegistry;
import com.iris.agent.model.AutoCompactionService;
import com.iris.workspace.WorkspaceService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.ApplicationArguments;
import org.springframework.context.ApplicationEventPublisher;
import reactor.core.publisher.Sinks;

import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class AgentRunLauncherConcurrencyTest {

    private static final String ROOT = "root_1";
    private static final int MAX_ACTIVE = 3;

    private final StubFacts facts = new StubFacts();
    private final AgenticRunCoordinator coordinator = mock(
            AgenticRunCoordinator.class
    );
    private final ModelProviderRegistry providers = mock(
            ModelProviderRegistry.class
    );
    private final ModelProfileCatalog modelProfiles = mock(
            ModelProfileCatalog.class
    );
    private final WorkspaceService workspace = mock(WorkspaceService.class);
    private final RunCancellationRegistry cancellations = mock(
            RunCancellationRegistry.class
    );
    private final AutoCompactionService autoCompactions = mock(
            AutoCompactionService.class
    );
    private final ApplicationEventPublisher events = mock(
            ApplicationEventPublisher.class
    );
    private final Map<String, Sinks.One<AgenticRunCoordinator.RunAdvance>>
            advances = new ConcurrentHashMap<>();

    private AgentRunLauncher launcher;

    @BeforeEach
    void setUp() {
        when(providers.configured(anyString())).thenReturn(true);
        when(modelProfiles.activeProfile()).thenReturn("test");
        when(workspace.root()).thenReturn(Path.of("/tmp/iris"));
        when(coordinator.advance(anyString(), anyString(), any(), anyBoolean()))
                .thenAnswer(invocation -> advances
                        .computeIfAbsent(
                                invocation.getArgument(0),
                                k -> Sinks.one()
                        )
                        .asMono());
        when(coordinator.resume(anyString(), anyString(), any(), anyBoolean()))
                .thenAnswer(invocation -> advances
                        .computeIfAbsent(
                                invocation.getArgument(0),
                                k -> Sinks.one()
                        )
                        .asMono());
        launcher = new AgentRunLauncher(
                coordinator,
                facts,
                providers,
                modelProfiles,
                workspace,
                cancellations,
                autoCompactions,
                events,
                MAX_ACTIVE
        );
    }

    @Test
    void fourthChildRunIsQueued() {
        facts.put(root(ROOT));
        String child1 = childRun("child_1", ROOT, RunPhase.ACCEPTED);
        String child2 = childRun("child_2", ROOT, RunPhase.ACCEPTED);
        String child3 = childRun("child_3", ROOT, RunPhase.ACCEPTED);
        String child4 = childRun("child_4", ROOT, RunPhase.ACCEPTED);

        launcher.launch(child1);
        launcher.launch(child2);
        launcher.launch(child3);
        launcher.launch(child4);

        assertThat(facts.phaseOf(child1)).isEqualTo(RunPhase.RUNNING);
        assertThat(facts.phaseOf(child2)).isEqualTo(RunPhase.RUNNING);
        assertThat(facts.phaseOf(child3)).isEqualTo(RunPhase.RUNNING);
        assertThat(facts.phaseOf(child4)).isEqualTo(RunPhase.ACCEPTED);
        verify(coordinator, never()).advance(eq(child4), anyString(), any(), anyBoolean());
    }

    @Test
    void terminalChildRunStartsQueuedSibling() {
        facts.put(root(ROOT));
        String child1 = childRun("child_1", ROOT, RunPhase.ACCEPTED);
        String child2 = childRun("child_2", ROOT, RunPhase.ACCEPTED);
        String child3 = childRun("child_3", ROOT, RunPhase.ACCEPTED);
        String child4 = childRun("child_4", ROOT, RunPhase.ACCEPTED);

        launcher.launch(child1);
        launcher.launch(child2);
        launcher.launch(child3);
        launcher.launch(child4);

        assertThat(facts.phaseOf(child4)).isEqualTo(RunPhase.ACCEPTED);

        complete(child1, RunPhase.SUCCEEDED);

        assertThat(facts.phaseOf(child1)).isEqualTo(RunPhase.SUCCEEDED);
        assertThat(facts.phaseOf(child4)).isEqualTo(RunPhase.RUNNING);
    }

    @Test
    void recoveryRespectsQuotaAndStartsQueuedAfterTerminal() {
        facts.put(root(ROOT));
        String active1 = childRun("active_1", ROOT, RunPhase.RUNNING);
        String active2 = childRun("active_2", ROOT, RunPhase.RUNNING);
        String active3 = childRun("active_3", ROOT, RunPhase.RUNNING);
        String queued1 = childRun("queued_1", ROOT, RunPhase.ACCEPTED);
        String queued2 = childRun("queued_2", ROOT, RunPhase.ACCEPTED);

        // Simulate a fresh process: new launcher, empty active set.
        AgentRunLauncher recovered = new AgentRunLauncher(
                coordinator,
                facts,
                providers,
                modelProfiles,
                workspace,
                cancellations,
                autoCompactions,
                events,
                MAX_ACTIVE
        );
        recovered.run(mock(ApplicationArguments.class));

        assertThat(facts.phaseOf(active1)).isEqualTo(RunPhase.RUNNING);
        assertThat(facts.phaseOf(active2)).isEqualTo(RunPhase.RUNNING);
        assertThat(facts.phaseOf(active3)).isEqualTo(RunPhase.RUNNING);
        assertThat(facts.phaseOf(queued1)).isEqualTo(RunPhase.ACCEPTED);
        assertThat(facts.phaseOf(queued2)).isEqualTo(RunPhase.ACCEPTED);

        complete(active1, RunPhase.SUCCEEDED);

        assertThat(facts.phaseOf(queued1)).isEqualTo(RunPhase.RUNNING);
        assertThat(facts.phaseOf(queued2)).isEqualTo(RunPhase.ACCEPTED);
    }

    private void complete(String runId, RunPhase terminalPhase) {
        Sinks.One<AgenticRunCoordinator.RunAdvance> sink = advances.get(runId);
        if (sink == null) {
            throw new IllegalStateException("No sink for " + runId);
        }
        RunPhase currentPhase = facts.phaseOf(runId);
        if (currentPhase != RunPhase.RUNNING
                && currentPhase != RunPhase.SUSPENDED) {
            throw new IllegalStateException(
                    "Cannot complete Run " + runId + " from phase " + currentPhase
            );
        }
        facts.transitionRun(
                runId,
                currentPhase,
                terminalPhase,
                facts.versionOf(runId),
                Instant.now()
        );
        sink.tryEmitValue(new AgenticRunCoordinator.RunAdvance(
                runId,
                terminalPhase,
                null,
                false,
                null
        ));
    }

    private String childRun(String runId, String rootRunId, RunPhase phase) {
        Instant startedAt = Instant.now();
        facts.put(
                new RunRoundRepository.RunRow(
                        runId,
                        "conv",
                        "branch",
                        "turn",
                        ROOT,
                        rootRunId,
                        "agentic",
                        "task",
                        phase,
                        1L
                ),
                startedAt
        );
        return runId;
    }

    private RunRoundRepository.RunRow root(String runId) {
        return new RunRoundRepository.RunRow(
                runId,
                "conv",
                "branch",
                "turn",
                null,
                runId,
                "agentic",
                "root task",
                RunPhase.RUNNING,
                1L
        );
    }

    private static class StubFacts extends RunRoundRepository {
        private final Map<String, RunRow> runs = new ConcurrentHashMap<>();
        private final Map<String, Instant> startTimes = new ConcurrentHashMap<>();

        StubFacts() {
            super(null);
        }

        void put(RunRow run) {
            put(run, Instant.now());
        }

        void put(RunRow run, Instant startedAt) {
            runs.put(run.runId(), run);
            startTimes.put(run.runId(), startedAt);
        }

        RunPhase phaseOf(String runId) {
            return runs.get(runId).phase();
        }

        long versionOf(String runId) {
            return runs.get(runId).version();
        }

        @Override
        public Optional<RunRow> findRun(String runId) {
            return Optional.ofNullable(runs.get(runId));
        }

        @Override
        public Optional<Instant> findRunStartTime(String runId) {
            return Optional.ofNullable(startTimes.get(runId));
        }

        @Override
        public boolean transitionRun(
                String runId,
                RunPhase from,
                RunPhase to,
                long expectedVersion,
                Instant now
        ) {
            RunRow current = runs.get(runId);
            if (current == null
                    || current.phase() != from
                    || current.version() != expectedVersion) {
                return false;
            }
            runs.put(
                    runId,
                    new RunRow(
                            current.runId(),
                            current.conversationId(),
                            current.branchId(),
                            current.turnId(),
                            current.parentRunId(),
                            current.rootRunId(),
                            current.kind(),
                            current.purpose(),
                            to,
                            expectedVersion + 1
                    )
            );
            return true;
        }

        @Override
        public int countActiveChildRunsByRoot(String rootRunId) {
            return (int) runs.values().stream()
                    .filter(r -> rootRunId.equals(r.rootRunId()))
                    .filter(r -> r.parentRunId() != null)
                    .filter(r -> r.phase() == RunPhase.RUNNING
                            || r.phase() == RunPhase.SUSPENDED)
                    .count();
        }

        @Override
        public List<RunRow> findQueuedChildRunsByRoot(
                String rootRunId,
                int limit
        ) {
            return runs.values().stream()
                    .filter(r -> rootRunId.equals(r.rootRunId()))
                    .filter(r -> r.parentRunId() != null)
                    .filter(r -> r.phase() == RunPhase.ACCEPTED)
                    .sorted(Comparator
                            .comparing((RunRow r) -> startTimes.getOrDefault(
                                    r.runId(), Instant.EPOCH))
                            .thenComparing(RunRow::runId))
                    .limit(limit)
                    .toList();
        }

        @Override
        public List<RunRow> findAllQueuedChildRuns() {
            return runs.values().stream()
                    .filter(r -> r.parentRunId() != null)
                    .filter(r -> r.phase() == RunPhase.ACCEPTED)
                    .sorted(Comparator
                            .comparing((RunRow r) -> r.rootRunId())
                            .thenComparing((RunRow r) -> startTimes.getOrDefault(
                                    r.runId(), Instant.EPOCH))
                            .thenComparing(RunRow::runId))
                    .toList();
        }

        @Override
        public int countQueuedAhead(
                String rootRunId,
                Instant startedAt,
                String runId
        ) {
            return (int) runs.values().stream()
                    .filter(r -> rootRunId.equals(r.rootRunId()))
                    .filter(r -> r.parentRunId() != null)
                    .filter(r -> r.phase() == RunPhase.ACCEPTED)
                    .filter(r -> {
                        Instant otherStart = startTimes.getOrDefault(
                                r.runId(), Instant.EPOCH);
                        int cmp = otherStart.compareTo(startedAt);
                        return cmp < 0
                                || (cmp == 0 && r.runId().compareTo(runId) < 0);
                    })
                    .count();
        }

        @Override
        public List<RunRow> resumableRuns() {
            List<RunRow> result = new ArrayList<>();
            for (RunRow run : runs.values()) {
                if ("agentic".equals(run.kind())
                        && run.phase() == RunPhase.RUNNING) {
                    result.add(run);
                }
            }
            return result;
        }

        @Override
        public List<RunRow> recoverableSuspendedRuns() {
            return List.of();
        }

        @Override
        public List<RunRow> stopRequestedRuns() {
            return List.of();
        }
    }
}
