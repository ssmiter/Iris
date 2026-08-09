package com.iris.agent.pipeline;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.run.AgentRunResultRepository;
import com.iris.agent.run.RunMailboxEventEmitter;
import com.iris.agent.run.RunMailboxRepository;
import com.iris.agent.run.RunPhase;
import com.iris.agent.run.RunTerminalEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.util.List;

/** Publishes one durable handoff for a whole Pipeline, never for its internals. */
@Service
public class PipelineCompletionService {
    private static final int MAX_HANDOFF_CHARS = 12_000;
    private final PipelineRunRepository pipelines;
    private final AgentRunResultRepository results;
    private final RunMailboxRepository mailbox;
    private final RunMailboxEventEmitter mailboxEvents;
    private final TransactionTemplate transactions;
    private final ObjectMapper objectMapper;
    private final Clock clock = Clock.systemUTC();

    public PipelineCompletionService(
            PipelineRunRepository pipelines,
            AgentRunResultRepository results,
            RunMailboxRepository mailbox,
            RunMailboxEventEmitter mailboxEvents,
            TransactionTemplate transactions,
            ObjectMapper objectMapper
    ) {
        this.pipelines = pipelines;
        this.results = results;
        this.mailbox = mailbox;
        this.mailboxEvents = mailboxEvents;
        this.transactions = transactions;
        this.objectMapper = objectMapper;
    }

    @EventListener
    public void onTerminal(RunTerminalEvent event) {
        PipelineRunRepository.PipelineRun run = pipelines.find(event.runId())
                .orElse(null);
        if (run == null) {
            return;
        }
        List<PipelineRunRepository.StepRun> steps = pipelines.steps(run.runId());
        JsonNode output = steps.isEmpty()
                ? null : steps.get(steps.size() - 1).output();
        String summary = summary(event.phase(), output);
        RunMailboxRepository.MailboxMessage[] queued =
                new RunMailboxRepository.MailboxMessage[1];
        transactions.executeWithoutResult(status -> {
            results.save(
                    run.runId(),
                    event.phase().name().toLowerCase(),
                    summary,
                    null,
                    List.of(),
                    clock.instant()
            );
            boolean notifyParent = run.deliveryPolicy()
                    == PipelineDefinition.DeliveryPolicy.NOTIFY_PARENT;
            if (!notifyParent) {
                return;
            }
            if (run.parentRunId() == null || run.parentRunId().isBlank()) {
                return;
            }
            ObjectNode payload = objectMapper.createObjectNode();
            payload.put("pipelineRunId", run.runId());
            payload.put("definitionId", run.definitionId());
            payload.put("phase", event.phase().name().toLowerCase());
            if (output != null) {
                payload.set("output", output);
            }
            queued[0] = mailbox.enqueueTerminal(
                    run.parentRunId(),
                    run.runId(),
                    event.phase() == RunPhase.CANCELLED
                            ? "cancellation" : "completion",
                    completionContent(run.runId(), output, summary),
                    payload,
                    clock.instant()
            );
        });
        if (queued[0] != null) {
            mailboxEvents.queued(queued[0]);
        }
    }

    private String completionContent(
            String pipelineRunId,
            JsonNode output,
            String summary
    ) {
        StringBuilder content = new StringBuilder()
                .append("pipelineRunId: ").append(pipelineRunId);
        if (output != null && output.path("runId").isTextual()) {
            content.append("\nresultRunId: ")
                    .append(output.path("runId").asText());
        }
        return content.append('\n').append(summary).toString();
    }

    private String summary(RunPhase phase, JsonNode output) {
        if (output != null && output.path("summary").isTextual()) {
            String value = output.path("summary").asText().trim();
            if (!value.isBlank()) {
                return value.length() <= MAX_HANDOFF_CHARS
                        ? value
                        : value.substring(0, MAX_HANDOFF_CHARS)
                                + "\n\n[结果较长，完整正文保留在 Pipeline Run 中]";
            }
        }
        return phase == RunPhase.SUCCEEDED
                ? "Pipeline 已完成，结构化结果可通过运行记录读取。"
                : "Pipeline 未完整完成；已执行步骤和失败事实均已保留。";
    }
}
