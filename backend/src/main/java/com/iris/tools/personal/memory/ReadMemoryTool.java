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
public class ReadMemoryTool implements Tool {
    private final ObjectMapper objectMapper;
    private final PersonalMemoryService memories;
    private final ToolManifest manifest;

    public ReadMemoryTool(ObjectMapper objectMapper, PersonalMemoryService memories) {
        this.objectMapper = objectMapper;
        this.memories = memories;
        this.manifest = new ToolManifest(
                "iris.personal.memory.read", "1", "read_memory",
                "Read one exact versioned personal memory with its source and confidence after search has selected it.",
                inputSchema(), outputSchema(), RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE, 5, 25_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
                ToolManifest.EvidencePolicy.REQUIRED,
                ToolManifest.ContextRetention.PINNED,
                ToolManifest.ConcurrencySemantics.PARALLEL_SAFE,
                ToolManifest.CancellationSemantics.COOPERATIVE
        );
    }

    @Override public ToolManifest manifest() { return manifest; }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String memoryId = input.path("memory_id").asText().trim();
        if (memoryId.isBlank()) throw new IllegalArgumentException("memory_id is required");
        ObjectNode normalized = objectMapper.createObjectNode().put("memory_id", memoryId);
        return new PreparedOperation(normalized, "Read memory " + memoryId, List.of(), Instant.now().plusSeconds(30));
    }

    @Override
    public ToolOutcome execute(CommittedOperation operation, ToolContext context) {
        return ToolOutcome.succeeded(objectMapper.valueToTree(
                memories.require(operation.normalizedInput().path("memory_id").asText())
        ));
    }

    @Override
    public VerificationResult verify(ToolOutcome outcome, CommittedOperation operation, ToolContext context) {
        String id = operation.normalizedInput().path("memory_id").asText();
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence("memory_definition", id, "Read from the current versioned memory head")
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode().put("type", "object").put("additionalProperties", false);
        schema.putObject("properties").putObject("memory_id")
                .put("type", "string").put("description", "Exact memory_id returned by search_memories");
        schema.putArray("required").add("memory_id");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode().put("type", "object").put("additionalProperties", true);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("memoryId").put("type", "string").put("description", "Stable memory identity");
        properties.putObject("content").put("type", "string").put("description", "Exact current memory content");
        properties.putObject("sourceKind").put("type", "string").put("description", "How the memory entered Iris");
        properties.putObject("sourceRef").put("type", "string").put("description", "Optional provenance reference");
        properties.putObject("confidence").put("type", "number").put("description", "Stored confidence boundary from 0 to 1");
        return schema;
    }
}
