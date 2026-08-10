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
public class SearchMemoriesTool implements Tool {
    private final ObjectMapper objectMapper;
    private final PersonalMemoryService memories;
    private final ToolManifest manifest;

    public SearchMemoriesTool(
            ObjectMapper objectMapper,
            PersonalMemoryService memories
    ) {
        this.objectMapper = objectMapper;
        this.memories = memories;
        this.manifest = new ToolManifest(
                "iris.personal.memory.search",
                "1",
                "search_memories",
                "Search enabled personal memories with lexical and semantic fusion; use when an earlier preference or stable user fact may matter.",
                inputSchema(), outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                15, 12_000,
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
        String query = input.path("query").asText().trim();
        if (query.isBlank()) throw new IllegalArgumentException("query is required");
        int limit = Math.max(1, Math.min(10, input.path("limit").asInt(5)));
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("query", query);
        if (!input.path("scope").asText().isBlank()) {
            normalized.put("scope", input.path("scope").asText().trim());
        }
        normalized.put("limit", limit);
        return new PreparedOperation(
                normalized,
                "Search enabled personal memories without changing them",
                List.of(), Instant.now().plusSeconds(30)
        );
    }

    @Override
    public ToolOutcome execute(CommittedOperation operation, ToolContext context) {
        JsonNode input = operation.normalizedInput();
        var result = memories.search(
                input.path("query").asText(),
                input.path("scope").asText(null),
                input.path("limit").asInt()
        );
        return ToolOutcome.succeeded(objectMapper.valueToTree(result));
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "memory_search",
                        operation.normalizedInput().path("query").asText(),
                        "Candidates came from enabled versioned memories"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("query").put("type", "string")
                .put("description", "Natural-language fact or preference to recall");
        properties.putObject("scope").put("type", "string")
                .put("description", "Optional exact memory scope such as personal");
        properties.putObject("limit").put("type", "integer")
                .put("minimum", 1).put("maximum", 10)
                .put("description", "Maximum candidates; defaults to 5");
        schema.putArray("required").add("query");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", true);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("strategy").put("type", "string")
                .put("description", "Actual retrieval strategy used");
        properties.putObject("semanticModel").put("type", "string")
                .put("description", "Semantic encoder identity when available");
        properties.putObject("matches").put("type", "array")
                .put("description", "Ranked memory candidates with source and excerpts");
        return schema;
    }
}
