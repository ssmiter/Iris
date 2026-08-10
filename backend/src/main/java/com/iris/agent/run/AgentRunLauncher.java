package com.iris.agent.run;

import com.iris.agent.model.provider.IrisModelProperties;
import com.iris.agent.model.provider.ModelProviderRegistry;
import com.iris.agent.model.AutoCompactionService;
import com.iris.workspace.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Service;
import org.springframework.context.ApplicationEventPublisher;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Process-local wakeup only. Durable Run/Round facts remain scheduler truth.
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
    private final Set<String> active = ConcurrentHashMap.newKeySet();

    public AgentRunLauncher(
            AgenticRunCoordinator runs,
            RunRoundRepository facts,
            ModelProviderRegistry providers,
            IrisModelProperties model,
            WorkspaceService workspace,
            RunCancellationRegistry cancellations,
            AutoCompactionService autoCompactions,
            ApplicationEventPublisher events
    ) {
        this.runs = runs;
        this.facts = facts;
        this.providers = providers;
        this.model = model;
        this.workspace = workspace;
        this.cancellations = cancellations;
        this.autoCompactions = autoCompactions;
        this.events = events;
    }

    public boolean launch(String runId) {
        return start(runId, false, false);
    }

    public boolean resume(String runId) {
        RunRoundRepository.RunRow run = facts.findRun(runId).orElse(null);
        if (run == null || run.phase() != RunPhase.SUSPENDED) {
            return false;
        }
        return start(runId, true, false);
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
        return start(runId, false, true);
    }

    private boolean start(
            String runId,
            boolean resume,
            boolean stopWakeup
    ) {
        if ((!stopWakeup && !providers.configured(model.getProfile()))
                || !active.add(runId)) {
            return false;
        }
        var advance = resume
                ? runs.resume(
                        runId,
                        model.getProfile(),
                        workspace.root(),
                        stopWakeup
                )
                : runs.advance(
                        runId,
                        model.getProfile(),
                        workspace.root(),
                        stopWakeup
                );
        advance
                .onErrorResume(error -> {
                    log.warn(
                            "Agentic Run {} could not self-recover; "
                                    + "persisting a visible terminal failure",
                            runId,
                            error
                    );
                    return runs.failUnexpected(runId, error);
                })
                .doOnSuccess(result -> {
                    RunRoundRepository.RunRow completed = facts.findRun(runId)
                            .orElse(null);
                    if (completed != null && completed.root()) {
                        autoCompactions.consider(runId);
                    }
                    if (result != null && result.phase().terminal()) {
                        events.publishEvent(new RunTerminalEvent(
                                result.runId(),
                                result.phase()
                        ));
                    }
                })
                .doOnError(error -> log.error(
                        "Agentic Run {} failed before its terminal state "
                                + "could be persisted",
                        runId,
                        error
                ))
                .doFinally(signal -> active.remove(runId))
                .subscribe(
                        ignored -> {
                        },
                        ignored -> {
                        }
                );
        return true;
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
    }
}
