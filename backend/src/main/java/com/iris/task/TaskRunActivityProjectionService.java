package com.iris.task;

import com.iris.agent.run.RunTerminalEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Service;

/** Refreshes the derived Task activity after canonical Run results settle. */
@Service
@Order(40)
public final class TaskRunActivityProjectionService {
    private final TaskLedgerService tasks;

    public TaskRunActivityProjectionService(TaskLedgerService tasks) {
        this.tasks = tasks;
    }

    @EventListener
    public void onTerminal(RunTerminalEvent event) {
        tasks.publishRelatedRunChange(event.runId());
    }
}
