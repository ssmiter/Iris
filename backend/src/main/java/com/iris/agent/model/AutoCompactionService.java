package com.iris.agent.model;

import com.iris.agent.run.RunPhase;
import com.iris.agent.run.RunRoundRepository;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.conversation.application.CompactionCommandService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/**
 * Starts low-frequency compaction only after an Agentic Run is fully settled.
 * Not being ready is normal and remains silent.
 */
@Service
public final class AutoCompactionService {
    private static final Logger LOGGER = LoggerFactory.getLogger(
            AutoCompactionService.class
    );
    private static final double TRIGGER_RATIO = 0.80;

    private final RunRoundRepository runs;
    private final ModelContextSnapshotRepository contexts;
    private final CompactionCommandService commands;
    private final CompactionLauncher launcher;

    public AutoCompactionService(
            RunRoundRepository runs,
            ModelContextSnapshotRepository contexts,
            CompactionCommandService commands,
            CompactionLauncher launcher
    ) {
        this.runs = runs;
        this.contexts = contexts;
        this.commands = commands;
        this.launcher = launcher;
    }

    public void consider(String completedRunId) {
        Mono.fromRunnable(() -> considerNow(completedRunId))
                .subscribeOn(Schedulers.boundedElastic())
                .subscribe(
                        ignored -> {
                        },
                        error -> LOGGER.warn(
                                "Automatic context maintenance skipped for {}",
                                completedRunId,
                                error
                        )
                );
    }

    /**
     * Requests a proactive compaction while the source Run is still active.
     * This reuses the same durable compaction primitive; if the branch is still
     * active (e.g. the current Turn has not closed) the planning step may refuse
     * and the request is silently dropped.
     */
    public void requestCompaction(String activeRunId) {
        Mono.fromRunnable(() -> requestCompactionNow(activeRunId))
                .subscribeOn(Schedulers.boundedElastic())
                .subscribe(
                        ignored -> {
                        },
                        error -> LOGGER.warn(
                                "Proactive compaction request skipped for {}",
                                activeRunId,
                                error
                        )
                );
    }

    private void requestCompactionNow(String activeRunId) {
        RunRow run = runs.findRun(activeRunId).orElse(null);
        if (run == null
                || !run.root()
                || !"agentic".equals(run.kind())) {
            return;
        }
        var pressure = contexts.latestPressure(activeRunId).orElse(null);
        if (pressure == null
                || (pressure.droppedFactCount() == 0
                    && pressure.inputRatio() < TRIGGER_RATIO)) {
            return;
        }
        commands.createAuto(run.conversationId(), run.branchId())
                .ifPresent(created -> launcher.launch(created.runId()));
    }

    private void considerNow(String completedRunId) {
        RunRow run = runs.findRun(completedRunId).orElse(null);
        if (run == null
                || run.phase() != RunPhase.SUCCEEDED
                || !"agentic".equals(run.kind())) {
            return;
        }
        var pressure = contexts.latestPressure(completedRunId).orElse(null);
        if (pressure == null
                || (pressure.droppedFactCount() == 0
                    && pressure.inputRatio() < TRIGGER_RATIO)) {
            return;
        }
        commands.createAuto(run.conversationId(), run.branchId())
                .ifPresent(created -> launcher.launch(created.runId()));
    }
}
