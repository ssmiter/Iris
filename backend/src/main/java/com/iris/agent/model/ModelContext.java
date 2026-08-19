package com.iris.agent.model;

import java.util.List;

public record ModelContext(
        String systemInstruction,
        List<ModelInputItem> items,
        List<ModelRequest.ToolDefinition> tools,
        ModelPromptPrefix promptPrefix,
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
        if (promptPrefix == null) {
            throw new IllegalArgumentException("promptPrefix is required");
        }
    }

    /**
     * Session-stable items that are byte-for-byte identical within a Run.
     * These are kept at the front of {@link #items()} for prefix-cache
     * friendliness and are never dropped by the window planner.
     */
    public List<ModelInputItem> staticItems() {
        return items.stream()
                .filter(item -> item.stability()
                        == ModelInputItem.Stability.STATIC)
                .toList();
    }

    /**
     * Round-varying items. These are subject to the window planner's
     * explicit drop-priority table when the context budget is tight.
     */
    public List<ModelInputItem> dynamicItems() {
        return items.stream()
                .filter(item -> item.stability()
                        == ModelInputItem.Stability.DYNAMIC)
                .toList();
    }
}
