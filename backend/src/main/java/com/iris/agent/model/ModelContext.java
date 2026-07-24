package com.iris.agent.model;

import java.util.List;

public record ModelContext(
        String systemInstruction,
        List<ModelInputItem> items,
        List<ModelRequest.ToolDefinition> tools,
        String contextHash,
        String capabilityLeaseHash,
        int estimatedInputTokens,
        int maxInputTokens,
        int reservedOutputTokens,
        int droppedFactCount
) {
    public ModelContext {
        items = List.copyOf(items);
        tools = List.copyOf(tools);
    }
}
