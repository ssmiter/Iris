package com.iris.agent.run;

import com.iris.agent.model.provider.IrisModelProperties;
import com.iris.agent.model.provider.ModelProviderRegistry;
import com.iris.workspace.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Service;

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
    private final Set<String> active = ConcurrentHashMap.newKeySet();

    public AgentRunLauncher(
            AgenticRunCoordinator runs,
            RunRoundRepository facts,
            ModelProviderRegistry providers,
            IrisModelProperties model,
            WorkspaceService workspace
    ) {
        this.runs = runs;
        this.facts = facts;
        this.providers = providers;
        this.model = model;
        this.workspace = workspace;
    }

    public boolean launch(String runId) {
        if (!providers.configured(model.getProfile())
                || !active.add(runId)) {
            return false;
        }
        runs.advance(
                        runId,
                        model.getProfile(),
                        workspace.root(),
                        false
                )
                .doOnError(error -> log.error(
                        "Agentic Run {} stopped unexpectedly",
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
        if (!providers.configured(model.getProfile())) {
            log.info(
                    "No model provider profile is configured; accepted Runs remain durable but idle"
            );
            return;
        }
        for (RunRoundRepository.RunRow run : facts.resumableRuns()) {
            launch(run.runId());
        }
    }
}
