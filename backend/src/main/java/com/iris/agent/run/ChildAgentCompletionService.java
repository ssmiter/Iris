package com.iris.agent.run;

import org.springframework.context.event.EventListener;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.util.List;

/** Persists the bounded output consumed by the owning Pipeline step. */
@Service
@Order(35)
public class ChildAgentCompletionService {
    private static final int MAX_HANDOFF_CHARS = 12_000;
    private final AgentRunContextRepository contexts;
    private final AgentRunResultRepository results;
    private final RunFailureRepository failures;
    private final Clock clock = Clock.systemUTC();

    public ChildAgentCompletionService(
            AgentRunContextRepository contexts,
            AgentRunResultRepository results,
            RunFailureRepository failures
    ) {
        this.contexts = contexts;
        this.results = results;
        this.failures = failures;
    }

    @EventListener
    public void onTerminal(RunTerminalEvent event) {
        if (contexts.find(event.runId()).isEmpty()) {
            return;
        }
        String fullResult = results.latestAssistantText(event.runId());
        var failure = failures.find(event.runId()).orElse(null);
        if (failure != null) {
            String failureHandoff = "子 Agent 未完成。"
                    + "\nfailureCode: " + failure.code()
                    + "\n原因: " + failure.userMessage()
                    + "\n恢复建议: " + failure.recoveryAction();
            fullResult = fullResult.isBlank()
                    ? failureHandoff
                    : fullResult + "\n\n" + failureHandoff;
        } else if (fullResult.isBlank()) {
            fullResult = event.phase() == RunPhase.SUCCEEDED
                    ? "子 Agent 已结束，但没有产生可交付文本。"
                    : "子 Agent 在产生完整结果前结束。";
        }
        boolean truncated = fullResult.length() > MAX_HANDOFF_CHARS;
        String summary = truncated
                ? fullResult.substring(0, MAX_HANDOFF_CHARS)
                        + "\n\n[结果较长，完整正文保留在该 child Run 中]"
                : fullResult;
        List<String> evidenceRefs = results.evidenceRefsForRun(
                event.runId(),
                24
        );
        results.save(
                event.runId(),
                event.phase().name().toLowerCase(),
                summary,
                "agent-run:" + event.runId(),
                evidenceRefs,
                clock.instant()
        );
    }
}
