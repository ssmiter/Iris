package com.iris.conversation.application;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.CompactionRepository;
import com.iris.agent.model.CompactionService.CompactBoundary;
import com.iris.conversation.application.ConversationEventAppender.EventDraft;
import com.iris.conversation.domain.CompactionViews.CompactionView;
import org.springframework.stereotype.Service;

@Service
public final class CompactionEventEmitter {
    private final CompactionRepository compactions;
    private final ConversationEventAppender events;
    private final ObjectMapper objectMapper;

    public CompactionEventEmitter(
            CompactionRepository compactions,
            ConversationEventAppender events,
            ObjectMapper objectMapper
    ) {
        this.compactions = compactions;
        this.events = events;
        this.objectMapper = objectMapper;
    }

    public void completed(String runId, CompactBoundary boundary) {
        CompactionView view = compactions.view(runId).orElseThrow();
        ObjectNode boundaryView = objectMapper.createObjectNode();
        boundaryView.put("boundaryId", boundary.boundaryId());
        boundaryView.put("contextFrameId", boundary.frameId());
        boundaryView.put(
                "parentContextFrameId",
                boundary.parentFrameId()
        );
        boundaryView.put("branchId", view.branchId());
        boundaryView.put("beforeTurnId", boundary.beforeTurnId());
        boundaryView.put(
                "waterlineSequence",
                boundary.waterlineSequence()
        );
        boundaryView.put("inherited", false);
        boundaryView.put("trigger", boundary.trigger());
        boundaryView.put("coveredCount", boundary.coveredCount());
        boundaryView.put(
                "summaryArtifactRef",
                boundary.summaryArtifactRef()
        );
        boundaryView.put("summary", boundary.summary());
        boundaryView.put("version", 1);
        emit("compaction.completed", view, boundaryView);
    }

    public void failed(String runId) {
        compactions.view(runId).ifPresent(view ->
                emit("compaction.failed", view, null));
    }

    private void emit(
            String eventType,
            CompactionView view,
            ObjectNode boundary
    ) {
        ObjectNode payload = objectMapper.createObjectNode();
        payload.set("compaction", objectMapper.valueToTree(view));
        if (boundary == null) {
            payload.putNull("boundary");
        } else {
            payload.set("boundary", boundary);
        }
        events.append(new EventDraft(
                eventType,
                view.conversationId(),
                view.branchId(),
                view.beforeTurnId(),
                view.runId(),
                "compaction",
                view.runId(),
                view.version(),
                view.runId(),
                view.runId(),
                payload
        ));
    }
}
