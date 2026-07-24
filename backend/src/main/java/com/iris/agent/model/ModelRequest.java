package com.iris.agent.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;
import java.util.Map;

/**
 * Immutable request handed to a configured provider adapter.
 */
public record ModelRequest(
        String attemptId,
        String conversationId,
        String runId,
        String roundId,
        String modelId,
        String systemInstruction,
        List<ModelInputItem> items,
        List<ToolDefinition> tools,
        Map<String, String> metadata
) {
    public ModelRequest {
        items = List.copyOf(items);
        tools = List.copyOf(tools);
        metadata = Map.copyOf(metadata);
    }

    public record ToolDefinition(
            String name,
            String description,
            JsonNode inputSchema,
            String manifestHash
    ) {
    }
}
