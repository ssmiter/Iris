package com.iris.agent.pipeline;

import com.iris.agent.run.RunTerminalEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.event.EventListener;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Service;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/** Process-local Pipeline wakeups; Step facts remain scheduler truth. */
@Service
@Order(45)
public class PipelineRunLauncher implements ApplicationRunner {
    private static final Logger log = LoggerFactory.getLogger(
            PipelineRunLauncher.class
    );
    private final PipelineRunCoordinator coordinator;
    private final PipelineRunRepository runs;
    private final ApplicationEventPublisher events;
    private final Set<String> active = ConcurrentHashMap.newKeySet();

    public PipelineRunLauncher(
            PipelineRunCoordinator coordinator,
            PipelineRunRepository runs,
            ApplicationEventPublisher events
    ) {
        this.coordinator = coordinator;
        this.runs = runs;
        this.events = events;
    }

    public boolean launch(String runId) {
        if (!active.add(runId)) {
            return false;
        }
        coordinator.advance(runId)
                .doOnSuccess(result -> {
                    if (result.phase().terminal()) {
                        events.publishEvent(new RunTerminalEvent(
                                result.runId(),
                                result.phase()
                        ));
                    }
                })
                .doOnError(error -> log.error(
                        "Pipeline Run {} stopped unexpectedly",
                        runId,
                        error
                ))
                .doFinally(signal -> active.remove(runId))
                .subscribe(ignored -> { }, ignored -> { });
        return true;
    }

    @EventListener
    public void onChildTerminal(RunTerminalEvent event) {
        for (String parentRunId
                : runs.waitingPipelineParents(event.runId())) {
            launch(parentRunId);
        }
    }

    @Override
    public void run(ApplicationArguments args) {
        runs.resumableRunIds().forEach(this::launch);
    }
}
