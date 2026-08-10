package com.iris.tools.personal.memory;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.memory.PersonalMemoryService;
import com.iris.memory.PersonalMemoryService.MemoryDraft;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.VerificationResult;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

@Component
public class RememberMemoryTool implements Tool {
    private final ObjectMapper objectMapper;
    private final PersonalMemoryService memories;
    private final ToolManifest manifest;

    public RememberMemoryTool(ObjectMapper objectMapper, PersonalMemoryService memories) {
        this.objectMapper = objectMapper;
        this.memories = memories;
        this.manifest = new ToolManifest(
                "iris.personal.memory.remember", "1", "remember_memory",
                "Persist a user preference or stable fact for future conversations; only use when the user clearly asks Iris to remember it.",
                inputSchema(), outputSchema(), RiskLevel.STANDARD,
                ToolManifest.SideEffect.INTERNAL_STATE, 10, 5_000,
                ToolManifest.IdempotencySemantics.NON_IDEMPOTENT,
                ToolManifest.EvidencePolicy.REQUIRED,
                ToolManifest.ContextRetention.PINNED,
                ToolManifest.ConcurrencySemantics.SERIAL,
                ToolManifest.CancellationSemantics.COMMIT_BOUNDARY
        );
    }

    @Override public ToolManifest manifest() { return manifest; }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String title = input.path("title").asText().trim();
        String content = input.path("content").asText().trim();
        if (title.isBlank() || content.isBlank()) {
            throw new IllegalArgumentException("title and content are required");
        }
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("title", title);
        normalized.put("content", content);
        normalized.put("scope", input.path("scope").asText("personal").trim());
        normalized.put("confidence", Math.max(0D, Math.min(1D, input.path("confidence").asDouble(1D))));
        return new PreparedOperation(
                normalized,
                "Remember “" + title + "” for future conversations; this changes Iris personal state",
                List.of(), Instant.now().plusSeconds(60)
        );
    }

    @Override
    public ToolOutcome execute(CommittedOperation operation, ToolContext context) {
        JsonNode input = operation.normalizedInput();
        var memory = memories.create(new MemoryDraft(
                input.path("title").asText(), input.path("content").asText(),
                input.path("scope").asText(), "agent_observation",
                "conversation://" + context.conversationId() + "/turn/" + context.turnId(),
                input.path("confidence").asDouble(), true
        ));
        return ToolOutcome.succeeded(objectMapper.valueToTree(memory));
    }

    @Override
    public VerificationResult verify(ToolOutcome outcome, CommittedOperation operation, ToolContext context) {
        String id = outcome.output().path("memoryId").asText();
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence("memory_definition", id, "Memory was persisted with conversation provenance")
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode().put("type", "object").put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("title").put("type", "string").put("description", "Short factual label for later retrieval");
        properties.putObject("content").put("type", "string").put("description", "The stable fact or preference, without speculative additions");
        properties.putObject("scope").put("type", "string").put("description", "Memory scope; defaults to personal");
        properties.putObject("confidence").put("type", "number").put("minimum", 0).put("maximum", 1).put("description", "Confidence justified by the current conversation; defaults to 1");
        schema.putArray("required").add("title").add("content");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode().put("type", "object").put("additionalProperties", true);
        schema.putObject("properties").putObject("memoryId")
                .put("type", "string").put("description", "Stable identity of the persisted memory");
        return schema;
    }
}
