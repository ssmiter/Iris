package com.iris.agent.run;

import com.iris.agent.model.provider.IrisModelProperties;
import com.iris.agent.model.provider.ModelProviderRegistry;
import com.iris.agent.model.AutoCompactionService;
import com.iris.workspace.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Service;
import org.springframework.context.ApplicationEventPublisher;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Process-local wakeup only. Durable Run/Round facts remain scheduler truth.
 * Child Agentic Runs are accepted durably and started only while the per-root
 * active quota allows; excess children stay queued and are started in creation
 * order as earlier children reach a terminal phase.
 */
@Service
@Order(40)
public class AgentRunLauncher implements ApplicationRunner {
    private static final Logger log =
            LoggerFactory.getLogger(AgentRunLauncher.class);

    private final AgenticRunCoordinator runs;
    private final RunRoundRepository facts;
    private final ModelProviderRegistry providers;
    private final IrisModelProperties model;
    private final WorkspaceService workspace;
    private final RunCancellationRegistry cancellations;
    private final AutoCompactionService autoCompactions;
    private final ApplicationEventPublisher events;
    private final int maxActiveChildRuns;
    private final Clock clock = Clock.systemUTC();
    private final Set<String> active = ConcurrentHashMap.newKeySet();
    private final ConcurrentHashMap<String, Object> rootLocks =
            new ConcurrentHashMap<>();

    public AgentRunLauncher(
            AgenticRunCoordinator runs,
            RunRoundRepository facts,
            ModelProviderRegistry providers,
            IrisModelProperties model,
            WorkspaceService workspace,
            RunCancellationRegistry cancellations,
            AutoCompactionService autoCompactions,
            ApplicationEventPublisher events,
            @Value("${iris.agent.max-active-child-runs:3}")
            int maxActiveChildRuns
    ) {
        this.runs = runs;
        this.facts = facts;
        this.providers = providers;
        this.model = model;
        this.workspace = workspace;
        this.cancellations = cancellations;
        this.autoCompactions = autoCompactions;
        this.events = events;
        if (maxActiveChildRuns < 1 || maxActiveChildRuns > 16) {
            throw new IllegalArgumentException(
                    "iris.agent.max-active-child-runs must be between 1 and 16"
            );
        }
        this.maxActiveChildRuns = maxActiveChildRuns;
    }

    public boolean launch(String runId) {
        RunRoundRepository.RunRow run = facts.findRun(runId).orElse(null);
        if (run == null) {
            return false;
        }
        if (run.parentRunId() == null) {
            return start(run, false, false);
        }
        if (run.phase() == RunPhase.ACCEPTED) {
            Object lock = rootLocks.computeIfAbsent(run.rootRunId(), k -> new Object());
            synchronized (lock) {
                int activeCount = facts.countActiveChildRunsByRoot(run.rootRunId());
                if (activeCount >= maxActiveChildRuns) {
                    log.debug(
                            "Child Run {} queued for root {} ({} active >= {})",
                            runId,
                            run.rootRunId(),
                            activeCount,
                            maxActiveChildRuns
                    );
                    return false;
                }
                RunRoundRepository.RunRow current = facts.findRun(runId)
                        .orElse(null);
                if (current == null || current.phase() != RunPhase.ACCEPTED) {
                    return false;
                }
                if (!facts.transitionRun(
                        runId,
                        RunPhase.ACCEPTED,
                        RunPhase.RUNNING,
                        current.version(),
                        clock.instant()
                )) {
                    return false;
                }
                RunRoundRepository.RunRow transitioned = facts.findRun(runId)
                        .orElse(null);
                return start(
                        transitioned == null ? run : transitioned,
                        false,
                        false
                );
            }
        }
        return start(run, false, false);
    }

    public boolean resume(String runId) {
        RunRoundRepository.RunRow run = facts.findRun(runId).orElse(null);
        if (run == null || run.phase() != RunPhase.SUSPENDED) {
            return false;
        }
        return start(run, true, false);
    }

    public boolean requestStop(String runId) {
        RunRoundRepository.RunRow run = facts.findRun(runId).orElse(null);
        if (run == null || run.phase().terminal()) {
            cancellations.clear(runId);
            return false;
        }
        cancellations.signal(runId);
        if (active.contains(runId)) {
            return true;
        }
        if (run.phase() == RunPhase.ACCEPTED) {
            if (!facts.transitionRun(
                    runId,
                    RunPhase.ACCEPTED,
                    RunPhase.RUNNING,
                    run.version(),
                    clock.instant()
            )) {
                return false;
            }
            run = facts.findRun(runId).orElse(null);
            if (run == null) {
                return false;
            }
        }
        return start(run, false, true);
    }

