package com.iris.agent.pipeline;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.run.AgentRunResultRepository;
import com.iris.agent.run.RunPhase;
import com.iris.agent.run.RunRoundRepository;
import com.iris.agent.run.RunTerminalEvent;
import com.iris.conversation.application.GeneratedConversationTitleService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/** Starts the internal title Pipeline after a successful root conversation Run. */
@Service
public class ConversationTitleTrigger {
    private static final Logger log = LoggerFactory.getLogger(
            ConversationTitleTrigger.class
    );
    private static final String PIPELINE_ID =
            "iris.pipeline.conversation_title";
    private static final int MAX_SOURCE_CHARS = 10_000;

    private final RunRoundRepository runs;
    private final AgentRunResultRepository results;
    private final GeneratedConversationTitleService titles;
    private final PipelineCommandService commands;
    private final PipelineRunLauncher launcher;
    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;

    public ConversationTitleTrigger(
            RunRoundRepository runs,
            AgentRunResultRepository results,
            GeneratedConversationTitleService titles,
            PipelineCommandService commands,
            PipelineRunLauncher launcher,
            JdbcClient jdbc,
            ObjectMapper objectMapper
    ) {
        this.runs = runs;
        this.results = results;
        this.titles = titles;
        this.commands = commands;
        this.launcher = launcher;
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
    }

    @EventListener
    public void onTerminal(RunTerminalEvent event) {
        try {
            var run = runs.findRun(event.runId()).orElse(null);
            if (run == null || !run.root()
                    || event.phase() != RunPhase.SUCCEEDED
                    || !titles.needsGeneratedTitle(run.conversationId())) {
                return;
            }
            String source = sourceText(run.turnId(), run.runId());
            if (source.isBlank()) {
                return;
            }
            ObjectNode input = objectMapper.createObjectNode();
            input.put("text", source);
            var accepted = commands.createChild(
                    PIPELINE_ID,
                    input,
                    run.runId(),
                    "system_event",
                    "conversation-title",
                    "system"
            );
            launcher.launch(accepted.runId());
        } catch (RuntimeException failure) {
            log.warn(
                    "Conversation title Pipeline was not started for Run {}",
                    event.runId(),
                    failure
            );
        }
    }

    private String sourceText(String turnId, String runId) {
        String userText = jdbc.sql("""
                SELECT message.content
                FROM conversation_turn turn
                JOIN message ON message.message_id = turn.request_message_id
                WHERE turn.turn_id = :turnId
                """)
                .param("turnId", turnId)
                .query(String.class)
                .optional()
                .orElse("")
                .trim();
        String answer = results.latestAssistantText(runId);
        String source = "用户目标：\n" + userText
                + (answer.isBlank() ? "" : "\n\n回答摘要依据：\n" + answer);
        if (source.length() <= MAX_SOURCE_CHARS) {
            return source;
        }
        return source.substring(0, MAX_SOURCE_CHARS);
    }
}
