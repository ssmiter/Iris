package com.iris.task;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.run.RunRoundRepository;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.conversation.application.ConversationEventAppender;
import com.iris.conversation.application.ConversationEventAppender.EventDraft;
import org.springframework.stereotype.Service;

/**
 * Projects the complete safe task view into the conversation event stream.
 * The task tables remain canonical; SSE is only the timely projection path.
 */
@Service
public final class TaskEventEmitter {
    private final ConversationEventAppender events;
    private final RunRoundRepository runs;
    private final ObjectMapper objectMapper;

    public TaskEventEmitter(
            ConversationEventAppender events,
            RunRoundRepository runs,
            ObjectMapper objectMapper
    ) {
        this.events = events;
        this.runs = runs;
        this.objectMapper = objectMapper;
    }

    public void updated(
            TaskLedgerService.TaskSnapshot task,
            JsonNode taskView,
            String runId
    ) {
        RunRow run = runs.findRun(runId).orElseThrow(
                () -> new IllegalStateException("找不到任务状态所属 Run")
        );
        ObjectNode payload = objectMapper.createObjectNode();
        payload.set("task", taskView);
        events.append(new EventDraft(
                "task.updated",
                task.conversationId(),
                task.branchId(),
                run.turnId(),
                runId,
                run.parentRunId(),
                "task",
                task.taskId(),
                task.version(),
                runId,
                run.rootRunId(),
                payload
        ));
    }
}
