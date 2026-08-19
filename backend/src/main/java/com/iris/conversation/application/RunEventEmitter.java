package com.iris.conversation.application;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.ModelContext;
import com.iris.agent.run.ChildRunNodeProjectionService;
import com.iris.agent.run.RunRoundRepository;
import com.iris.agent.run.RunRoundRepository.RoundRow;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.conversation.application.ConversationEventAppender.EventDraft;
import com.iris.conversation.domain.ConversationViews.ContextUsageView;
import com.iris.conversation.domain.ConversationViews.RoundView;
import com.iris.conversation.domain.ConversationViews.RunView;
import com.iris.conversation.domain.ConversationViews.TurnView;
import com.iris.conversation.infrastructure.ConversationQueryRepository;
import org.springframework.stereotype.Service;

/**
 * Turn / Run / Round 生命周期事件的唯一发射口。
 * 状态迁移落库后调用这里，把完整安全 View 追加进事件流（docs/08 §10.3）。
 */
@Service
public class RunEventEmitter {
    private final ConversationQueryRepository views;
    private final ConversationEventAppender events;
    private final RunRoundRepository facts;
    private final ObjectMapper objectMapper;
    private final ChildRunNodeProjectionService childRunNodes;

    public RunEventEmitter(
            ConversationQueryRepository views,
            ConversationEventAppender events,
            RunRoundRepository facts,
            ObjectMapper objectMapper,
            ChildRunNodeProjectionService childRunNodes
    ) {
        this.views = views;
        this.events = events;
        this.facts = facts;
        this.objectMapper = objectMapper;
        this.childRunNodes = childRunNodes;
    }

    public void roundStarted(String roundId) {
        emitRound("round.started", roundId);
    }

    public void roundUpdated(String roundId) {
        emitRound("round.updated", roundId);
    }

    public void runUpdated(String runId) {
        emitRun("run.updated", runId);
    }

    public void runStarted(String runId) {
        emitRun("run.started", runId);
    }

    public void runSettled(String runId) {
        emitRun("run.settled", runId);
    }

    public void turnUpdated(String turnId) {
        TurnView turn = views.turnView(turnId);
        RunRow run = facts.findRun(turn.rootRunId()).orElseThrow(
                () -> new IllegalStateException("找不到 Turn 的 root Run")
        );
        events.append(new EventDraft(
                "turn.updated",
                run.conversationId(),
                turn.branchId(),
                turn.turnId(),
                turn.rootRunId(),
                "turn",
                turn.turnId(),
                turn.version(),
                turn.rootRunId(),
                turn.rootRunId(),
                payload("turn", objectMapper.valueToTree(turn))
        ));
    }

    public void contextUsageUpdated(ModelContext context, RunRow run) {
        int used = context.estimatedInputTokens();
        int limit = context.maxInputTokens();
        int percent = limit > 0
                ? Math.max(
                        1,
                        Math.min(
                                100,
                                (int) Math.round((double) used / limit * 100)
                        )
                )
                : 0;
        ContextUsageView usage = new ContextUsageView(used, limit, percent);
        ObjectNode payload = objectMapper.createObjectNode();
        payload.set("contextUsage", objectMapper.valueToTree(usage));
        events.append(new EventDraft(
                "context.usage",
                run.conversationId(),
                run.branchId(),
                run.turnId(),
                run.runId(),
                run.parentRunId(),
                "context",
                run.runId(),
                run.version(),
                run.runId(),
                run.runId(),
                payload
        ));
    }

    private void emitRound(String eventType, String roundId) {
        RoundView round = views.roundView(roundId);
        RunRow run = facts.findRun(round.runId()).orElseThrow(
                () -> new IllegalStateException("找不到 Round 所属 Run")
        );
        events.append(new EventDraft(
                eventType,
                run.conversationId(),
                run.branchId(),
                run.turnId(),
                run.runId(),
                "round",
                round.roundId(),
                round.version(),
                run.runId(),
                run.runId(),
                payload("round", objectMapper.valueToTree(round))
        ));
    }

    private void emitRun(String eventType, String runId) {
        RunView run = views.runView(runId);
        RunRow fact = facts.findRun(runId).orElseThrow(
                () -> new IllegalStateException("找不到 Run")
        );
        events.append(new EventDraft(
                eventType,
                fact.conversationId(),
                fact.branchId(),
                run.turnId(),
                run.runId(),
                fact.parentRunId(),
                "run",
                run.runId(),
                run.version(),
                run.runId(),
                run.runId(),
                payload("run", objectMapper.valueToTree(run))
        ));
        childRunNodes.updateForRun(runId);
    }

    private ObjectNode payload(String field, JsonNode view) {
        ObjectNode payload = objectMapper.createObjectNode();
        payload.set(field, view);
        return payload;
    }
}