    /**
     * Number of queued child Runs still ahead of the given Run in the same root.
     * Returns 0 if the Run is not currently queued.
     */
    public int queuedAhead(String runId) {
        RunRoundRepository.RunRow run = facts.findRun(runId).orElse(null);
        if (run == null
                || run.parentRunId() == null
                || run.phase() != RunPhase.ACCEPTED) {
            return 0;
        }
        return facts.findRunStartTime(runId)
                .map(startedAt -> facts.countQueuedAhead(
                        run.rootRunId(),
                        startedAt,
                        runId
                ))
                .orElse(0);
    }

    private boolean start(
            RunRoundRepository.RunRow run,
            boolean resume,
            boolean stopWakeup
    ) {
        if (!stopWakeup && !providers.configured(model.getProfile())) {
            runs.failForMissingProvider(run.runId())
                    .subscribe(
                            ignored -> {
                            },
                            error -> log.warn(
                                    "Agentic Run {} could not record its "
                                            + "missing-provider failure",
                                    run.runId(),
                                    error
                            )
                    );
            return false;
        }
        if (!active.add(run.runId())) {
            return false;
        }
        var advance = resume
                ? runs.resume(
                        run.runId(),
                        model.getProfile(),
                        workspace.root(),
                        stopWakeup
                )
                : runs.advance(
                        run.runId(),
                        model.getProfile(),
                        workspace.root(),
                        stopWakeup
                );
        AtomicReference<RunPhase> terminal = new AtomicReference<>();
        advance
                .onErrorResume(error -> {
                    log.warn(
                            "Agentic Run {} could not self-recover; "
                                    + "persisting a visible terminal failure",
                            run.runId(),
                            error
                    );
                    return runs.failUnexpected(run.runId(), error);
                })
                .doOnSuccess(result -> {
                    RunRoundRepository.RunRow completed = facts.findRun(run.runId())
                            .orElse(null);
                    if (completed != null && completed.root()) {
                        autoCompactions.consider(run.runId());
                    }
                    if (result != null && result.phase().terminal()) {
                        terminal.set(result.phase());
                        events.publishEvent(new RunTerminalEvent(
                                result.runId(),
                                result.phase()
                        ));
                    }
                })
                .doOnError(error -> log.error(
                        "Agentic Run {} failed before its terminal state "
                                + "could be persisted",
                        run.runId(),
                        error
                ))
                .doFinally(signal -> {
                    active.remove(run.runId());
                    if (terminal.get() != null) {
                        startQueuedChildren(run.rootRunId());
                    }
                })
                .subscribe(
                        ignored -> {
                        },
                        ignored -> {
                        }
                );
        return true;
    }

    private void startQueuedChildren(String rootRunId) {
        if (rootRunId == null) {
            return;
        }
        Object lock = rootLocks.computeIfAbsent(rootRunId, k -> new Object());
        synchronized (lock) {
            int activeCount = facts.countActiveChildRunsByRoot(rootRunId);
            int available = maxActiveChildRuns - activeCount;
            if (available <= 0) {
                return;
            }
            List<RunRoundRepository.RunRow> queued =
                    facts.findQueuedChildRunsByRoot(rootRunId, available);
            for (RunRoundRepository.RunRow queuedRun : queued) {
                RunRoundRepository.RunRow current = facts.findRun(
                        queuedRun.runId()
                ).orElse(null);
                if (current == null
                        || current.phase() != RunPhase.ACCEPTED) {
                    continue;
                }
                if (!facts.transitionRun(
                        current.runId(),
                        RunPhase.ACCEPTED,
                        RunPhase.RUNNING,
                        current.version(),
                        clock.instant()
                )) {
                    continue;
                }
                RunRoundRepository.RunRow transitioned = facts.findRun(
                        current.runId()
                ).orElse(null);
                start(
                        transitioned == null ? current : transitioned,
                        false,
                        false
                );
            }
        }
    }

    @Override
    public void run(ApplicationArguments args) {
        for (RunRoundRepository.RunRow run : facts.stopRequestedRuns()) {
            requestStop(run.runId());
        }
        if (!providers.configured(model.getProfile())) {
            log.info(
                    "No model provider profile is configured; ordinary accepted Runs remain durable but idle"
            );
            return;
        }
        for (RunRoundRepository.RunRow run : facts.resumableRuns()) {
            launch(run.runId());
        }
        for (RunRoundRepository.RunRow run
                : facts.recoverableSuspendedRuns()) {
            resume(run.runId());
        }
        for (RunRoundRepository.RunRow run : facts.findAllQueuedChildRuns()) {
            launch(run.runId());
        }
    }
}
