package com.iris.agent.run;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.conversation.application.ConversationEventAppender;
import org.springframework.stereotype.Service;

/** Safe SSE projection of durable mailbox lifecycle facts. */
@Service
public class RunMailboxEventEmitter {
    private final RunRoundRepository runs;
    private final ConversationEventAppender events;
    private final ObjectMapper objectMapper;

    public RunMailboxEventEmitter(
            RunRoundRepository runs,
            ConversationEventAppender events,
            ObjectMapper objectMapper
    ) {
        this.runs = runs;
        this.events = events;
        this.objectMapper = objectMapper;
    }

    public void queued(RunMailboxRepository.MailboxMessage message) {
        emit("run.message.queued", message, 1);
    }

    public void injected(RunMailboxRepository.MailboxMessage message) {
        emit("run.message.injected", message, 2);
    }

    private void emit(
            String eventType,
            RunMailboxRepository.MailboxMessage message,
            long version
    ) {
        var target = runs.findRun(message.targetRunId()).orElseThrow();
        ObjectNode payload = objectMapper.createObjectNode();
        ObjectNode view = payload.putObject("runMessage");
        view.put("messageId", message.messageId());
        view.put("targetRunId", message.targetRunId());
        if (message.sourceRunId() != null) {
            view.put("sourceRunId", message.sourceRunId());
        }
        view.put("kind", message.kind());
        view.put("phase", eventType.endsWith("injected")
                ? "injected" : message.phase());
        if (message.injectionRoundId() != null) {
            view.put("injectionRoundId", message.injectionRoundId());
        }
        events.append(new ConversationEventAppender.EventDraft(
                eventType,
                target.conversationId(),
                target.branchId(),
                target.turnId(),
                target.runId(),
                target.parentRunId(),
                "run_message",
                message.messageId(),
                version,
                message.sourceRunId(),
                target.rootRunId(),
                payload
        ));
    }
}
