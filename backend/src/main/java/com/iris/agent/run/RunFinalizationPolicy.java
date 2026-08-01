package com.iris.agent.run;

import com.iris.task.TaskLedgerService;
import com.iris.task.TaskLedgerService.FinalizationGap;
import org.springframework.stereotype.Service;

/**
 * A single bounded consistency nudge for task state explicitly touched by the
 * current Run. It does not infer user intent or judge open-ended output quality.
 */
@Service
public final class RunFinalizationPolicy {
    private final TaskLedgerService tasks;
    private final RunRoundRepository rounds;

    public RunFinalizationPolicy(
            TaskLedgerService tasks,
            RunRoundRepository rounds
    ) {
        this.tasks = tasks;
        this.rounds = rounds;
    }

    public Decision evaluate(String runId) {
        FinalizationGap gap = tasks.finalizationGap(runId).orElse(null);
        if (gap == null || rounds.finalAnswerRoundCount(runId) != 1) {
            return Decision.allowed();
        }
        String instruction = """
                The previous response attempted to finish while task %s is still active at state version %d (%d unfinished steps, %d blockers). Do not repeat that response. Continue the shortest verifiable path, or use update_task_ledger to record the truthful terminal or paused/blocked state before giving the user a final answer.
                """.formatted(
                gap.taskId(),
                gap.stateVersion(),
                gap.unfinishedStepCount(),
                gap.blockerCount()
        ).strip();
        return new Decision(
                true,
                gap.taskId(),
                gap.stateVersion(),
                instruction
        );
    }

    public record Decision(
            boolean continueRun,
            String taskId,
            int stateVersion,
            String instruction
    ) {
        private static Decision allowed() {
            return new Decision(false, null, 0, null);
        }
    }
}
