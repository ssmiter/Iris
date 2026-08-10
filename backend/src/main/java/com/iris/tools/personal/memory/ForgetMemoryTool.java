package com.iris.tools.personal.memory;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.memory.PersonalMemoryService;
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
public class ForgetMemoryTool implements Tool {
    private final ObjectMapper objectMapper;
    private final PersonalMemoryService memories;
    private final ToolManifest manifest;

    public ForgetMemoryTool(ObjectMapper objectMapper, PersonalMemoryService memories) {
        this.objectMapper = objectMapper;
        this.memories = memories;
        this.manifest = new ToolManifest(
                "iris.personal.memory.forget", "1", "forget_memory",
                "Disable one exact personal memory so it no longer participates in recall while preserving its version history.",
                inputSchema(), outputSchema(), RiskLevel.STANDARD,
                ToolManifest.SideEffect.INTERNAL_STATE, 10, 5_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
                ToolManifest.EvidencePolicy.REQUIRED,
                ToolManifest.ContextRetention.PINNED,
                ToolManifest.ConcurrencySemantics.SERIAL,
                ToolManifest.CancellationSemantics.COMMIT_BOUNDARY
        );
    }

    @Override public ToolManifest manifest() { return manifest; }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String id = input.path("memory_id").asText().trim();
        int version = input.path("expected_head_version").asInt(0);
        if (id.isBlank() || version < 1) throw new IllegalArgumentException("memory_id and expected_head_version are required");
        ObjectNode normalized = objectMapper.createObjectNode()
                .put("memory_id", id)
                .put("expected_head_version", version);
        return new PreparedOperation(
                normalized,
                "Stop using memory " + id + " in future recall; its audit history remains",
                List.of(), Instant.now().plusSeconds(60)
        );
    }

    @Override
    public ToolOutcome execute(CommittedOperation operation, ToolContext context) {
        JsonNode input = operation.normalizedInput();
        return ToolOutcome.succeeded(objectMapper.valueToTree(
                memories.setEnabled(input.path("memory_id").asText(), input.path("expected_head_version").asInt(), false)
        ));
    }

    @Override
    public VerificationResult verify(ToolOutcome outcome, CommittedOperation operation, ToolContext context) {
        String id = operation.normalizedInput().path("memory_id").asText();
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence("memory_head", id, "Memory head is marked forgotten and excluded from retrieval")
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode().put("type", "object").put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("memory_id").put("type", "string").put("description", "Exact memory identity from read_memory");
        properties.putObject("expected_head_version").put("type", "integer").put("description", "Current headVersion from read_memory, preventing stale changes");
        schema.putArray("required").add("memory_id").add("expected_head_version");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode().put("type", "object").put("additionalProperties", true);
        schema.putObject("properties").putObject("lifecycleStatus")
                .put("type", "string").put("description", "Resulting memory lifecycle status");
        return schema;
    }
}
