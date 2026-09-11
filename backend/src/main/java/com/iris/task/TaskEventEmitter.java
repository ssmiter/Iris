package com.iris.task;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.conversation.application.ConversationEventAppender;
import com.iris.conversation.application.ConversationEventAppender.EventDraft;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * Projects the complete safe task view into the conversation event stream.
 * The task tables remain canonical; SSE is only the timely projection path.
 * Run 元数据来自客观层的 client_run 事实表（docs/46），不再依赖后端 Loop 的 run 投影。
 */
@Service
public final class TaskEventEmitter {
    private final ConversationEventAppender events;
    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;

    public TaskEventEmitter(
            ConversationEventAppender events,
            JdbcClient jdbc,
            ObjectMapper objectMapper
    ) {
        this.events = events;
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
    }

    public void updated(
            TaskLedgerService.TaskSnapshot task,
            JsonNode taskView,
            String runId
    ) {
        RunRef run = jdbc.sql("""
                SELECT turn_id, parent_run_id, root_run_id
                FROM client_run WHERE run_id = :runId
                """)
                .param("runId", runId)
                .query((rs, n) -> new RunRef(
                        rs.getString("turn_id"),
                        rs.getString("parent_run_id"),
                        rs.getString("root_run_id")
                ))
                .optional()
                .orElse(new RunRef(null, null, runId));
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

    private record RunRef(String turnId, String parentRunId, String rootRunId) { }
}
