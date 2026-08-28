package com.iris.agent.model;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * The faithfully retained assembly product of the latest routed (root agentic)
 * model request on a branch. The compaction summary request rebuilds its
 * prefix from this record so the provider-side cache prefix stays identical;
 * cache reuse is best-effort and correctness never depends on it.
 */
public record RoutedRequestPrefix(
        String contextHash,
        String systemInstruction,
        List<ModelInputItem> items,
        List<ModelRequest.ToolDefinition> tools,
        ModelPromptPrefix promptPrefix,
        String capabilityLeaseHash,
        int estimatedInputTokens
) {
    public RoutedRequestPrefix {
        items = List.copyOf(items);
        tools = List.copyOf(tools);
    }

    /**
     * Rebuilds the routed request prefix from a retained context snapshot
     * payload. Returns empty when the payload predates typed item envelopes
     * or does not decode cleanly; callers then fall back to the standalone
     * summary request shape.
     */
    public static Optional<RoutedRequestPrefix> restore(
            ObjectMapper objectMapper,
            String contextHash,
            String payloadJson
    ) {
        try {
            JsonNode payload = objectMapper.readTree(payloadJson);
            JsonNode itemsNode = payload.get("items");
            JsonNode toolsNode = payload.get("tools");
            JsonNode systemNode = payload.get("systemInstruction");
            JsonNode leaseNode = payload.get("capabilityLeaseHash");
            JsonNode estimatedNode = payload.get("estimatedInputTokens");
            JsonNode prefixNode = payload.get("promptPrefix");
            if (itemsNode == null || !itemsNode.isArray()
                    || toolsNode == null || !toolsNode.isArray()
                    || systemNode == null || !systemNode.isTextual()
                    || leaseNode == null || !leaseNode.isTextual()
                    || estimatedNode == null || !estimatedNode.isInt()
                    || prefixNode == null) {
                return Optional.empty();
            }
            List<ModelInputItem> items = new ArrayList<>(itemsNode.size());
            for (JsonNode envelopeNode : itemsNode) {
                Optional<ModelInputItem> item =
                        ItemEnvelope.decode(objectMapper, envelopeNode);
                if (item.isEmpty()) {
                    return Optional.empty();
                }
                items.add(item.get());
            }
            List<ModelRequest.ToolDefinition> tools =
                    new ArrayList<>(toolsNode.size());
            for (JsonNode toolNode : toolsNode) {
                tools.add(objectMapper.treeToValue(
                        toolNode,
                        ModelRequest.ToolDefinition.class
                ));
            }
            ModelPromptPrefix promptPrefix = objectMapper.treeToValue(
                    prefixNode,
                    ModelPromptPrefix.class
            );
            if (promptPrefix == null) {
                return Optional.empty();
            }
            return Optional.of(new RoutedRequestPrefix(
                    contextHash,
                    systemNode.asText(),
                    items,
                    tools,
                    promptPrefix,
                    leaseNode.asText(),
                    estimatedNode.asInt()
            ));
        } catch (RuntimeException | com.fasterxml.jackson.core.JsonProcessingException exception) {
            return Optional.empty();
        }
    }

    /**
     * Type-tagged snapshot form of one {@link ModelInputItem}. The tag keeps
     * the retained assembly product faithfully decodable without guessing
     * record shapes from JSON fields.
     */
    public record ItemEnvelope(String kind, JsonNode item) {
        public static ItemEnvelope of(
                ObjectMapper objectMapper,
                ModelInputItem item
        ) {
            return new ItemEnvelope(
                    item.getClass().getSimpleName(),
                    objectMapper.valueToTree(item)
            );
        }

        public static Optional<ModelInputItem> decode(
                ObjectMapper objectMapper,
                JsonNode envelopeNode
        ) {
            if (envelopeNode == null || !envelopeNode.isObject()) {
                return Optional.empty();
            }
            JsonNode kindNode = envelopeNode.get("kind");
            JsonNode itemNode = envelopeNode.get("item");
            if (kindNode == null || !kindNode.isTextual() || itemNode == null) {
                return Optional.empty();
            }
            Class<? extends ModelInputItem> type = switch (kindNode.asText()) {
                case "HistorySummary" -> ModelInputItem.HistorySummary.class;
                case "UserText" -> ModelInputItem.UserText.class;
                case "TaskWorkState" -> ModelInputItem.TaskWorkState.class;
                case "ArtifactContextIndex" ->
                        ModelInputItem.ArtifactContextIndex.class;
                case "AgentRunState" -> ModelInputItem.AgentRunState.class;
                case "CapabilityRuntimeState" ->
                        ModelInputItem.CapabilityRuntimeState.class;
                case "RuntimePulse" -> ModelInputItem.RuntimePulse.class;
                case "AssistantProviderState" ->
                        ModelInputItem.AssistantProviderState.class;
                case "AssistantText" -> ModelInputItem.AssistantText.class;
                case "ContinuationDirective" ->
                        ModelInputItem.ContinuationDirective.class;
                case "FinalizationDirective" ->
                        ModelInputItem.FinalizationDirective.class;
                case "SkillDirectoryRoster" ->
                        ModelInputItem.SkillDirectoryRoster.class;
                case "AssistantToolCall" ->
                        ModelInputItem.AssistantToolCall.class;
                case "ToolResult" -> ModelInputItem.ToolResult.class;
                default -> null;
            };
            if (type == null) {
                return Optional.empty();
            }
            try {
                ModelInputItem decoded =
                        objectMapper.treeToValue(itemNode, type);
                return Optional.of(decoded);
            } catch (RuntimeException
                    | com.fasterxml.jackson.core.JsonProcessingException exception) {
                return Optional.empty();
            }
        }
    }
}
