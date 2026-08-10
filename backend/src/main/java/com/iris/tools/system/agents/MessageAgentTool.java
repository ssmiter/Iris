package com.iris.tools.system.agents;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.run.AgentRunContextRepository;
import com.iris.agent.run.AgentRunLauncher;
import com.iris.agent.run.RunMailboxRepository;
import com.iris.agent.run.RunRoundRepository;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.VerificationResult;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Instant;
import java.util.List;

/** Queues a message for an isolated Agent at its next Round boundary. */
@Component
public class MessageAgentTool implements Tool {
    private final ObjectMapper objectMapper;
    private final AgentRunContextRepository contexts;
    private final RunRoundRepository runs;
    private final RunMailboxRepository mailbox;
    private final ObjectProvider<AgentRunLauncher> launcher;
    private final com.iris.agent.run.RunMailboxEventEmitter mailboxEvents;
    private final ToolManifest manifest;
    private final Clock clock = Clock.systemUTC();

    public MessageAgentTool(
            ObjectMapper objectMapper,
            AgentRunContextRepository contexts,
            RunRoundRepository runs,
            RunMailboxRepository mailbox,
            ObjectProvider<AgentRunLauncher> launcher,
            com.iris.agent.run.RunMailboxEventEmitter mailboxEvents
    ) {
        this.objectMapper = objectMapper;
        this.contexts = contexts;
        this.runs = runs;
        this.mailbox = mailbox;
        this.launcher = launcher;
        this.mailboxEvents = mailboxEvents;
        this.manifest = new ToolManifest(
                "iris.system.agents.message",
                "1",
                "message_agent",
                "向仍在运行或排队的隔离子 Agent 补充一条事实或约束；消息持久化后在它的下一 Round 边界进入上下文，不打断正在生成的模型请求",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.INTERNAL_STATE,
                5,
                2_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT_WITH_KEY,
                ToolManifest.EvidencePolicy.REQUIRED
        );
    }

    @Override
    public ToolManifest manifest() { return manifest; }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String runId = input.path("run_id").asText("").trim();
        String text = input.path("text").asText("").trim();
        if (runId.isBlank() || text.isBlank() || text.length() > 8_000) {
            throw new IllegalArgumentException(
                    "run_id and 1 to 8000 characters of text are required"
            );
        }
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("run_id", runId);
        normalized.put("text", text);
        return new PreparedOperation(
                normalized,
                "向子 Agent " + runId + " 的持久 mailbox 添加一条消息",
                List.of(new PreparedOperation.ResourceClaim(
                        "run_mailbox", runId, null
                )),
                Instant.now().plusSeconds(30)
        );
    }

    @Override
    public ToolOutcome execute(CommittedOperation operation, ToolContext context) {
        String runId = operation.normalizedInput().path("run_id").asText();
        var run = runs.findRun(runId).orElse(null);
        if (run == null || contexts.find(runId).isEmpty()) {
            return ToolOutcome.failed(
                    "child_agent_not_found",
                    "找不到这个隔离子 Agent Run"
            );
        }
        if (run.phase().terminal()) {
            return ToolOutcome.failed(
                    "child_agent_already_terminal",
                    "子 Agent 已经结束，消息没有入队"
            );
        }
        var message = mailbox.enqueue(
                runId,
                context.runId(),
                "instruction",
                operation.normalizedInput().path("text").asText(),
                objectMapper.createObjectNode(),
                clock.instant()
        );
        mailboxEvents.queued(message);
        launcher.getObject().launch(runId);
        ObjectNode output = objectMapper.createObjectNode();
        output.put("messageId", message.messageId());
        output.put("runId", runId);
        output.put("phase", "queued");
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        String messageId = outcome.output().path("messageId").asText("");
        if (messageId.isBlank() || mailbox.find(messageId).isEmpty()) {
            return new VerificationResult(
                    VerificationResult.Status.FAILED,
                    List.of(),
                    "消息没有进入 durable mailbox"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "run_mailbox_message",
                        messageId,
                        "消息将在目标 Run 的下一 Round 边界注入"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("run_id")
                .put("type", "string")
                .put("description", "delegate_task 返回的 child Agentic Run id");
        properties.putObject("text")
                .put("type", "string")
                .put("description", "新增事实、约束或纠正；不要重复原任务")
                .put("minLength", 1)
                .put("maxLength", 8_000);
        schema.putArray("required").add("run_id").add("text");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", true);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("messageId").put("type", "string")
                .put("description", "持久 mailbox 消息 id");
        properties.putObject("runId").put("type", "string")
                .put("description", "目标 Run id");
        properties.putObject("phase").put("type", "string")
                .put("description", "消息投递阶段");
        return schema;
    }
}
